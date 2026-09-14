import { LICENSE_API_URL } from "./config.js";
import { extractFromTab, isSupportedUrl } from "./extractor.js";
import { getLicense } from "./license.js";

const MAX_TEXT_CHARS = 40_000;
const MIN_USEFUL_TEXT = 80;
const SHOT_MAX_SIDE = 1568;
const SHOT_QUALITY = 0.82;

export async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const id = crypto.randomUUID().replace(/-/g, "");
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

/** Captures the visible tab as a downscaled JPEG. Returns base64 without the data: prefix, or null. */
export async function captureTab(tab) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 });
  } catch {
    return null;
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, SHOT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return dataUrl.split(",")[1];
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: SHOT_QUALITY });
    return (await blobToDataUrl(out)).split(",")[1];
  } catch {
    return dataUrl.split(",")[1];
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Reads the page (selection first, then article text). Returns {text, usedSelection} or null when unreadable. */
export async function readTab(tab) {
  if (!isSupportedUrl(tab.url)) return null;
  try {
    const doc = await extractFromTab(tab.id, { mode: "auto", includeLinks: false, includeImages: false });
    const text = (doc.markdown || "").trim();
    if (text.length < MIN_USEFUL_TEXT) return null;
    const header = doc.usedSelection ? "" : `Title: ${doc.title}\n\n`;
    return { text: (header + text).slice(0, MAX_TEXT_CHARS), usedSelection: doc.usedSelection };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POSTs JSON to the API, retrying while the (free-tier) server wakes up. */
export async function api(path, body, { attempts = 12, onRetry } = {}) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(`${LICENSE_API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      if (i >= attempts - 1) throw new Error("Could not reach the answer server. Check your connection and try again.");
      onRetry?.(i + 1);
      await sleep(3000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || `Server error (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

/**
 * Reads the active tab (text + optional screenshot) and asks the server for the solution.
 * mode: "answer" (final answers only) | "explain".
 */
export async function solveTab({ tab, mode, question = "", screenshot = true, onProgress }) {
  onProgress?.("Reading page…");
  const page = await readTab(tab);
  let image = null;
  if (screenshot || !page) {
    onProgress?.("Capturing screenshot…");
    image = await captureTab(tab);
  }
  if (!page && !image && !question.trim()) {
    throw new Error("This page can't be read or captured. Open the question in a normal tab and try again.");
  }

  const license = await getLicense();
  onProgress?.("Solving…");
  const data = await api("/v1/solve", {
    device_id: await getDeviceId(),
    license_key: license?.key || null,
    text: page?.text || "",
    image,
    image_mime: "image/jpeg",
    question: question.trim(),
    mode,
  }, { onRetry: () => onProgress?.("Waking up the server…") });

  return { ...data, usedSelection: !!page?.usedSelection, usedScreenshot: !!image, hadText: !!page };
}

export async function fetchPlan() {
  const license = await getLicense();
  return api("/v1/me", { device_id: await getDeviceId(), license_key: license?.key || null }, { attempts: 1 });
}
