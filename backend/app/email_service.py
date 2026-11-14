"""Email OTP service (verification + password reset) using the Resend HTTP API.
Only SHA-256 HMACs of codes are stored. Codes are never logged or returned by the API."""
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from flask import current_app, request
from sqlalchemy.exc import IntegrityError

from . import db
from .errors import ApiError
from .models import EmailOtp

UTC = timezone.utc
RESEND_URL = "https://api.resend.com/emails"
OTP_TTL_SECONDS = 600        # 10 minutes
RESEND_COOLDOWN = 60         # seconds between codes for one account/purpose
MAX_ATTEMPTS = 5             # wrong guesses per issued code
BAD_CODE = "Invalid or expired code. Request a new one if needed."


class EmailError(Exception):
    pass


def _aware(d):
    return d if d.tzinfo else d.replace(tzinfo=UTC)


# ---------------------------------------------------------------- sending
def email_configured():
    c = current_app.config
    return bool(c.get("EMAIL_SENDER") or (c.get("RESEND_API_KEY") and c.get("EMAIL_FROM")))


def require_configured():
    if not email_configured():
        current_app.logger.error("Email requested but RESEND_API_KEY / EMAIL_FROM are not set")
        raise ApiError("Email service is not configured on the server.", 503)


def resend_send(to, subject, html, text):
    c = current_app.config
    payload = json.dumps({"from": c["EMAIL_FROM"], "to": [to], "subject": subject, "html": html, "text": text}).encode()
    req = urllib.request.Request(RESEND_URL, data=payload, method="POST", headers={
        "Authorization": "Bearer " + c["RESEND_API_KEY"], "Content-Type": "application/json",
        "User-Agent": "healthguard-lite/2.1"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status not in (200, 201):
                raise EmailError(f"Resend returned HTTP {r.status}")
    except urllib.error.HTTPError as e:
        try:
            detail = str(json.loads(e.read().decode() or "{}").get("message", ""))[:200]
        except Exception:
            detail = ""
        current_app.logger.error("Resend rejected the email (HTTP %s): %s", e.code, detail)   # e.g. unverified domain
        raise EmailError(f"Resend HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        current_app.logger.error("Could not reach Resend: %s", type(e).__name__)
        raise EmailError("Resend unreachable")


def send_email(to, subject, html, text):
    sender = current_app.config.get("EMAIL_SENDER") or resend_send
    sender(to, subject, html, text)


def build_message(purpose, code):
    if purpose == "verify":
        subject, intro = "Verify your HealthGuard Lite email", "Use this code to verify your email address:"
    else:
        subject, intro = "Reset your HealthGuard Lite password", "Use this code to reset your password:"
    tail = "It expires in 10 minutes. If you didn't request it, you can ignore this email."
    text = f"HealthGuard Lite\n\n{intro}\n\n{code}\n\n{tail}\n"
    html = (f'<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#0b2545">'
            f'<h2 style="color:#0e9f9a;margin:0 0 12px">HealthGuard Lite</h2><p>{intro}</p>'
            f'<p style="font-size:32px;letter-spacing:8px;font-weight:700;background:#effaf8;padding:16px;border-radius:12px;text-align:center">{code}</p>'
            f'<p style="color:#5b6f86;font-size:14px">{tail}</p></div>')
    return subject, html, text


# ---------------------------------------------------------------- codes
def hash_code(purpose, user_id, code):
    key = current_app.config["SECRET_KEY"].encode()
    return hmac.new(key, f"{purpose}:{user_id}:{code}".encode(), hashlib.sha256).hexdigest()


def active_otp(user, purpose):
    row = EmailOtp.query.filter_by(user_id=user.id, purpose=purpose).first()
    return row if row and _aware(row.expires_at) > datetime.now(UTC) else None


def send_otp(user, purpose):
    """Issue a fresh code (invalidating any previous one) and email it. Returns True if an email was sent.
    Within the 60 s cooldown nothing is issued or sent. On delivery failure the new code is discarded."""
    now = datetime.now(UTC)
    row = EmailOtp.query.filter_by(user_id=user.id, purpose=purpose).first()
    if row and (now - _aware(row.created_at)).total_seconds() < RESEND_COOLDOWN:
        return False
    code = f"{secrets.randbelow(10 ** 6):06d}"
    try:
        if row:
            db.session.delete(row)
            db.session.flush()
        db.session.add(EmailOtp(user_id=user.id, purpose=purpose, code_hash=hash_code(purpose, user.id, code),
                                expires_at=now + timedelta(seconds=OTP_TTL_SECONDS), created_at=now))
        db.session.commit()
    except IntegrityError:   # concurrent request issued one first
        db.session.rollback()
        return False
    subject, html, text = build_message(purpose, code)
    try:
        send_email(user.email, subject, html, text)
    except Exception:
        current_app.logger.error("OTP email delivery failed for user id %s (%s)", user.id, purpose)
        EmailOtp.query.filter_by(user_id=user.id, purpose=purpose).delete()
        db.session.commit()
        return False
    return True


def check_otp(user, purpose, code):
    """Raise ApiError unless `code` is the live code. On success the code row is deleted in the session
    (single use); the caller commits together with its own change. All failures look identical."""
    row = EmailOtp.query.filter_by(user_id=user.id, purpose=purpose).first() if user else None
    expected = row.code_hash if row else hash_code(purpose, 0, "000000")   # constant work for unknown accounts
    good = hmac.compare_digest(expected, hash_code(purpose, user.id if user else 0, code))
    if not row or _aware(row.expires_at) <= datetime.now(UTC) or row.attempts >= MAX_ATTEMPTS:
        if row:
            db.session.delete(row)
            db.session.commit()
        raise ApiError(BAD_CODE, 400)
    if not good:
        row.attempts += 1
        db.session.commit()
        raise ApiError(BAD_CODE, 400)
    db.session.delete(row)


# ---------------------------------------------------------------- abuse limits (in memory, per worker)
_hits = {}


def rate_limit(key, limit, window):
    now = time.time()
    lst = [t for t in _hits.get(key, []) if t > now - window]
    if len(lst) >= limit:
        _hits[key] = lst
        raise ApiError("Too many requests. Please try again later.", 429, {"Retry-After": str(window)})
    lst.append(now)
    _hits[key] = lst
    if len(_hits) > 10000:
        _hits.clear()


def limit_request(email=None):
    ip = request.remote_addr or "?"
    rate_limit("ip:" + ip, 30, 3600)
    if email:
        rate_limit("em:" + email, 5, 3600)
