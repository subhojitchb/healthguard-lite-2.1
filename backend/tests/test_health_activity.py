from datetime import datetime, timedelta, timezone

import pytest

from .conftest import session_payload


def test_health_record_flow(client, alice):
    assert client.get("/api/health/latest", headers=alice).get_json()["data"] is None
    r = client.post("/api/health/records", headers=alice, json={"heart_rate": 72, "signal_quality": 0.9})
    assert r.status_code == 201 and r.get_json()["data"]["measurement_type"] == "camera_ppg"
    client.post("/api/health/records", headers=alice, json={"heart_rate": 80, "signal_quality": 0.8})
    assert client.get("/api/health/latest", headers=alice).get_json()["data"]["heart_rate"] == 80
    assert len(client.get("/api/health/records", headers=alice).get_json()["data"]) == 2


@pytest.mark.parametrize("payload", [
    {}, {"heart_rate": 10, "signal_quality": 0.9}, {"heart_rate": 300, "signal_quality": 0.9},
    {"heart_rate": 72.5, "signal_quality": 0.9}, {"heart_rate": True, "signal_quality": 0.9}, {"heart_rate": "72", "signal_quality": 0.9},
    {"heart_rate": 72}, {"heart_rate": 72, "signal_quality": 0.3},           # camera readings need good quality
    {"heart_rate": 72, "signal_quality": 1.5},
    {"spo2": 98, "signal_quality": 0.9},                                      # camera cannot supply SpO2
    {"heart_rate": 72, "signal_quality": 0.9, "measurement_type": "manual"},
    {"spo2": 20, "measurement_type": "external_sensor"},
])
def test_health_validation(client, alice, payload):
    r = client.post("/api/health/records", headers=alice, json=payload)
    assert r.status_code == 400, payload


def test_external_spo2_accepted(client, alice):
    r = client.post("/api/health/records", headers=alice, json={"spo2": 97, "measurement_type": "external_sensor"})
    assert r.status_code == 201 and r.get_json()["data"]["spo2"] == 97


def test_health_query_params(client, alice):
    client.post("/api/health/records", headers=alice, json={"heart_rate": 72, "signal_quality": 0.9})
    for q in ("limit=abc", "limit=0", "limit=9999", "offset=-1", "date=nope", "date=2026-01-01&tz=Not/AZone"):
        assert client.get("/api/health/records?" + q, headers=alice).status_code == 400, q
    today = datetime.now(timezone.utc).date().isoformat()
    got = client.get(f"/api/health/records?date={today}&tz=UTC", headers=alice).get_json()["data"]
    assert len(got) == 1
    far = (datetime.now(timezone.utc) - timedelta(days=10)).date().isoformat()
    assert client.get(f"/api/health/records?date={far}&tz=UTC", headers=alice).get_json()["data"] == []


def test_activity_roundtrip(client, alice):
    r = client.post("/api/activity", headers=alice, json=session_payload())
    assert r.status_code == 201
    got = client.get("/api/activity", headers=alice).get_json()["data"]
    assert len(got) == 1 and got[0]["steps"] == 600


def test_activity_validation(client, alice):
    good = session_payload()
    now = datetime.now(timezone.utc)
    cases = [
        {**good, "steps": -1}, {**good, "steps": "10"}, {**good, "steps": 2.5}, {**good, "steps": 100001},
        {**good, "duration_seconds": -5},
        {**good, "started_at": good["ended_at"], "ended_at": good["started_at"]},          # end before start
        {**good, "started_at": "garbage"},
        {**good, "ended_at": (now + timedelta(hours=2)).isoformat()},                        # future
        {**good, "started_at": (now - timedelta(days=60)).isoformat(), "ended_at": (now - timedelta(days=60) + timedelta(minutes=10)).isoformat()},
        {**good, "duration_seconds": 9000},                                                  # longer than the window
        {**good, "steps": 5000},                                                             # implausible rate
        {**good, "client_id": "not-a-uuid"},
    ]
    for c in cases:
        assert client.post("/api/activity", headers=alice, json=c).status_code == 400, c


def test_activity_idempotent_client_id(client, alice):
    p = session_payload(client_id="3f2b8c1e-6a4d-4e0a-9d51-0c7a1b2c3d4e")
    first = client.post("/api/activity", headers=alice, json=p)
    second = client.post("/api/activity", headers=alice, json=p)
    assert first.status_code == 201 and second.status_code == 200
    assert first.get_json()["data"]["id"] == second.get_json()["data"]["id"]
    assert len(client.get("/api/activity", headers=alice).get_json()["data"]) == 1


def _two_sessions_around_ist_midnight(client, h):
    """18:00Z = 23:30 IST (day D) and 19:00Z = 00:30 IST (day D+1); both are day D in UTC."""
    base = (datetime.now(timezone.utc) - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    for i, steps in enumerate((100, 200)):
        s = base + timedelta(hours=i)
        r = client.post("/api/activity", headers=h, json={"steps": steps, "duration_seconds": 300, "started_at": s.isoformat(), "ended_at": (s + timedelta(minutes=5)).isoformat()})
        assert r.status_code == 201
    return base.date()


def test_daily_groups_by_local_date(client, alice):
    D = _two_sessions_around_ist_midnight(client, alice)
    ist = client.get("/api/activity/daily?days=7&tz=Asia/Kolkata", headers=alice).get_json()["data"]
    assert {(d["date"], d["steps"]) for d in ist} == {(D.isoformat(), 100), ((D + timedelta(days=1)).isoformat(), 200)}
    utc = client.get("/api/activity/daily?days=7&tz=UTC", headers=alice).get_json()["data"]
    assert [(d["date"], d["steps"]) for d in utc] == [(D.isoformat(), 300)]
    la = client.get("/api/activity/daily?days=7&tz=America/Los_Angeles", headers=alice).get_json()["data"]
    assert [(d["date"], d["steps"]) for d in la] == [(D.isoformat(), 300)]


def test_daily_tz_validation(client, alice):
    for q in ("tz=Mars/Base", "tz=../etc/passwd", "days=0", "days=abc", "days=1000"):
        assert client.get("/api/activity/daily?" + q, headers=alice).status_code == 400, q
