from .conftest import register, session_payload


def test_user_cannot_touch_others_contacts(client, alice, bob):
    cid = client.post("/api/emergency/contacts", headers=alice, json={"contact_name": "Mom", "phone_number": "+919000000001"}).get_json()["data"]["id"]
    assert client.get("/api/emergency/contacts", headers=bob).get_json()["data"] == []
    assert client.put(f"/api/emergency/contacts/{cid}", headers=bob, json={"contact_name": "Hacked", "phone_number": "+919000000009"}).status_code == 404
    assert client.delete(f"/api/emergency/contacts/{cid}", headers=bob).status_code == 404
    mine = client.get("/api/emergency/contacts", headers=alice).get_json()["data"]
    assert mine[0]["contact_name"] == "Mom" and mine[0]["phone_number"] == "+919000000001"


def test_same_phone_allowed_for_different_users(client, alice, bob):
    p = {"contact_name": "Shared", "phone_number": "+919000000001"}
    assert client.post("/api/emergency/contacts", headers=alice, json=p).status_code == 201
    assert client.post("/api/emergency/contacts", headers=bob, json=p).status_code == 201


def test_health_activity_events_are_private(client, alice, bob):
    client.post("/api/health/records", headers=alice, json={"heart_rate": 70, "signal_quality": 0.9})
    client.post("/api/activity", headers=alice, json=session_payload())
    client.post("/api/emergency/sos", headers=alice, json={"latitude": 1.0, "longitude": 2.0})
    assert client.get("/api/health/records", headers=bob).get_json()["data"] == []
    assert client.get("/api/health/latest", headers=bob).get_json()["data"] is None
    assert client.get("/api/activity", headers=bob).get_json()["data"] == []
    assert client.get("/api/activity/daily?tz=UTC", headers=bob).get_json()["data"] == []
    assert client.get("/api/emergency/events", headers=bob).get_json()["data"] == []


def test_client_supplied_user_id_is_ignored(client, alice, bob):
    uid_a = client.get("/api/auth/me", headers=alice).get_json()["data"]["id"]
    r = client.post("/api/health/records", headers=bob, json={"heart_rate": 90, "signal_quality": 0.9, "user_id": uid_a})
    assert r.status_code == 201
    assert client.get("/api/health/records", headers=alice).get_json()["data"] == []
    assert len(client.get("/api/health/records", headers=bob).get_json()["data"]) == 1


def test_client_id_is_scoped_per_user(client, alice, bob):
    p = session_payload(client_id="3f2b8c1e-6a4d-4e0a-9d51-0c7a1b2c3d4e")
    a = client.post("/api/activity", headers=alice, json=p)
    b = client.post("/api/activity", headers=bob, json=p)
    assert a.status_code == b.status_code == 201
    assert a.get_json()["data"]["id"] != b.get_json()["data"]["id"]


def test_profile_and_logout_do_not_cross_users(client, alice, bob):
    client.put("/api/profile", headers=alice, json={"full_name": "Alice A", "phone_number": "+919111111111"})
    assert client.get("/api/profile", headers=bob).get_json()["data"]["phone_number"] is None
    client.post("/api/auth/logout", headers=alice)
    assert client.get("/api/auth/me", headers=bob).status_code == 200  # revoking Alice never affects Bob
