import os
import re
import time
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .gemini import GeminiClient, GeminiError
from .signing import issue_key, load_private_key, public_jwk, verify_key
from .stripe_client import StripeClient, StripeError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

STRIPE_KEY = os.environ.get("STRIPE_RESTRICTED_KEY", "")
PRIVATE_KEY_PEM = os.environ.get("LICENSE_PRIVATE_KEY", "").replace("\\n", "\n")
PRICE_ID = os.environ.get("STRIPE_PRICE_ID", "")
RATE_LIMIT = int(os.environ.get("RATE_LIMIT_PER_HOUR", "30"))
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
FREE_DAILY_LIMIT = int(os.environ.get("FREE_DAILY_LIMIT", "5"))
# Per-IP cap for free usage; high enough that a shared school/campus NAT is not blocked.
FREE_IP_DAILY_LIMIT = int(os.environ.get("FREE_IP_DAILY_LIMIT", "150"))
PRO_DAILY_LIMIT = int(os.environ.get("PRO_DAILY_LIMIT", "300"))
PLAN_CACHE_SECONDS = int(os.environ.get("PLAN_CACHE_SECONDS", str(6 * 3600)))
MAX_TEXT_CHARS = 40_000
MAX_IMAGE_B64_CHARS = 3_000_000  # ~2.2 MB of JPEG

