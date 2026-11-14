import os
from datetime import datetime, timedelta, timezone

import pytest

from app import create_app, db
from app import routes, email_service

OUTBOX = []   # captured emails (test double for the Resend sender; real delivery is tested separately)


def fake_sender(to, subject, html, text):
    OUTBOX.append({"to": to, "subject": subject, "html": html, "text": text})


def last_code(email):
    import re
    mails = [m for m in OUTBOX if m["to"] == email]
    return re.search(r"\b(\d{6})\b", mails[-1]["text"]).group(1)
from app import email_service

OUTBOX = []   # emails captured by the test sender (the real Resend client is tested separately against a local HTTP server)


def capture_email(to, subject, html, text):
    OUTBOX.append({"to": to, "subject": subject, "html": html, "text": text})


def last_code(email):
    import re
    msgs = [m for m in OUTBOX if m["to"] == email]
    return re.search(r"\b(\d{6})\b", msgs[-1]["text"]).group(1)


class TestConfig:
    TESTING = True
    SECRET_KEY = "t" * 40
    SQLALCHEMY_DATABASE_URI = os.environ.get("TEST_DATABASE_URL", "sqlite://")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_EXPIRY_HOURS = 24
    CORS_ORIGINS = ["http://localhost:3000"]
    TRUST_PROXY = False
    LOGIN_MAX_FAILURES = 5
    LOGIN_WINDOW_SECONDS = 900
    EMAIL_SENDER = staticmethod(fake_sender)
    RESEND_API_KEY = ""
    EMAIL_FROM = ""
    EMAIL_SENDER = staticmethod(capture_email)
    RESEND_API_KEY = ""
    EMAIL_FROM = ""


@pytest.fixture()
def app():
    routes._fails.clear()
    email_service._hits.clear()
    OUTBOX.clear()
    email_service._hits.clear()
    OUTBOX.clear()
    a = create_app(TestConfig)
    with a.app_context():
        db.drop_all()
        db.create_all()
        yield a
        db.session.remove()
        db.drop_all()


@pytest.fixture()
def client(app):
    return app.test_client()


def register(client, n=1, password="password123"):
    """Register AND verify (email OTP) so the account can use the app."""
    email = f"user{n}@example.com"
    r = client.post("/api/auth/register", json={"full_name": f"User {n}", "email": email, "password": password})
    assert r.status_code == 201, r.get_json()
    v = client.post("/api/auth/verify-email", json={"email": email, "code": last_code(email)})
    assert v.status_code == 200, v.get_json()
    d = v.get_json()["data"]
    return {"Authorization": "Bearer " + d["token"]}, d["user"]


@pytest.fixture()
def alice(client):
    return register(client, 1)[0]


@pytest.fixture()
def bob(client):
    return register(client, 2)[0]


def session_payload(hours_ago=2, minutes=10, steps=600, **extra):
    end = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    start = end - timedelta(minutes=minutes)
    p = {"steps": steps, "duration_seconds": minutes * 60, "started_at": start.isoformat(), "ended_at": end.isoformat()}
    p.update(extra)
    return p
