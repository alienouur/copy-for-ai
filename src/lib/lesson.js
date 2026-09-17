// "Solve whole lesson" agent: splits the page into parts (text chunks, or one screenshot per screen when the
// page can't be read), solves them one after another in the background worker and writes progress to
// chrome.storage.session so the side panel can show it and pick up the result even if it was closed.
import { api, captureTab, getDeviceId, hasPageAccess, readTab } from "./solver.js";
import { getLicense } from "./license.js";
import { getSettings } from "./settings.js";

export const LESSON_PROMPT = "Solve the whole lesson on this page.";
const FULL_TEXT_CHARS = 240_000;
const CHUNK_CHARS = 12_000;
const MAX_SHOTS = 8;
const SHOT_SETTLE_MS = 450;

export const jobKey = (tabId) => `job:${tabId}`;
export const threadKey = (tabId) => `thread:${tabId}`;

export async function loadJob(tabId) {
  const stored = await chrome.storage.session.get(jobKey(tabId));
  return stored[jobKey(tabId)] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Splits lesson text into ~CHUNK_CHARS pieces, preferring to cut before headings / numbered exercises. */
export function chunkText(text, size = CHUNK_CHARS) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  let lastBoundary = -1; // index in `current` where the most recent heading/exercise line starts
  const isBoundary = (line) => /^(#{1,6}\s|\s*\d{1,3}[.)]\s|\s*(Exercise|Exercice|Question|Problem|Task|Q)\s*\d)/i.test(line);
  for (const line of lines) {
    if (isBoundary(line)) lastBoundary = current.length;
    if (current.length + line.length + 1 > size && current.length > size / 3) {
      if (lastBoundary > size / 4) {
        chunks.push(current.slice(0, lastBoundary).trimEnd());
        current = current.slice(lastBoundary);
      } else {
        chunks.push(current.trimEnd());
        current = "";
      }
      lastBoundary = -1;
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.length ? chunks : [text];
}

/** Scrolls through the page capturing one screenshot per screen, then restores the scroll position. */
async function captureWholePage(tab, onProgress) {
  const [{ result: dims }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      viewport: window.innerHeight,
      y: window.scrollY,
    }),
  });
  const total = Math.min(MAX_SHOTS, Math.max(1, Math.ceil(dims.height / Math.max(1, dims.viewport))));
  const shots = [];
  try {
    for (let i = 0; i < total; i++) {
      onProgress?.(`Capturing screen ${i + 1} of ${total}…`);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (y) => window.scrollTo(0, y), args: [i * dims.viewport] });
      await sleep(SHOT_SETTLE_MS);
      const shot = await captureTab(tab);
      if (shot) shots.push(shot);
    }
  } finally {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (y) => window.scrollTo(0, y), args: [dims.y] }).catch(() => {});
  }
  return shots;
}

/** Plans the parts of the job: {text, image}[] plus what they were built from. */
export async function planLesson(tab, { screenshot, onProgress }) {
  onProgress?.("Reading the lesson…");
  const page = await readTab(tab, { maxChars: FULL_TEXT_CHARS });
  if (page) {
    const chunks = chunkText(page.text);
    const parts = chunks.map((text) => ({ text, image: null }));
    if (screenshot && chunks.length === 1) parts[0].image = await captureTab(tab);
    return { parts, source: page.usedSelection ? "selected text" : "page text" };
  }
  if (!(await hasPageAccess(tab))) {
    throw new Error("Copy for AI can't see this page yet. Click its toolbar icon once, or allow access to all sites, then try again.");
  }
  const shots = await captureWholePage(tab, onProgress);
  if (!shots.length) throw new Error("This page can't be read or captured. Open the lesson in a normal tab and try again.");
  return { parts: shots.map((image) => ({ text: "", image })), source: `${shots.length} screenshot${shots.length > 1 ? "s" : ""}` };
}

function partQuestion(i, n, mode) {
  const scope = n > 1 ? `This is part ${i + 1} of ${n} of the lesson. ` : "";
  const style = mode === "answer" ? "Give only the final answers." : "Give the answers with concise step-by-step working.";
  return `${scope}Solve every exercise, question and task in this part, in order, numbered exactly as in the lesson. Skip nothing. ${style}`;
}

