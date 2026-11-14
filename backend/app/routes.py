import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone, date, time as dtime
from functools import wraps
from zoneinfo import ZoneInfo

import jwt
from flask import Blueprint, request, jsonify, g, current_app
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from werkzeug.security import generate_password_hash, check_password_hash

from . import db
from .errors import ApiError
from .models import (User, UserProfile, HealthRecord, ActivityRecord,
                     EmergencyContact, EmergencyEvent)

bp = Blueprint("api", __name__, url_prefix="/api")
UTC = timezone.utc
ISSUER = "healthguard-lite"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9]{3,15}$")
MEASUREMENT_TYPES = {"camera_ppg", "external_sensor"}
MIN_PPG_QUALITY = 0.6
MAX_CONTACTS = 10
DUMMY_HASH = generate_password_hash("not-a-real-password")  # equalises login timing for unknown emails


# ---------------------------------------------------------------- helpers
def ok(data=None, status=200):
    return jsonify(ok=True, data=data), status


def body():
    d = request.get_json(silent=True)
    if not isinstance(d, dict):
        raise ApiError("A JSON object body is required")
    return d


def clean(s, n):
    return s.strip()[:n] if isinstance(s, str) else ""


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def qint(name, default, lo, hi):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        v = int(raw)
    except ValueError:
        raise ApiError(f"{name} must be an integer")
    if not lo <= v <= hi:
        raise ApiError(f"{name} must be between {lo} and {hi}")
    return v


def iso(d):
    return as_utc(d).isoformat() if d else None


def as_utc(d):
    """SQLite returns naive datetimes; PostgreSQL returns aware ones. Normalise to aware UTC."""
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def get_tz(name):
    if not name:
        return UTC
    if len(name) > 64:
        raise ApiError("Invalid time zone")
    try:
        return ZoneInfo(name)
    except Exception:
        raise ApiError("Invalid time zone (use an IANA name such as Asia/Kolkata)")


def parse_dt(v):
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return as_utc(d)


def commit():
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise


def user_json(u):
    p = u.profile
    return {"id": u.id, "full_name": u.full_name, "email": u.email,
            "phone_number": p.phone_number if p else None,
            "date_of_birth": p.date_of_birth.isoformat() if p and p.date_of_birth else None}


# ---------------------------------------------------------------- auth plumbing
def make_token(u):
    now = datetime.now(UTC)
    return jwt.encode({"sub": str(u.id), "tv": u.token_version, "iss": ISSUER, "iat": now,
                       "exp": now + timedelta(hours=current_app.config["JWT_EXPIRY_HOURS"]),
                       "jti": secrets.token_hex(8)},
                      current_app.config["SECRET_KEY"], algorithm="HS256")


def auth(fn):
    @wraps(fn)
    def wrapper(*a, **k):
        h = request.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            raise ApiError("Authentication required", 401)
        try:
            p = jwt.decode(h[7:], current_app.config["SECRET_KEY"], algorithms=["HS256"], issuer=ISSUER,
                           options={"require": ["exp", "iat", "sub", "iss"]}, leeway=10)
            user = db.session.get(User, int(p["sub"]))
            if not user or p.get("tv") != user.token_version:
                raise ValueError("revoked")
        except Exception:
            raise ApiError("Invalid or expired token", 401)
        g.user = user
        return fn(*a, **k)
    return wrapper


# Login throttle: in-memory, per worker process. Slows brute force; not a substitute for a shared limiter.
_fails = {}


def _recent(key):
    window = current_app.config["LOGIN_WINDOW_SECONDS"]
    cutoff = time.time() - window
    lst = [t for t in _fails.get(key, []) if t > cutoff]
    if lst:
        _fails[key] = lst
    else:
        _fails.pop(key, None)
    return lst


def _throttle_keys(email):
    return [("e:" + email, current_app.config["LOGIN_MAX_FAILURES"]),
            ("ip:" + (request.remote_addr or "?"), current_app.config["LOGIN_MAX_FAILURES"] * 5)]


# ---------------------------------------------------------------- system
@bp.get("/health-check")
def health_check():
    try:
        db.session.execute(text("SELECT 1"))
        dbs = "connected"
    except Exception:
        db.session.rollback()
        dbs = "unreachable"
    return jsonify(ok=dbs == "connected", backend="running", database=dbs), (200 if dbs == "connected" else 503)


