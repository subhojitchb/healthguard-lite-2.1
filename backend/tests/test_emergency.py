def contact(n=1, **kw):
    return {"contact_name": f"Contact {n}", "phone_number": f"+91900000000{n}", "relationship": "Friend", **kw}


def test_contact_crud(client, alice):
    r = client.post("/api/emergency/contacts", headers=alice, json=contact(1, phone_number="+91 90000-00001"))
    assert r.status_code == 201 and r.get_json()["data"]["phone_number"] == "+919000000001"
    cid = r.get_json()["data"]["id"]
    r = client.put(f"/api/emergency/contacts/{cid}", headers=alice, json=contact(1, contact_name="Renamed"))
    assert r.status_code == 200 and r.get_json()["data"]["contact_name"] == "Renamed"
    assert len(client.get("/api/emergency/contacts", headers=alice).get_json()["data"]) == 1
    assert client.delete(f"/api/emergency/contacts/{cid}", headers=alice).status_code == 200
    assert client.delete(f"/api/emergency/contacts/{cid}", headers=alice).status_code == 404
    assert client.get("/api/emergency/contacts", headers=alice).get_json()["data"] == []


def test_contact_validation_and_duplicates(client, alice):
    for bad in ({}, {"contact_name": "", "phone_number": "+919000000001"}, {"contact_name": "X", "phone_number": "abc"}, {"contact_name": "X", "phone_number": "1"}):
        assert client.post("/api/emergency/contacts", headers=alice, json=bad).status_code == 400, bad
    assert client.post("/api/emergency/contacts", headers=alice, json=contact(1)).status_code == 201
    assert client.post("/api/emergency/contacts", headers=alice, json=contact(1, contact_name="Dup")).status_code == 409
    other = client.post("/api/emergency/contacts", headers=alice, json=contact(2)).get_json()["data"]["id"]
    assert client.put(f"/api/emergency/contacts/{other}", headers=alice, json=contact(1)).status_code == 409
    assert client.put(f"/api/emergency/contacts/{other}", headers=alice, json=contact(2, relationship="Sibling")).status_code == 200


def test_contact_limit(client, alice):
    for i in range(10):
        assert client.post("/api/emergency/contacts", headers=alice, json={"contact_name": "C", "phone_number": f"+9190000010{i:02d}"}).status_code == 201
    assert client.post("/api/emergency/contacts", headers=alice, json={"contact_name": "C", "phone_number": "+919000001999"}).status_code == 409


def test_sos_with_and_without_location(client, alice):
    client.post("/api/emergency/contacts", headers=alice, json=contact(1))
    r = client.post("/api/emergency/sos", headers=alice, json={"latitude": 22.57, "longitude": 88.36})
    d = r.get_json()["data"]
    assert r.status_code == 201 and d["event"]["latitude"] == 22.57 and len(d["contacts"]) == 1 and "No SMS" in d["notice"]
    assert client.post("/api/emergency/sos", headers=alice, json={}).status_code == 201
    ev = client.get("/api/emergency/events", headers=alice).get_json()["data"]
    assert len(ev) == 2 and ev[0]["latitude"] is None and ev[1]["latitude"] == 22.57


def test_sos_validation(client, alice):
    for bad in ({"latitude": 10}, {"longitude": 10}, {"latitude": 91, "longitude": 0}, {"latitude": 0, "longitude": 181},
                {"latitude": "a", "longitude": "b"}, {"latitude": True, "longitude": False}):
        assert client.post("/api/emergency/sos", headers=alice, json=bad).status_code == 400, bad
    assert client.get("/api/emergency/events", headers=alice).get_json()["data"] == []
