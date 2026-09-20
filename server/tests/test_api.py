import json
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


# ---------------------------------------------------------------- solve / plans


def make_gemini(answer: str = "B) 42", status: int = 200, calls: list | None = None, chunks: list[str] | None = None):
    from app.gemini import GeminiClient

    def candidate(text: str) -> dict:
        return {"candidates": [{"content": {"parts": [{"text": "thinking", "thought": True}, {"text": text}]}}]}

    def handler(req: httpx.Request):
        if calls is not None:
            calls.append(req)
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "boom"}})
        if req.url.path.endswith(":streamGenerateContent"):
            body = "".join(f"data: {json.dumps(candidate(c))}\r\n\r\n" for c in (chunks or [answer]))
            return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=candidate(answer))

    g = GeminiClient("k")
    g.http = httpx.AsyncClient(base_url="https://generativelanguage.googleapis.com/v1beta", transport=httpx.MockTransport(handler))
    return g


SUB_SESSION = {**PAID, "id": "cs_test_sub", "subscription": "sub_1"}
DEVICE = {"device_id": "device-12345678"}


@pytest.fixture
def solve_env(monkeypatch):
    monkeypatch.setattr(main, "_daily", {})
    monkeypatch.setattr(main, "_plan_cache", {})
    monkeypatch.setattr(main, "FREE_DAILY_LIMIT", 2)
    monkeypatch.setattr(main, "_gemini", make_gemini())


@pytest.mark.anyio
async def test_solve_free_quota_and_answer(client, solve_env, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "_gemini", make_gemini(calls=calls))
    r = await client.post("/v1/solve", json={**DEVICE, "text": "What is 6*7? A) 40 B) 42", "mode": "answer"})
    assert r.status_code == 200
    assert r.json() == {"answer": "B) 42", "plan": "free", "remaining": 1, "model": main.GEMINI_MODEL}
    sent = calls[0].read().decode()
    assert "PAGE TEXT" in sent and "OUTPUT ONLY THE FINAL ANSWERS" in sent

    r = await client.post("/v1/solve", json={**DEVICE, "image": "aGVsbG8=", "mode": "explain"})
    assert r.status_code == 200 and r.json()["remaining"] == 0
    assert "inline_data" in calls[1].read().decode()

    r = await client.post("/v1/solve", json={**DEVICE, "text": "again"})
    assert r.status_code == 402
    assert len(calls) == 2  # quota exhausted -> no Gemini call

    r = await client.post("/v1/me", json=DEVICE)
    assert r.json() == {"plan": "free", "remaining": 0, "limit": 2, "expired": False}


@pytest.mark.anyio
async def test_solve_validation(client, solve_env):
    r = await client.post("/v1/solve", json={**DEVICE})
    assert r.status_code == 400
    r = await client.post("/v1/solve", json={**DEVICE, "text": "x", "mode": "essay"})
    assert r.status_code == 400
    r = await client.post("/v1/solve", json={"device_id": "short", "text": "x"})
    assert r.status_code == 400
    r = await client.post("/v1/solve", json={**DEVICE, "image": "a" * (main.MAX_IMAGE_B64_CHARS + 1)})
    assert r.status_code == 413


@pytest.mark.anyio
async def test_solve_gemini_down(client, solve_env, monkeypatch):
    monkeypatch.setattr(main, "_gemini", make_gemini(status=503))
    r = await client.post("/v1/solve", json={**DEVICE, "text": "q"})
    assert r.status_code == 503
    assert (await client.post("/v1/me", json=DEVICE)).json()["remaining"] == 2  # failure not charged


@pytest.mark.anyio
async def test_solve_pro_subscription(client, solve_env, monkeypatch):
    key = signing.issue_key(main._signing_key, "buyer@example.com", "cs_test_sub")
    active = {"/v1/checkout/sessions": {"data": [SUB_SESSION]}, "/v1/subscriptions/sub_1": {"status": "active"}}
    monkeypatch.setattr(main, "_stripe", make_stripe(active))
    body = {**DEVICE, "license_key": key, "text": "q"}
    for _ in range(3):  # exceeds the free limit of 2
        r = await client.post("/v1/solve", json=body)
        assert r.status_code == 200 and r.json()["plan"] == "pro"
    me = (await client.post("/v1/me", json={**DEVICE, "license_key": key})).json()
    assert me["plan"] == "pro" and me["remaining"] == main.PRO_DAILY_LIMIT - 3

    # Canceled subscription -> back to free, flagged as expired
    main._plan_cache.clear()
    canceled = {**active, "/v1/subscriptions/sub_1": {"status": "canceled"}}
    monkeypatch.setattr(main, "_stripe", make_stripe(canceled))
    me = (await client.post("/v1/me", json={**DEVICE, "license_key": key})).json()
    assert me["plan"] == "free" and me["expired"] is True

    # Lifetime (one-time) purchase still counts as pro
    main._plan_cache.clear()
    monkeypatch.setattr(main, "_stripe", make_stripe({"/v1/checkout/sessions": {"data": [PAID]}}))
    assert (await client.post("/v1/me", json={**DEVICE, "license_key": key})).json()["plan"] == "pro"

    # Tampered key -> free
    r = await client.post("/v1/me", json={**DEVICE, "license_key": key[:-3] + "AAA"})
    assert r.json()["plan"] == "free" and r.json()["expired"] is False


