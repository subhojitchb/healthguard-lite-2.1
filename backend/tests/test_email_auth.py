import http.server
import json
import logging
import threading
from datetime import datetime, timedelta, timezone

import pytest

from app import db, email_service, routes
from app.models import EmailOtp, User
from .conftest import OUTBOX, last_code, register

EMAIL = "newuser@example.com"
REG = {"full_name": "New User", "email": EMAIL, "password": "password123"}


def reg(client, **over):
    return client.post("/api/auth/register", json={**REG, **over})


def age_otp(email, purpose="verify", created=None, expires=None):
    u = User.query.filter_by(email=email).first()
    row = EmailOtp.query.filter_by(user_id=u.id, purpose=purpose).first()
    if created is not None:
        row.created_at = datetime.now(timezone.utc) - timedelta(seconds=created)
    if expires is not None:
        row.expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires)
    db.session.commit()


def post(client, path, **j):
    return client.post("/api/auth/" + path, json=j)


# ------------------------------------------------------------ registration & verification
def test_register_sends_code_and_issues_no_token(client):
    r = reg(client)
    d = r.get_json()["data"]
    assert r.status_code == 201 and d["verification_required"] is True and d["email_sent"] is True and "token" not in d
    assert len(OUTBOX) == 1 and OUTBOX[0]["to"] == EMAIL
    code = last_code(EMAIL)
    assert "10 minutes" in OUTBOX[0]["text"] and code in OUTBOX[0]["html"]
    assert code not in json.dumps(d)                                   # never in the API response
    row = EmailOtp.query.one()
    assert len(row.code_hash) == 64 and code not in {str(getattr(row, c.name)) for c in row.__table__.columns}   # stored hashed
    assert User.query.filter_by(email=EMAIL).one().email_verified is False


def test_unverified_cannot_login_or_use_api(client, app):
    reg(client)
    assert post(client, "login", email=EMAIL, password="password123").status_code == 403
    assert post(client, "login", email=EMAIL, password="wrong-password").status_code == 401
    u = User.query.filter_by(email=EMAIL).one()
    h = {"Authorization": "Bearer " + routes.make_token(u)}   # even a validly signed token is refused
    for method, path in [("get", "/api/auth/me"), ("get", "/api/profile"), ("get", "/api/health/latest"),
                         ("get", "/api/activity"), ("get", "/api/emergency/contacts"), ("post", "/api/emergency/sos")]:
        assert getattr(client, method)(path, headers=h).status_code == 403, path


def test_verify_correct_code_then_login(client):
    reg(client)
    r = post(client, "verify-email", email=EMAIL, code=last_code(EMAIL))
    d = r.get_json()["data"]
    assert r.status_code == 200 and d["token"] and d["user"]["email"] == EMAIL
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + d["token"]}).status_code == 200
    assert post(client, "login", email=EMAIL, password="password123").status_code == 200
    assert EmailOtp.query.count() == 0


def test_otp_cannot_be_reused(client):
    reg(client)
    code = last_code(EMAIL)
    assert post(client, "verify-email", email=EMAIL, code=code).status_code == 200
    assert post(client, "verify-email", email=EMAIL, code=code).status_code == 400


def test_wrong_code_rejected_and_attempts_limited(client):
    reg(client)
    good = last_code(EMAIL)
    bad = "000000" if good != "000000" else "111111"
    for _ in range(5):
        assert post(client, "verify-email", email=EMAIL, code=bad).status_code == 400
    assert post(client, "verify-email", email=EMAIL, code=good).status_code == 400   # locked out: even the right code fails
    assert User.query.filter_by(email=EMAIL).one().email_verified is False


def test_expired_code_rejected(client):
    reg(client)
    age_otp(EMAIL, expires=-5)
    assert post(client, "verify-email", email=EMAIL, code=last_code(EMAIL)).status_code == 400
    assert User.query.filter_by(email=EMAIL).one().email_verified is False


@pytest.mark.parametrize("code", ["", "12345", "1234567", "abcdef", 123456, None])
def test_code_format_validation(client, code):
    reg(client)
    assert post(client, "verify-email", email=EMAIL, code=code).status_code == 400


def test_unknown_email_looks_like_wrong_code(client):
    a = post(client, "verify-email", email="ghost@example.com", code="123456")
    reg(client)
    b = post(client, "verify-email", email=EMAIL, code="000000" if last_code(EMAIL) != "000000" else "111111")
    assert a.status_code == b.status_code == 400 and a.get_json() == b.get_json()


