import os
from datetime import datetime, timedelta, timezone

import pytest

from app import create_app, db
from app import routes


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


@pytest.fixture()
def app():
    routes._fails.clear()
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
    r = client.post("/api/auth/register", json={"full_name": f"User {n}", "email": f"user{n}@example.com", "password": password})
    assert r.status_code == 201, r.get_json()
    d = r.get_json()["data"]
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