export function compileAnswers(results) {
  if (results.length === 1) return results[0];
  return results.map((r, i) => `### Part ${i + 1}\n\n${r}`).join("\n\n");
}

const active = new Map(); // tabId -> { cancelled: boolean }

export function cancelLesson(tabId) {
  const job = active.get(tabId);
  if (job) job.cancelled = true;
}

export function isLessonRunning(tabId) {
  return active.has(tabId);
}

/**
 * Runs the whole-lesson job for a tab. Resolves with the finished job record (status "done" | "error" | "cancelled").
 * Progress is written to storage.session[job:<tabId>] and the final answer is appended to the tab's thread.
 */
export async function runLesson(tab, { mode }) {
  if (active.has(tab.id)) return loadJob(tab.id);
  const state = { cancelled: false };
  active.set(tab.id, state);
  const job = { status: "running", tabId: tab.id, url: tab.url || "", title: tab.title || "", mode, step: 0, total: 0, message: "Starting…", startedAt: Date.now() };
  const save = (patch) => {
    Object.assign(job, patch);
    return chrome.storage.session.set({ [jobKey(tab.id)]: job });
  };
  await save({});
  // Extension API calls reset the service worker's idle timer, so ping storage while a long request is in flight.
  const keepAlive = setInterval(() => chrome.storage.session.get("keepalive").catch(() => {}), 20_000);
  const results = [];
  let meta = {};
  try {
    const { sendScreenshot } = await getSettings();
    const { parts, source } = await planLesson(tab, { screenshot: sendScreenshot, onProgress: (message) => save({ message }) });
    await save({ total: parts.length, source });
    const license = await getLicense();
    const deviceId = await getDeviceId();
    for (let i = 0; i < parts.length; i++) {
      if (state.cancelled) break;
      await save({ step: i + 1, message: `Solving part ${i + 1} of ${parts.length}…` });
      const data = await api("/v1/solve", {
        device_id: deviceId,
        license_key: license?.key || null,
        text: parts[i].text,
        image: parts[i].image,
        image_mime: "image/jpeg",
        question: partQuestion(i, parts.length, mode),
        mode,
        history: [],
        stream: false,
      }, { onRetry: () => save({ message: "Waking up the server…" }) });
      results.push((data.answer || "").trim() || "_(no answer for this part)_");
      meta = data;
    }
    if (results.length) await appendToThread(tab, job, results, meta);
    if (state.cancelled) await save({ status: "cancelled", message: `Stopped after ${results.length} of ${job.total} parts.`, results: results.length });
    else await save({ status: "done", message: `Done · ${results.length} part${results.length > 1 ? "s" : ""} solved`, results: results.length, remaining: meta.remaining, plan: meta.plan });
  } catch (err) {
    if (results.length) await appendToThread(tab, job, results, meta).catch(() => {});
    await save({ status: "error", error: err.message || "Something went wrong", errorStatus: err.status || 0, results: results.length });
  } finally {
    clearInterval(keepAlive);
    active.delete(tab.id);
  }
  return job;
}

async function appendToThread(tab, job, results, meta) {
  const stored = await chrome.storage.session.get(threadKey(tab.id));
  const thread = stored[threadKey(tab.id)] || { url: tab.url || "", messages: [] };
  if (thread.url && tab.url && thread.url.split("#")[0] !== tab.url.split("#")[0]) thread.messages = [];
  thread.url = tab.url || thread.url;
  const partial = results.length < job.total ? ` (${results.length} of ${job.total} parts)` : "";
  const remaining = meta.plan === "pro" || meta.remaining == null ? "" : ` · ${meta.remaining} free left today`;
  thread.messages.push(
    { role: "user", text: LESSON_PROMPT },
    { role: "model", text: compileAnswers(results), mode: job.mode, meta: `Agent · ${job.source}${partial}${remaining}. Double-check before submitting.` },
  );
  await chrome.storage.session.set({ [threadKey(tab.id)]: thread });
}
