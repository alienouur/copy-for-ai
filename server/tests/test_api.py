import os

import httpx
import pytest

from app import signing

os.environ["LICENSE_PRIVATE_KEY"] = signing.generate_private_key_pem()
os.environ["STRIPE_RESTRICTED_KEY"] = "rk_test_dummy"

from app import main  # noqa: E402  (needs env set first)
from app.stripe_client import StripeClient  # noqa: E402

PAID = {
    "id": "cs_test_abc123456789",
    "payment_status": "paid",
    "customer_details": {"email": "Buyer@Example.com"},
    "line_items": {"data": [{"price": {"id": "price_1"}}]},
}
UNPAID = {**PAID, "id": "cs_test_unpaid", "payment_status": "unpaid"}


def make_stripe(routes: dict, price_id: str = ""):
    def handler(req: httpx.Request):
        body = routes.get(req.url.path)
        if body is None:
            return httpx.Response(404, json={"error": {"message": "nope"}})
        return httpx.Response(200, json=body)

    c = StripeClient("rk_test", price_id)
    c.http = httpx.AsyncClient(base_url="https://api.stripe.com/v1", transport=httpx.MockTransport(handler))
    return c


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "_hits", main._hits.__class__(list))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t")


def test_sign_roundtrip():
    key = signing.load_private_key(os.environ["LICENSE_PRIVATE_KEY"])
    k = signing.issue_key(key, "A@b.co", "cs_test_abc123456789")
    payload = signing.verify_key(key, k)
    assert payload["e"] == "a@b.co" and payload["r"] == "abc123456789"
    with pytest.raises(Exception):
        signing.verify_key(key, k[:-2] + "AA")


@pytest.mark.anyio
async def test_from_session_paid(client, monkeypatch):
    monkeypatch.setattr(main, "_stripe", make_stripe({"/v1/checkout/sessions/cs_test_abc123456789": PAID}))
    r = await client.post("/v1/license/from-session", json={"session_id": "cs_test_abc123456789"})
    assert r.status_code == 200
    data = r.json()
    assert data["email"] == "Buyer@Example.com"
    payload = signing.verify_key(main._signing_key, data["license_key"])
    assert payload["e"] == "buyer@example.com"


@pytest.mark.anyio
async def test_from_session_unpaid_or_missing(client, monkeypatch):
    monkeypatch.setattr(main, "_stripe", make_stripe({"/v1/checkout/sessions/cs_test_unpaid": UNPAID}))
    r = await client.post("/v1/license/from-session", json={"session_id": "cs_test_unpaid"})
    assert r.status_code == 404
    r = await client.post("/v1/license/from-session", json={"session_id": "cs_test_missing"})
    assert r.status_code == 404
    r = await client.post("/v1/license/from-session", json={"session_id": "garbage"})
    assert r.status_code == 404


@pytest.mark.anyio
async def test_price_restriction(client, monkeypatch):
    monkeypatch.setattr(main, "_stripe", make_stripe({"/v1/checkout/sessions/cs_test_abc123456789": PAID}, "price_other"))
    r = await client.post("/v1/license/from-session", json={"session_id": "cs_test_abc123456789"})
    assert r.status_code == 404


@pytest.mark.anyio
async def test_recover_by_email(client, monkeypatch):
    monkeypatch.setattr(main, "_stripe", make_stripe({"/v1/checkout/sessions": {"data": [UNPAID, PAID]}}))
    r = await client.post("/v1/license/recover", json={"email": " buyer@example.com "})
    assert r.status_code == 200
    assert signing.verify_key(main._signing_key, r.json()["license_key"])["r"] == "abc123456789"


@pytest.mark.anyio
async def test_recover_invalid_and_missing(client, monkeypatch):
    monkeypatch.setattr(main, "_stripe", make_stripe({"/v1/checkout/sessions": {"data": []}}))
    r = await client.post("/v1/license/recover", json={"email": "not-an-email"})
    assert r.status_code == 400
    r = await client.post("/v1/license/recover", json={"email": "x@y.io"})
    assert r.status_code == 404


@pytest.mark.anyio
async def test_rate_limit(client, monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT", 2)
    monkeypatch.setattr(main, "_stripe", make_stripe({}))
    for _ in range(2):
        await client.post("/v1/license/recover", json={"email": "x@y.io"})
    r = await client.post("/v1/license/recover", json={"email": "x@y.io"})
    assert r.status_code == 429


@pytest.mark.anyio
async def test_public_key_and_health(client):
    r = await client.get("/v1/public-key")
    assert r.json()["crv"] == "P-256"
    assert (await client.get("/healthz")).json()["configured"] is True
