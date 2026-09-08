import { FREE_PRO_TRIALS, LICENSE_RECHECK_MS, LS_STORE_ID } from "./config.js";
import { getSettings, saveSettings } from "./settings.js";

const API = "https://api.lemonsqueezy.com/v1/licenses";

async function call(endpoint, params) {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
}

export async function getLicense() {
  const { license } = await chrome.storage.sync.get("license");
  return license || null;
}

export async function isPro() {
  const license = await getLicense();
  if (!license || license.status !== "active") return false;
  if (Date.now() - (license.checkedAt || 0) > LICENSE_RECHECK_MS) {
    revalidate(license).catch(() => {});
  }
  return true;
}

export async function activate(key) {
  const instanceName = `chrome-${navigator.platform || "browser"}-${Math.random().toString(36).slice(2, 8)}`;
  const data = await call("activate", { license_key: key.trim(), instance_name: instanceName });
  if (!data.activated) {
    return { ok: false, error: data.error || "Invalid license key" };
  }
  if (LS_STORE_ID && String(data.meta?.store_id) !== LS_STORE_ID) {
    await call("deactivate", { license_key: key.trim(), instance_id: data.instance.id });
    return { ok: false, error: "This key belongs to a different product" };
  }
  const license = {
    key: key.trim(),
    instanceId: data.instance.id,
    status: data.license_key.status,
    expiresAt: data.license_key.expires_at,
    email: data.meta?.customer_email || "",
    checkedAt: Date.now(),
  };
  await chrome.storage.sync.set({ license });
  return { ok: true, license };
}

export async function revalidate(license) {
  const data = await call("validate", { license_key: license.key, instance_id: license.instanceId });
  const status = data.valid ? "active" : (data.license_key?.status || "inactive");
  const next = { ...license, status, checkedAt: Date.now() };
  await chrome.storage.sync.set({ license: next });
  return next;
}

export async function deactivate() {
  const license = await getLicense();
  if (license) {
    await call("deactivate", { license_key: license.key, instance_id: license.instanceId }).catch(() => {});
  }
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