def test_resend_cooldown_and_invalidation(client):
    reg(client)
    first = last_code(EMAIL)
    r = post(client, "resend-verification", email=EMAIL)
    assert r.status_code == 200 and r.get_json()["data"]["resend_in"] == 60 and len(OUTBOX) == 1   # inside 60 s: nothing sent
    age_otp(EMAIL, created=61)
    post(client, "resend-verification", email=EMAIL)
    assert len(OUTBOX) == 2
    second = last_code(EMAIL)
    assert post(client, "verify-email", email=EMAIL, code=first).status_code == 400 if first != second else True   # old code invalidated
    assert post(client, "verify-email", email=EMAIL, code=second).status_code == 200


def test_resend_does_not_reveal_accounts(client):
    register(client, 1)
    n = len(OUTBOX)
    a = post(client, "resend-verification", email="ghost@example.com")
    b = post(client, "resend-verification", email="user1@example.com")      # already verified
    assert a.status_code == b.status_code == 200 and a.get_json() == b.get_json() and len(OUTBOX) == n


def test_pending_signup_cannot_be_overwritten_until_code_expires(client):
    reg(client)
    assert reg(client, password="attacker-pass1").status_code == 409                        # live code → blocked
    age_otp(EMAIL, created=601, expires=-1)
    assert reg(client, password="second-pass-2").status_code == 201                         # expired → new signup takes over
    assert post(client, "verify-email", email=EMAIL, code=last_code(EMAIL)).status_code == 200
    assert post(client, "login", email=EMAIL, password="second-pass-2").status_code == 200
    assert post(client, "login", email=EMAIL, password="password123").status_code == 401


def test_verified_email_still_409(client):
    register(client, 1)
    assert client.post("/api/auth/register", json={**REG, "email": "user1@example.com"}).status_code == 409


def test_delivery_failure_never_verifies(client, app):
    def boom(*a):
        raise email_service.EmailError("down")
    app.config["EMAIL_SENDER"] = boom
    r = reg(client)
    assert r.status_code == 201 and r.get_json()["data"]["email_sent"] is False
    assert EmailOtp.query.count() == 0 and User.query.one().email_verified is False
    assert post(client, "login", email=EMAIL, password="password123").status_code == 403
    app.config["EMAIL_SENDER"] = lambda *a: OUTBOX.append({"to": a[0], "subject": a[1], "html": a[2], "text": a[3]})
    post(client, "resend-verification", email=EMAIL)          # no cooldown was consumed by the failed send
    assert post(client, "verify-email", email=EMAIL, code=last_code(EMAIL)).status_code == 200


def test_not_configured_returns_503_and_creates_nothing(client, app):
    app.config["EMAIL_SENDER"] = None
    assert reg(client).status_code == 503 and User.query.count() == 0
    assert post(client, "forgot-password", email=EMAIL).status_code == 503


# ------------------------------------------------------------ password reset
def test_forgot_password_is_uniform_and_sends_only_for_real_accounts(client):
    register(client, 1)
    n = len(OUTBOX)
    a = post(client, "forgot-password", email="ghost@example.com")
    assert a.status_code == 200 and len(OUTBOX) == n
    b = post(client, "forgot-password", email="user1@example.com")
    assert b.status_code == 200 and a.get_json() == b.get_json() and len(OUTBOX) == n + 1
    assert "reset" in OUTBOX[-1]["subject"].lower() and "10 minutes" in OUTBOX[-1]["text"]


def test_reset_flow_end_to_end(client):
    h, _ = register(client, 1)
    post(client, "forgot-password", email="user1@example.com")
    code = last_code("user1@example.com")
    r = post(client, "reset-password", email="user1@example.com", code=code, new_password="brand-new-pass")
    assert r.status_code == 200 and "token" not in json.dumps(r.get_json()) and code not in json.dumps(r.get_json())
    assert post(client, "login", email="user1@example.com", password="password123").status_code == 401     # old password
    assert post(client, "login", email="user1@example.com", password="brand-new-pass").status_code == 200  # new password
    assert client.get("/api/auth/me", headers=h).status_code == 401                                         # old session revoked
    assert post(client, "reset-password", email="user1@example.com", code=code, new_password="another-pass1").status_code == 400  # no reuse


def test_reset_rejects_bad_expired_and_limits_attempts(client):
    register(client, 1)
    e = "user1@example.com"
    post(client, "forgot-password", email=e)
    good = last_code(e)
    bad = "000000" if good != "000000" else "111111"
    assert post(client, "reset-password", email=e, code=bad, new_password="brand-new-pass").status_code == 400
    assert post(client, "reset-password", email=e, code=good, new_password="short").status_code == 400    # weak pw: validated first
    age_otp(e, "reset", expires=-1)
    assert post(client, "reset-password", email=e, code=good, new_password="brand-new-pass").status_code == 400
    assert post(client, "login", email=e, password="password123").status_code == 200                       # password unchanged
    post(client, "forgot-password", email=e)                                                               # (cooldown row was deleted on expiry)
    age_otp(e, "reset", created=61)
    post(client, "forgot-password", email=e)
    good2 = last_code(e)
    for _ in range(5):
        post(client, "reset-password", email=e, code=bad if bad != good2 else "222222", new_password="brand-new-pass")
    assert post(client, "reset-password", email=e, code=good2, new_password="brand-new-pass").status_code == 400


