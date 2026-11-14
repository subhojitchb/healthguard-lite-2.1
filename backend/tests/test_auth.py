import time
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app import routes
from .conftest import register


def test_register_login_me(client):
    h, user = register(client)
    assert user["email"] == "user1@example.com" and "password" not in str(user) and "hash" not in str(user)
    r = client.post("/api/auth/login", json={"email": "USER1@example.com", "password": "password123"})
    assert r.status_code == 200 and r.get_json()["ok"] is True
    me = client.get("/api/auth/me", headers={"Authorization": "Bearer " + r.get_json()["data"]["token"]})
    assert me.status_code == 200 and me.get_json()["data"]["full_name"] == "User 1"


@pytest.mark.parametrize("payload", [
    {}, {"full_name": "A", "email": "a@b.co", "password": "password123"},
    {"full_name": "Valid Name", "email": "not-an-email", "password": "password123"},
    {"full_name": "Valid Name", "email": "a@b.co", "password": "short"},
    {"full_name": "Valid Name", "email": "a@b.co", "password": 12345678},
    {"full_name": "Valid\x00Name", "email": "a@b.co", "password": "password123"},
])
def test_register_validation(client, payload):
    r = client.post("/api/auth/register", json=payload)
    assert r.status_code == 400 and r.get_json()["ok"] is False


def test_register_non_object_body(client):
    assert client.post("/api/auth/register", json=[1, 2]).status_code == 400
    assert client.post("/api/auth/register", data="nope").status_code == 400


def test_duplicate_email_case_insensitive(client):
    register(client)
    r = client.post("/api/auth/register", json={"full_name": "Other", "email": "USER1@EXAMPLE.COM", "password": "password123"})
    assert r.status_code == 409


def test_login_failures_are_uniform(client):
    register(client)
    a = client.post("/api/auth/login", json={"email": "user1@example.com", "password": "wrong-password"})
    b = client.post("/api/auth/login", json={"email": "ghost@example.com", "password": "wrong-password"})
    assert a.status_code == b.status_code == 401 and a.get_json() == b.get_json()


def test_login_throttle(client):
    register(client)
    for _ in range(5):
        assert client.post("/api/auth/login", json={"email": "user1@example.com", "password": "bad-password"}).status_code == 401
    r = client.post("/api/auth/login", json={"email": "user1@example.com", "password": "password123"})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_successful_login_clears_failures(client):
    register(client)
    for _ in range(3):
        client.post("/api/auth/login", json={"email": "user1@example.com", "password": "bad-password"})
    assert client.post("/api/auth/login", json={"email": "user1@example.com", "password": "password123"}).status_code == 200
    assert client.post("/api/auth/login", json={"email": "user1@example.com", "password": "bad-password"}).status_code == 401


def _tok(app, **over):
    now = datetime.now(timezone.utc)
    claims = {"sub": "1", "tv": 0, "iss": routes.ISSUER, "iat": now, "exp": now + timedelta(hours=1)}
    claims.update(over)
    key = over.pop("_key", app.config["SECRET_KEY"])
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="HS256")


def test_bad_tokens_rejected(app, client):
    register(client)
    now = datetime.now(timezone.utc)
    bad = [
        _tok(app, exp=now - timedelta(minutes=5)),                     # expired
        _tok(app, iss="someone-else"),                                  # wrong issuer
        _tok(app, tv=99),                                               # stale token_version
        jwt.encode({"sub": "1", "tv": 0, "iss": routes.ISSUER, "iat": now, "exp": now + timedelta(hours=1)}, "x" * 40, algorithm="HS256"),  # wrong key
        jwt.encode({"sub": "1", "iss": routes.ISSUER}, None, algorithm="none"),  # alg=none
        _tok(app, exp=None),                                            # no exp
        "garbage",
    ]
    for t in bad:
        r = client.get("/api/auth/me", headers={"Authorization": "Bearer " + t})
        assert r.status_code == 401, t
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + _tok(app)}).status_code == 200


def test_logout_revokes_all_tokens(client):
    h, _ = register(client)
    assert client.get("/api/auth/me", headers=h).status_code == 200
    assert client.post("/api/auth/logout", headers=h).status_code == 200
    assert client.get("/api/auth/me", headers=h).status_code == 401
    assert client.post("/api/auth/logout", headers=h).status_code == 401
    r = client.post("/api/auth/login", json={"email": "user1@example.com", "password": "password123"})
    new = {"Authorization": "Bearer " + r.get_json()["data"]["token"]}
    assert client.get("/api/auth/me", headers=new).status_code == 200


PUBLIC = {"api.register", "api.login", "api.health_check", "static"}


def test_every_private_endpoint_requires_auth(app, client):
    checked = 0
    for rule in app.url_map.iter_rules():
        if rule.endpoint in PUBLIC:
            continue
        url = rule.rule.replace("<int:cid>", "1")
        for m in rule.methods - {"HEAD", "OPTIONS"}:
            r = client.open(url, method=m, json={})
            assert r.status_code == 401, f"{m} {url} -> {r.status_code}"
            checked += 1
    assert checked >= 15


def test_profile_update(client, alice):
    r = client.put("/api/profile", headers=alice, json={"full_name": "New Name", "phone_number": "+91 98765-43210", "date_of_birth": "2000-05-01"})
    d = r.get_json()["data"]
    assert r.status_code == 200 and d["phone_number"] == "+919876543210" and d["date_of_birth"] == "2000-05-01"
    assert client.get("/api/profile", headers=alice).get_json()["data"]["full_name"] == "New Name"
    for bad in ({"phone_number": "abc"}, {"date_of_birth": "2999-01-01"}, {"date_of_birth": "garbage"}, {"full_name": "x"}):
        assert client.put("/api/profile", headers=alice, json=bad).status_code == 400


def test_health_check_and_headers(client):
    r = client.get("/api/health-check")
    assert r.status_code == 200 and r.get_json() == {"ok": True, "backend": "running", "database": "connected"}
    me = client.get("/api/auth/me")
    assert me.headers["Cache-Control"] == "no-store" and me.headers["X-Content-Type-Options"] == "nosniff"


def test_json_errors_not_html(client):
    r = client.get("/api/nope")
    assert r.status_code == 404 and r.get_json()["ok"] is False
    r = client.delete("/api/health-check")
    assert r.status_code == 405 and r.get_json()["ok"] is False


def test_cors_allows_only_configured_origin(client):
    ok_ = client.options("/api/auth/login", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    bad = client.options("/api/auth/login", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert ok_.headers.get("Access-Control-Allow-Origin") == "http://localhost:3000"
    assert "Access-Control-Allow-Origin" not in bad.headers
