import httpx

API = "https://api.stripe.com/v1"
PAID_STATUSES = {"paid", "no_payment_required"}


class StripeError(Exception):
    pass


class Purchase:
    def __init__(self, email: str, ref: str):
        self.email = email
        self.ref = ref


class StripeClient:
    def __init__(self, restricted_key: str, price_id: str = ""):
        self.key = restricted_key
        self.price_id = price_id
        self.http = httpx.AsyncClient(base_url=API, auth=(restricted_key, ""), timeout=15)

    async def _get(self, path: str, params: dict | None = None) -> dict:
        res = await self.http.get(path, params=params)
        if res.status_code == 404:
            return {}
        if res.status_code >= 400:
            raise StripeError(res.json().get("error", {}).get("message", f"HTTP {res.status_code}"))
        return res.json()

    def _matches_price(self, session: dict) -> bool:
        if not self.price_id:
            return True
        items = (session.get("line_items") or {}).get("data") or []
        return any((it.get("price") or {}).get("id") == self.price_id for it in items)

    def _purchase_from_session(self, session: dict) -> Purchase | None:
        if not session or session.get("payment_status") not in PAID_STATUSES:
            return None
        if not self._matches_price(session):
            return None
        email = (session.get("customer_details") or {}).get("email") or session.get("customer_email") or ""
        return Purchase(email=email, ref=session["id"])

    async def purchase_from_session(self, session_id: str) -> Purchase | None:
        if not session_id.startswith("cs_"):
            return None
        session = await self._get(f"/checkout/sessions/{session_id}", {"expand[]": "line_items"})
        return self._purchase_from_session(session)

    async def purchase_from_email(self, email: str) -> Purchase | None:
        data = await self._get(
            "/checkout/sessions",
            {"customer_details[email]": email, "limit": 20, "expand[]": "data.line_items"},
        )
        for session in data.get("data") or []:
            p = self._purchase_from_session(session)
            if p:
                return p
        return None
