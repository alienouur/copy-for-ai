import { FREE_PRO_TRIALS, LICENSE_API_URL, LICENSE_PUBLIC_KEY_JWK } from "./config.js";
import { getSettings, saveSettings } from "./settings.js";

const PREFIX = "CFA1";
const ALGO = { name: "ECDSA", namedCurve: "P-256" };

function b64uDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

let publicKeyPromise;
function publicKey() {
  publicKeyPromise ||= crypto.subtle.importKey("jwk", LICENSE_PUBLIC_KEY_JWK, ALGO, false, ["verify"]);
  return publicKeyPromise;
}

/** Verifies a signed key offline. Returns the payload {e: email, r: ref, t: issuedAt} or null. */
export async function verifyKey(key) {
  const parts = String(key || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const body = b64uDecode(parts[1]);
    const sig = b64uDecode(parts[2]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(), sig, body);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(body));
    return typeof payload.e === "string" && typeof payload.r === "string" ? payload : null;
  } catch {
    return null;
  }
}

export async function getLicense() {
  const { license } = await chrome.storage.sync.get("license");
  return license || null;
}

export async function isPro() {
  const license = await getLicense();
  return !!license && license.status === "active";
}

export async function activate(key) {
  const trimmed = String(key || "").trim();
  const payload = await verifyKey(trimmed);
  if (!payload) return { ok: false, error: "Invalid license key. Paste the full key starting with CFA1." };
  const license = { key: trimmed, status: "active", email: payload.e, issuedAt: payload.t * 1000, checkedAt: Date.now() };
  await chrome.storage.sync.set({ license });
  return { ok: true, license };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The license server may be asleep on first contact; keep retrying for ~1 min.
async function api(path, body, attempts = 20) {
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(`${LICENSE_API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      break;
    } catch {
      if (i >= attempts - 1) {
        return { error: "Could not reach the license server. Check your connection and try again." };
      }
      await sleep(3000);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.detail || `HTTP ${res.status}` };
  return data;
}

/** Fetches the key for a finished Stripe Checkout session and activates it. */
export async function activateFromSession(sessionId) {
  const data = await api("/v1/license/from-session", { session_id: sessionId });
  if (data.error) return { ok: false, error: data.error };
  return activate(data.license_key);
}

/** Looks up the purchase by receipt email, then activates the returned key. */
export async function recover(email) {
  const data = await api("/v1/license/recover", { email });
  if (data.error) return { ok: false, error: data.error };
  return activate(data.license_key);
}

export async function deactivate() {
  await chrome.storage.sync.remove("license");
}

/** Returns {allowed, trialsLeft}. Consumes a trial for free users when `consume` is true. */
export async function checkProAccess(consume) {
  if (await isPro()) return { allowed: true, pro: true, trialsLeft: Infinity };
  const settings = await getSettings();
  const trialsLeft = Math.max(0, FREE_PRO_TRIALS - settings.proTrialsUsed);
  if (trialsLeft === 0) return { allowed: false, pro: false, trialsLeft: 0 };
  if (consume) await saveSettings({ proTrialsUsed: settings.proTrialsUsed + 1 });
  return { allowed: true, pro: false, trialsLeft: consume ? trialsLeft - 1 : trialsLeft };
}