# ---------------------------------------------------------------- auth
@bp.post("/auth/register")
def register():
    d = body()
    name, email, pw = clean(d.get("full_name"), 100), clean(d.get("email"), 254).lower(), d.get("password")
    if len(name) < 2 or any(ord(c) < 32 for c in name):
        raise ApiError("Full name is required (2-100 characters)")
    if not EMAIL_RE.match(email):
        raise ApiError("A valid email is required")
    if not isinstance(pw, str) or not 8 <= len(pw) <= 128:
        raise ApiError("Password must be 8-128 characters")
    if User.query.filter_by(email=email).first():
        raise ApiError("Email already registered", 409)
    u = User(full_name=name, email=email, password_hash=generate_password_hash(pw))
    u.profile = UserProfile()
    db.session.add(u)
    try:
        commit()
    except IntegrityError:  # concurrent duplicate registration
        raise ApiError("Email already registered", 409)
    return ok({"token": make_token(u), "user": user_json(u)}, 201)


@bp.post("/auth/login")
def login():
    d = body()
    email, pw = clean(d.get("email"), 254).lower(), d.get("password")
    keys = _throttle_keys(email)
    for key, limit in keys:
        if len(_recent(key)) >= limit:
            raise ApiError("Too many failed attempts. Try again later.", 429,
                           {"Retry-After": str(current_app.config["LOGIN_WINDOW_SECONDS"])})
    u = User.query.filter_by(email=email).first()
    good = check_password_hash(u.password_hash if u else DUMMY_HASH, pw if isinstance(pw, str) else "")
    if not u or not good:
        for key, _ in keys:
            _fails.setdefault(key, []).append(time.time())
        raise ApiError("Invalid email or password", 401)
    _fails.pop(keys[0][0], None)
    return ok({"token": make_token(u), "user": user_json(u)})


@bp.post("/auth/logout")
@auth
def logout():
    # Server-side revocation: bumping token_version invalidates every token issued so far
    # (all devices). Tokens issued afterwards (next login) are unaffected.
    g.user.token_version += 1
    commit()
    return ok({"message": "Logged out"})


@bp.get("/auth/me")
@auth
def me():
    return ok(user_json(g.user))


# ---------------------------------------------------------------- profile
@bp.get("/profile")
@auth
def get_profile():
    return ok(user_json(g.user))


@bp.put("/profile")
@auth
def put_profile():
    d, u = body(), g.user
    if "full_name" in d:
        n = clean(d["full_name"], 100)
        if len(n) < 2 or any(ord(c) < 32 for c in n):
            raise ApiError("Full name is required (2-100 characters)")
        u.full_name = n
    if not u.profile:
        u.profile = UserProfile()
    if "phone_number" in d:
        ph = re.sub(r"[ \-]", "", clean(d["phone_number"], 25))
        if ph and not PHONE_RE.match(ph):
            raise ApiError("Invalid phone number")
        u.profile.phone_number = ph or None
    if "date_of_birth" in d:
        if d["date_of_birth"]:
            try:
                dob = date.fromisoformat(d["date_of_birth"])
            except (ValueError, TypeError):
                raise ApiError("Invalid date of birth (YYYY-MM-DD)")
            if dob > date.today() or dob.year < 1900:
                raise ApiError("Date of birth out of range")
            u.profile.date_of_birth = dob
        else:
            u.profile.date_of_birth = None
    commit()
    return ok(user_json(u))


# ---------------------------------------------------------------- health
def hr_json(r):
    return {"id": r.id, "heart_rate": r.heart_rate, "spo2": r.spo2, "measurement_type": r.measurement_type,
            "signal_quality": r.signal_quality, "recorded_at": iso(r.recorded_at)}


@bp.post("/health/records")
@auth
def add_health():
    d = body()
    hr, sp, q = d.get("heart_rate"), d.get("spo2"), d.get("signal_quality")
    mt = d.get("measurement_type", "camera_ppg")
    if mt not in MEASUREMENT_TYPES:
        raise ApiError("measurement_type must be one of: " + ", ".join(sorted(MEASUREMENT_TYPES)))
    if hr is None and sp is None:
        raise ApiError("heart_rate or spo2 is required")
    if hr is not None and (not is_int(hr) or not 30 <= hr <= 220):
        raise ApiError("heart_rate must be an integer between 30 and 220")
    if sp is not None:
        if mt != "external_sensor":
            raise ApiError("spo2 is only accepted from an external sensor (a phone camera cannot measure it)")
        if not is_int(sp) or not 50 <= sp <= 100:
            raise ApiError("spo2 must be an integer between 50 and 100")
    if q is not None and (not is_num(q) or not 0 <= q <= 1):
        raise ApiError("signal_quality must be between 0 and 1")
    if mt == "camera_ppg" and (q is None or q < MIN_PPG_QUALITY):
        raise ApiError(f"Camera readings require signal_quality >= {MIN_PPG_QUALITY}")
    r = HealthRecord(user_id=g.user.id, heart_rate=hr, spo2=sp, signal_quality=q, measurement_type=mt)
    db.session.add(r)
    commit()
    return ok(hr_json(r), 201)


