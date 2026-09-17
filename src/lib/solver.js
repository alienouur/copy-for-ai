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

const ALL_SITES = { origins: ["<all_urls>"] };

/** True when the extension may read the tab without a fresh toolbar click (all-sites grant or activeTab). */
export async function hasPageAccess(tab) {
  if (await chrome.permissions.contains(ALL_SITES)) return true;
  if (!tab.url) return false;
  try {
    return await chrome.permissions.contains({ origins: [new URL(tab.url).origin + "/*"] });
  } catch {
    return false;
  }
}

/** Asks once for access to all sites so the side panel keeps working after reloads and navigation. */
export async function requestPageAccess() {
  if (await chrome.permissions.contains(ALL_SITES)) return true;
  try {
    return await chrome.permissions.request(ALL_SITES);
  } catch {
    return false;
  }
}

/** Reads the page (selection first, then article text). Returns {text, usedSelection} or null when unreadable. */
export async function readTab(tab, { maxChars = MAX_TEXT_CHARS } = {}) {
  if (tab.url && !isSupportedUrl(tab.url)) return null;
  try {
    const doc = await extractFromTab(tab.id, { mode: "auto", includeLinks: false, includeImages: false });
    const text = (doc.markdown || "").trim();
    if (text.length < MIN_USEFUL_TEXT) return null;
    const header = doc.usedSelection ? "" : `Title: ${doc.title}\n\n`;
    return { text: (header + text).slice(0, maxChars), usedSelection: doc.usedSelection };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, body, { attempts = 12, onRetry } = {}) {
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
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.detail || `Server error (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res;
  }
}

/** POSTs JSON to the API, retrying while the (free-tier) server wakes up. */
export async function api(path, body, options = {}) {
  const res = await request(path, body, options);
  return res.json().catch(() => ({}));
}

/**
 * POSTs with stream:true and feeds answer deltas to onDelta as they arrive.
 * Resolves with the final metadata ({plan, remaining, model}) and the full answer.
 * Falls back to a plain JSON response when the server does not stream.
 */
export async function apiStream(path, body, { onDelta, ...options } = {}) {
  const res = await request(path, { ...body, stream: true }, options);
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = await res.json();
    onDelta?.(data.answer || "");
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let meta = null;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (event.error) throw new Error(event.error);
    if (event.delta) {
      answer += event.delta;
      onDelta?.(event.delta, answer);
    }
    if (event.done) meta = event;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) handle(line);
  }
  if (buffer) handle(buffer);
  if (!answer) throw new Error("The answer stream ended without a result. Please try again.");
  return { ...(meta || {}), answer };
}

/**
 * Reads the active tab (text + optional screenshot) and asks the server for the solution.
 * mode: "answer" (final answers only) | "explain".
 * history: earlier [{role, text}] turns when this is a follow-up question about the same page.
 * onDelta(delta, answerSoFar) streams the answer as it is generated.
 */
export async function solveTab({ tab, mode, question = "", screenshot = true, history = [], onProgress, onDelta }) {
  onProgress?.("Reading page…");
  const page = await readTab(tab);
  let image = null;
  if (screenshot || !page) {
    onProgress?.("Capturing screenshot…");
    image = await captureTab(tab);
  }
  if (!page && !image) {
    if (!(await hasPageAccess(tab))) {
      throw new Error("Copy for AI can't see this page yet. Click its toolbar icon once, or allow access to all sites, then try again.");
    }
    if (!question.trim()) {
      throw new Error("This page can't be read or captured. Open the question in a normal tab and try again.");
    }
  }

  const license = await getLicense();
  onProgress?.("Solving…");
  const data = await apiStream("/v1/solve", {
    device_id: await getDeviceId(),
    license_key: license?.key || null,
    text: page?.text || "",
    image,
    image_mime: "image/jpeg",
    question: question.trim(),
    mode,
    history,
  }, { onDelta, onRetry: () => onProgress?.("Waking up the server…") });

  return { ...data, usedSelection: !!page?.usedSelection, usedScreenshot: !!image, hadText: !!page };
}

export async function fetchPlan() {
  const license = await getLicense();
  return api("/v1/me", { device_id: await getDeviceId(), license_key: license?.key || null }, { attempts: 1 });
}