app = FastAPI(title="Copy for AI API", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST", "GET"], allow_headers=["*"])

_signing_key = load_private_key(PRIVATE_KEY_PEM) if PRIVATE_KEY_PEM else None
_stripe = StripeClient(STRIPE_KEY, PRICE_ID) if STRIPE_KEY else None
_gemini = GeminiClient(GEMINI_KEY, GEMINI_MODEL) if GEMINI_KEY else None
_hits: dict[str, list[float]] = defaultdict(list)
_daily: dict[str, tuple[str, int]] = {}  # quota key -> (utc day, count)
_plan_cache: dict[str, tuple[float, bool]] = {}  # email -> (expires, is_pro)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else "?")


def _rate_limit(request: Request) -> None:
    ip = _client_ip(request)
    now = time.time()
    hits = [t for t in _hits[ip] if now - t < 3600]
    if len(hits) >= RATE_LIMIT:
        raise HTTPException(429, "Too many requests, try again later")
    hits.append(now)
    _hits[ip] = hits


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _used_today(key: str) -> int:
    day, count = _daily.get(key, ("", 0))
    return count if day == _today() else 0


def _consume(key: str) -> None:
    _daily[key] = (_today(), _used_today(key) + 1)


def _ready() -> None:
    if not _signing_key or not _stripe:
        raise HTTPException(503, "License service not configured")


def _license_email(license_key: str | None) -> str | None:
    """Returns the email inside a validly signed key, else None."""
    if not license_key or not _signing_key:
        return None
    try:
        return verify_key(_signing_key, license_key).get("e") or None
    except Exception:
        return None


async def _is_pro(email: str) -> bool:
    now = time.time()
    cached = _plan_cache.get(email)
    if cached and cached[0] > now:
        return cached[1]
    try:
        pro = await _stripe.has_active_plan(email) if _stripe else False
    except StripeError:
        # Don't lock paying users out because of a Stripe hiccup; re-check soon.
        pro = cached[1] if cached else True
        _plan_cache[email] = (now + 300, pro)
        return pro
    _plan_cache[email] = (now + PLAN_CACHE_SECONDS, pro)
    return pro


class SessionBody(BaseModel):
    session_id: str


class EmailBody(BaseModel):
    email: str


class MeBody(BaseModel):
    license_key: str | None = None
    device_id: str


class SolveBody(MeBody):
    text: str = ""
    image: str | None = None  # base64 (no data: prefix)
    image_mime: str = "image/jpeg"
    question: str = ""
    mode: str = "answer"  # answer | explain


async def _resolve_plan(body: MeBody, request: Request) -> dict:
    if not DEVICE_RE.match(body.device_id):
        raise HTTPException(400, "Bad device id")
    email = _license_email(body.license_key)
    if email and await _is_pro(email):
        key = f"pro:{email}"
        return {"plan": "pro", "email": email, "limit": PRO_DAILY_LIMIT, "keys": [key], "used": _used_today(key)}
    dev_key, ip_key = f"dev:{body.device_id}", f"ip:{_client_ip(request)}"
    used = _used_today(dev_key)
    if _used_today(ip_key) >= FREE_IP_DAILY_LIMIT:
        used = FREE_DAILY_LIMIT
    return {
        "plan": "free",
        "email": email,
        "limit": FREE_DAILY_LIMIT,
        "keys": [dev_key, ip_key],
        "used": used,
        "expired": bool(email),
    }


@app.get("/")
@app.get("/healthz")
async def healthz():
    return {"ok": True, "configured": bool(_signing_key and _stripe), "solver": bool(_gemini)}


@app.post("/v1/me")
async def me(body: MeBody, request: Request):
    plan = await _resolve_plan(body, request)
    return {
        "plan": plan["plan"],
        "remaining": max(0, plan["limit"] - plan["used"]),
        "limit": plan["limit"],
        "expired": plan.get("expired", False),
    }


@app.post("/v1/solve")
async def solve(body: SolveBody, request: Request):
    if not _gemini:
        raise HTTPException(503, "Answer service not configured")
    if body.mode not in ("answer", "explain"):
        raise HTTPException(400, "mode must be 'answer' or 'explain'")
    if body.image and (len(body.image) > MAX_IMAGE_B64_CHARS or body.image_mime not in ("image/jpeg", "image/png", "image/webp")):
        raise HTTPException(413, "Screenshot too large")
    text = body.text.strip()[:MAX_TEXT_CHARS]
    question = body.question.strip()[:2000]
    if not text and not body.image and not question:
        raise HTTPException(400, "Nothing to solve: no page text or screenshot was captured")

    plan = await _resolve_plan(body, request)
    remaining = plan["limit"] - plan["used"]
    if remaining <= 0:
        if plan["plan"] == "pro":
            raise HTTPException(429, "Daily fair-use limit reached. It resets at midnight UTC.")
        raise HTTPException(402, "You've used today's free answers. Upgrade to Pro for unlimited answers.")

    try:
        answer = await _gemini.solve(text, body.image, body.image_mime, question, body.mode)
    except GeminiError as e:
        raise HTTPException(e.status, str(e))

    for k in plan["keys"]:
        _consume(k)
    return {"answer": answer, "plan": plan["plan"], "remaining": remaining - 1, "model": GEMINI_MODEL}


@app.get("/v1/public-key")
async def get_public_key():
    if not _signing_key:
        raise HTTPException(503, "Not configured")
    return public_jwk(_signing_key)


@app.post("/v1/license/from-session")
async def license_from_session(body: SessionBody, request: Request):
    _ready()
    _rate_limit(request)
    try:
        purchase = await _stripe.purchase_from_session(body.session_id.strip())
    except StripeError as e:
        raise HTTPException(502, f"Payment provider error: {e}")
    if not purchase:
        raise HTTPException(404, "No completed purchase found for this checkout session")
    return {"license_key": issue_key(_signing_key, purchase.email, purchase.ref), "email": purchase.email}


@app.post("/v1/license/recover")
async def license_recover(body: EmailBody, request: Request):
    _ready()
    _rate_limit(request)
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address")
    try:
        purchase = await _stripe.purchase_from_email(email)
    except StripeError as e:
        raise HTTPException(502, f"Payment provider error: {e}")
    if not purchase:
        raise HTTPException(404, "No purchase found for this email. Use the email from your Stripe receipt.")
    return {"license_key": issue_key(_signing_key, purchase.email, purchase.ref), "email": purchase.email}