@bp.get("/health/records")
@auth
def list_health():
    q = HealthRecord.query.filter_by(user_id=g.user.id)
    if request.args.get("date"):
        try:
            day = date.fromisoformat(request.args["date"])
        except ValueError:
            raise ApiError("Invalid date (YYYY-MM-DD)")
        start = datetime.combine(day, dtime.min, tzinfo=get_tz(request.args.get("tz"))).astimezone(UTC)
        end = datetime.combine(day + timedelta(days=1), dtime.min, tzinfo=get_tz(request.args.get("tz"))).astimezone(UTC)
        q = q.filter(HealthRecord.recorded_at >= start, HealthRecord.recorded_at < end)
    rows = (q.order_by(HealthRecord.recorded_at.desc(), HealthRecord.id.desc())
             .limit(qint("limit", 100, 1, 500)).offset(qint("offset", 0, 0, 100000)))
    return ok([hr_json(r) for r in rows])


@bp.get("/health/latest")
@auth
def latest_health():
    r = (HealthRecord.query.filter_by(user_id=g.user.id)
         .order_by(HealthRecord.recorded_at.desc(), HealthRecord.id.desc()).first())
    return ok(hr_json(r) if r else None)


# ---------------------------------------------------------------- activity
def act_json(a):
    return {"id": a.id, "steps": a.steps, "duration_seconds": a.duration_seconds,
            "started_at": iso(a.started_at), "ended_at": iso(a.ended_at), "client_id": a.client_id}


@bp.post("/activity")
@auth
def add_activity():
    d = body()
    steps, dur = d.get("steps"), d.get("duration_seconds", 0)
    s, e = parse_dt(d.get("started_at")), parse_dt(d.get("ended_at"))
    cid = d.get("client_id")
    if not is_int(steps) or not 0 <= steps <= 100000:
        raise ApiError("steps must be an integer between 0 and 100000")
    if not is_int(dur) or dur < 0:
        raise ApiError("duration_seconds must be a non-negative integer")
    if not s or not e or e < s:
        raise ApiError("started_at / ended_at are invalid")
    now = datetime.now(UTC)
    if e > now + timedelta(minutes=5) or s < now - timedelta(days=35):
        raise ApiError("Session times are outside the accepted range")
    span = (e - s).total_seconds()
    if span > 86400 or dur > span + 5:
        raise ApiError("duration_seconds is inconsistent with the session times")
    if steps > 4 * dur + 10:
        raise ApiError("Step count is implausible for the session duration")
    if cid is not None:
        try:
            cid = str(uuid.UUID(str(cid)))
        except ValueError:
            raise ApiError("client_id must be a UUID")
        dup = ActivityRecord.query.filter_by(user_id=g.user.id, client_id=cid).first()
        if dup:
            return ok(act_json(dup), 200)  # idempotent retry
    a = ActivityRecord(user_id=g.user.id, steps=steps, duration_seconds=dur, started_at=s, ended_at=e, client_id=cid)
    db.session.add(a)
    try:
        commit()
    except IntegrityError:
        dup = ActivityRecord.query.filter_by(user_id=g.user.id, client_id=cid).first() if cid else None
        if dup:
            return ok(act_json(dup), 200)
        raise
    return ok(act_json(a), 201)


@bp.get("/activity")
@auth
def list_activity():
    q = (ActivityRecord.query.filter_by(user_id=g.user.id)
         .order_by(ActivityRecord.started_at.desc(), ActivityRecord.id.desc())
         .limit(qint("limit", 100, 1, 500)).offset(qint("offset", 0, 0, 100000)))
    return ok([act_json(a) for a in q])