def test_new_reset_code_invalidates_previous(client):
    register(client, 1)
    e = "user1@example.com"
    post(client, "forgot-password", email=e)
    first = last_code(e)
    age_otp(e, "reset", created=61)
    post(client, "forgot-password", email=e)
    second = last_code(e)
    if first != second:
        assert post(client, "reset-password", email=e, code=first, new_password="brand-new-pass").status_code == 400
    assert post(client, "reset-password", email=e, code=second, new_password="brand-new-pass").status_code == 200


def test_reset_verifies_an_unverified_account(client):
    reg(client)
    post(client, "forgot-password", email=EMAIL)
    assert post(client, "reset-password", email=EMAIL, code=last_code(EMAIL), new_password="brand-new-pass").status_code == 200
    assert post(client, "login", email=EMAIL, password="brand-new-pass").status_code == 200


def test_reset_request_rate_limited(client):
    register(client, 1)
    codes = [post(client, "forgot-password", email="user1@example.com").status_code for _ in range(7)]
    assert codes[:4].count(200) == 4 and 429 in codes     # register's own limit counts only IPs; per-email cap is 5/hour


def test_codes_and_passwords_never_logged(client, caplog):
    caplog.set_level(logging.DEBUG)
    reg(client)
    code = last_code(EMAIL)
    post(client, "verify-email", email=EMAIL, code=code)
    post(client, "forgot-password", email=EMAIL)
    post(client, "reset-password", email=EMAIL, code=last_code(EMAIL), new_password="very-secret-pw")
    assert code not in caplog.text and "very-secret-pw" not in caplog.text and "password123" not in caplog.text


# ------------------------------------------------------------ real Resend client against a local HTTP server
class _H(http.server.BaseHTTPRequestHandler):
    seen, status = [], 200

    def do_POST(self):
        _H.seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "ua": self.headers.get("User-Agent"),
                        "ct": self.headers.get("Content-Type"), "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])))})
        self.send_response(_H.status)
        self.end_headers()
        self.wfile.write(json.dumps({"id": "x"} if _H.status < 300 else {"message": "The domain is not verified"}).encode())

    def log_message(self, *a):
        pass


@pytest.fixture()
def fake_resend(app, monkeypatch):
    srv = http.server.HTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _H.seen.clear()
    _H.status = 200
    monkeypatch.setattr(email_service, "RESEND_URL", f"http://127.0.0.1:{srv.server_port}/emails")
    app.config.update(EMAIL_SENDER=None, RESEND_API_KEY="re_test_key", EMAIL_FROM="HealthGuard Lite <no-reply@example.com>")
    yield _H
    srv.shutdown()


def test_resend_request_shape_and_flow(client, fake_resend):
    r = reg(client)
    assert r.get_json()["data"]["email_sent"] is True
    req = fake_resend.seen[0]
    assert req["auth"] == "Bearer re_test_key" and req["ct"] == "application/json" and "healthguard" in req["ua"]
    b = req["body"]
    assert b["from"] == "HealthGuard Lite <no-reply@example.com>" and b["to"] == [EMAIL] and b["subject"] and b["html"] and b["text"]
    import re
    code = re.search(r"\b(\d{6})\b", b["text"]).group(1)
    assert post(client, "verify-email", email=EMAIL, code=code).status_code == 200


def test_resend_rejection_is_handled_without_leaking(client, fake_resend, caplog):
    fake_resend.status = 403           # e.g. sender domain not verified
    r = reg(client)
    assert r.status_code == 201 and r.get_json()["data"]["email_sent"] is False
    assert User.query.one().email_verified is False and EmailOtp.query.count() == 0
    code = __import__("re").search(r"\b(\d{6})\b", fake_resend.seen[0]["body"]["text"]).group(1)
    assert code not in caplog.text and "domain is not verified" in caplog.text    # operator sees the reason, never the code


def test_resend_unreachable_is_handled(client, app, monkeypatch):
    monkeypatch.setattr(email_service, "RESEND_URL", "http://127.0.0.1:9/emails")
    app.config.update(EMAIL_SENDER=None, RESEND_API_KEY="k", EMAIL_FROM="a@b.co")
    assert reg(client).get_json()["data"]["email_sent"] is False