def parse_sse(raw: str) -> list[dict]:
    return [json.loads(line[5:]) for line in raw.splitlines() if line.startswith("data:")]


@pytest.mark.anyio
async def test_solve_stream(client, solve_env, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "_gemini", make_gemini(calls=calls, chunks=["B) ", "42"]))
    r = await client.post("/v1/solve", json={**DEVICE, "text": "6*7?", "mode": "answer", "stream": True})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(r.text)
    assert [e.get("delta") for e in events[:-1]] == ["B) ", "42"]
    assert events[-1] == {"done": True, "plan": "free", "remaining": 1, "model": main.GEMINI_MODEL}
    assert calls[0].url.path.endswith(":streamGenerateContent") and calls[0].url.params["alt"] == "sse"
    assert (await client.post("/v1/me", json=DEVICE)).json()["remaining"] == 1

    # Upstream rejection before the first token is a plain HTTP error and is not charged
    monkeypatch.setattr(main, "_gemini", make_gemini(status=503))
    r = await client.post("/v1/solve", json={**DEVICE, "text": "q", "stream": True})
    assert r.status_code == 503
    assert (await client.post("/v1/me", json=DEVICE)).json()["remaining"] == 1


@pytest.mark.anyio
async def test_solve_follow_up_history(client, solve_env, monkeypatch):
    calls = []
    monkeypatch.setattr(main, "_gemini", make_gemini(answer="Because 6×7=42.", calls=calls))
    history = [
        {"role": "user", "text": "Solve the questions on this page."},
        {"role": "model", "text": "B) 42"},
    ]
    r = await client.post(
        "/v1/solve",
        json={**DEVICE, "text": "What is 6*7? A) 40 B) 42", "question": "why?", "mode": "explain", "history": history},
    )
    assert r.status_code == 200 and r.json()["answer"] == "Because 6×7=42."
    sent = json.loads(calls[0].read())
    roles = [c["role"] for c in sent["contents"]]
    assert roles == ["user", "model", "user"]
    assert "PAGE TEXT" in sent["contents"][0]["parts"][0]["text"]
    assert sent["contents"][1]["parts"][0]["text"] == "B) 42"
    assert sent["contents"][2]["parts"][0]["text"] == "why?"
    assert "step-by-step" in sent["contents"][2]["parts"][1]["text"]

    r = await client.post("/v1/solve", json={**DEVICE, "text": "q", "history": [{"role": "user", "text": "x" * 9000}]})
    assert r.status_code == 422


@pytest.mark.anyio
async def test_solve_fill_structured(client, solve_env, monkeypatch):
    calls = []
    raw = json.dumps({"answers": [{"id": "q1", "option_ids": ["q1-1"], "text": "42"}, {"id": "q2", "text": "x = 2"}, "junk"]})
    monkeypatch.setattr(main, "_gemini", make_gemini(answer=raw, calls=calls))
    text = "Q q1 [choice]: 6*7?\n- q1-0: 40\n- q1-1: 42\nQ q2 [text]: Solve x+1=3"
    r = await client.post("/v1/solve", json={**DEVICE, "text": text, "mode": "fill", "stream": True})
    assert r.status_code == 200
    assert r.json() == {
        "answers": [{"id": "q1", "option_ids": ["q1-1"], "text": "42"}, {"id": "q2", "option_ids": [], "text": "x = 2"}],
        "plan": "free",
        "remaining": 1,
        "model": main.GEMINI_MODEL,
    }
    sent = json.loads(calls[0].read())
    assert calls[0].url.path.endswith(":generateContent")
    assert sent["generationConfig"]["responseMimeType"] == "application/json"
    assert sent["generationConfig"]["responseSchema"]["required"] == ["answers"]
    assert "return JSON only" in sent["contents"][0]["parts"][-1]["text"]

    monkeypatch.setattr(main, "_gemini", make_gemini(answer="not json"))
    r = await client.post("/v1/solve", json={**DEVICE, "text": text, "mode": "fill"})
    assert r.status_code == 422
    assert (await client.post("/v1/me", json=DEVICE)).json()["remaining"] == 1  # malformed answers not charged
