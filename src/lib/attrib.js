import { PRO_CHECKOUT_URL } from "./config.js";

const MAX_SOURCE = 60;

export async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const id = crypto.randomUUID().replace(/-/g, "");
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

export function cleanSource(raw) {
  return String(raw || "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SOURCE);
}

/** Where this install came from (utm/ref captured by the landing page), "" when unknown. */
export async function getSource() {
  const { source } = await chrome.storage.local.get("source");
  return source || "";
}

/** Stores the acquisition source once (first touch wins). Returns the stored value. */
export async function rememberSource(raw) {
  const source = cleanSource(raw);
  if (!source) return "";
  const existing = await getSource();
  if (existing) return existing;
  await chrome.storage.local.set({ source });
  return source;
}

/** Checkout link tagged with device + source so paid conversions show up per channel in Stripe. */
export async function checkoutUrl() {
  const ref = `${await getDeviceId()}_${(await getSource()) || "direct"}`;
  return `${PRO_CHECKOUT_URL}?client_reference_id=${encodeURIComponent(ref)}`;
}