@bp.get("/activity/daily")
@auth
def daily_activity():
    """Totals per LOCAL calendar day of the requested IANA time zone (?tz=Asia/Kolkata).
    A session is attributed to the local day on which it started."""
    days, tz = qint("days", 14, 1, 90), get_tz(request.args.get("tz"))
    first = datetime.now(tz).date() - timedelta(days=days - 1)
    since = datetime.combine(first, dtime.min, tzinfo=tz).astimezone(UTC)
    rows = ActivityRecord.query.filter(ActivityRecord.user_id == g.user.id, ActivityRecord.started_at >= since)
    out = {}
    for r in rows:
        k = as_utc(r.started_at).astimezone(tz).date().isoformat()
        b = out.setdefault(k, {"date": k, "steps": 0, "duration_seconds": 0})
        b["steps"] += r.steps
        b["duration_seconds"] += r.duration_seconds
    return ok([out[k] for k in sorted(out)])


# ---------------------------------------------------------------- emergency
def c_json(c):
    return {"id": c.id, "contact_name": c.contact_name, "phone_number": c.phone_number, "relationship": c.relationship}


def read_contact(d, existing=None):
    name = clean(d.get("contact_name"), 100)
    ph = re.sub(r"[ \-]", "", clean(d.get("phone_number"), 25))
    if not name:
        raise ApiError("Contact name is required")
    if not PHONE_RE.match(ph):
        raise ApiError("A valid phone number is required (3-15 digits, optional leading +)")
    dup = EmergencyContact.query.filter_by(user_id=g.user.id, phone_number=ph).first()
    if dup and (not existing or dup.id != existing.id):
        raise ApiError("A contact with this number already exists", 409)
    return name, ph, clean(d.get("relationship"), 50) or None


def own_contact(cid):
    c = EmergencyContact.query.filter_by(id=cid, user_id=g.user.id).first()  # ownership enforced in the query
    if not c:
        raise ApiError("Contact not found", 404)
    return c


@bp.get("/emergency/contacts")
@auth
def list_contacts():
    q = EmergencyContact.query.filter_by(user_id=g.user.id).order_by(EmergencyContact.created_at, EmergencyContact.id)
    return ok([c_json(c) for c in q])


@bp.post("/emergency/contacts")
@auth
def add_contact():
    d = body()
    if EmergencyContact.query.filter_by(user_id=g.user.id).count() >= MAX_CONTACTS:
        raise ApiError(f"At most {MAX_CONTACTS} emergency contacts are allowed", 409)
    name, ph, rel = read_contact(d)
    c = EmergencyContact(user_id=g.user.id, contact_name=name, phone_number=ph, relationship=rel)
    db.session.add(c)
    try:
        commit()
    except IntegrityError:
        raise ApiError("A contact with this number already exists", 409)
    return ok(c_json(c), 201)


@bp.put("/emergency/contacts/<int:cid>")
@auth
def edit_contact(cid):
    c = own_contact(cid)
    c.contact_name, c.phone_number, c.relationship = read_contact(body(), c)
    try:
        commit()
    except IntegrityError:
        raise ApiError("A contact with this number already exists", 409)
    return ok(c_json(c))


@bp.delete("/emergency/contacts/<int:cid>")
@auth
def del_contact(cid):
    db.session.delete(own_contact(cid))
    commit()
    return ok({"deleted": cid})


@bp.post("/emergency/sos")
@auth
def sos():
    d = body()
    lat, lng = d.get("latitude"), d.get("longitude")
    if (lat is None) != (lng is None):
        raise ApiError("Provide both latitude and longitude, or neither")
    if lat is not None and not (is_num(lat) and is_num(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
        raise ApiError("Invalid coordinates")
    ev = EmergencyEvent(user_id=g.user.id, latitude=lat, longitude=lng, event_status="recorded")
    db.session.add(ev)
    commit()
    contacts = EmergencyContact.query.filter_by(user_id=g.user.id).order_by(EmergencyContact.id)
    return ok({"event": ev_json(ev), "contacts": [c_json(c) for c in contacts],
               "notice": "Event recorded. No SMS or call was sent automatically; use the call/share actions."}, 201)


def ev_json(e):
    return {"id": e.id, "latitude": e.latitude, "longitude": e.longitude,
            "event_status": e.event_status, "created_at": iso(e.created_at)}


@bp.get("/emergency/events")
@auth
def events():
    q = (EmergencyEvent.query.filter_by(user_id=g.user.id)
         .order_by(EmergencyEvent.created_at.desc(), EmergencyEvent.id.desc()).limit(qint("limit", 50, 1, 200)))
    return ok([ev_json(e) for e in q])
