import os
import re
import time
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .signing import issue_key, load_private_key, public_jwk
from .stripe_client import StripeClient, StripeError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

STRIPE_KEY = os.environ.get("STRIPE_RESTRICTED_KEY", "")
PRIVATE_KEY_PEM = os.environ.get("LICENSE_PRIVATE_KEY", "").replace("\\n", "\n")
PRICE_ID = os.environ.get("STRIPE_PRICE_ID", "")
RATE_LIMIT = int(os.environ.get("RATE_LIMIT_PER_HOUR", "30"))

app = FastAPI(title="Copy for AI license API", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST", "GET"], allow_headers=["*"])

_signing_key = load_private_key(PRIVATE_KEY_PEM) if PRIVATE_KEY_PEM else None
_stripe = StripeClient(STRIPE_KEY, PRICE_ID) if STRIPE_KEY else None
_hits: dict[str, list[float]] = defaultdict(list)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _rate_limit(request: Request) -> None:
    ip = request.headers.get("fly-client-ip") or (request.client.host if request.client else "?")
    now = time.time()
    hits = [t for t in _hits[ip] if now - t < 3600]
    if len(hits) >= RATE_LIMIT:
        raise HTTPException(429, "Too many requests, try again later")
    hits.append(now)
    _hits[ip] = hits


def _ready() -> None:
    if not _signing_key or not _stripe:
        raise HTTPException(503, "License service not configured")


class SessionBody(BaseModel):
    session_id: str


class EmailBody(BaseModel):
    email: str


@app.get("/")
@app.get("/healthz")
async def healthz():
    return {"ok": True, "configured": bool(_signing_key and _stripe)}


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
