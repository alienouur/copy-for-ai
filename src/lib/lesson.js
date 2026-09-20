// "Solve whole lesson" agent. It first looks for questions with answer fields on the page (radios, checkboxes,
// selects, text boxes, or plain numbered questions) and answers them in place, batch by batch, on the same tab.
// Pages without recognisable questions fall back to text chunks / one screenshot per screen solved into the panel.
// Everything runs in the background worker with progress in chrome.storage.session so the side panel can show it
// and pick up the result even if it was closed. The agent never submits the form.
import { api, captureTab, getDeviceId, hasPageAccess, readTab } from "./solver.js";
import { getLicense } from "./license.js";
import { getSettings } from "./settings.js";

export const LESSON_PROMPT = "Solve the whole lesson on this page.";
const FULL_TEXT_CHARS = 240_000;
const CHUNK_CHARS = 12_000;
const MAX_SHOTS = 8;
const SHOT_SETTLE_MS = 450;
const BATCH_QUESTIONS = 20;
const BATCH_CHARS = 9_000;

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

/** Injects fill.js into the tab and returns the questions it found ({title, questions}). */
async function scanQuestions(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["fill.js"] });
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__copyForAIFill.scan() });
  return result?.result || { title: "", questions: [] };
}

async function applyAnswers(tabId, answers, questions) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (a, q) => globalThis.__copyForAIFill.apply(a, q),
    args: [answers, questions],
  });
  return result?.result || { filled: 0, shown: 0, missing: answers.length };
}

async function scrollToQuestion(tabId, id) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (qid) => document.querySelector(`[data-cfa-q="${qid}"]`)?.scrollIntoView({ block: "start" }),
    args: [id],
  }).catch(() => {});
  await sleep(SHOT_SETTLE_MS);
}

/** Serialises questions for the fill prompt: "Q <id> [<type>]: text" followed by "- <option id>: text" lines. */
export function describeQuestions(questions) {
  return questions
    .map((q) => {
      const opts = (q.options || []).map((o) => `- ${o.id}: ${o.text}`);
      return [`Q ${q.id} [${q.type}]: ${q.text}`, ...opts].join("\n");
    })
    .join("\n\n");
}

/** Groups questions into request batches of at most BATCH_QUESTIONS / ~BATCH_CHARS each. */
export function batchQuestions(questions, { maxCount = BATCH_QUESTIONS, maxChars = BATCH_CHARS } = {}) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const q of questions) {
    const len = describeQuestions([q]).length + 2;
    if (current.length && (current.length >= maxCount || size + len > maxChars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(q);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

function fillQuestion(i, n, title) {
  const scope = n > 1 ? `These are questions ${i + 1}/${n} batch of the lesson "${title}". ` : `These are the questions of the lesson "${title}". `;
  return `${scope}Answer every one of them correctly.`;
}

/** Thread text for answers filled in on the page: a numbered list of question → answer. */
export function compileFilled(items) {
  return items
    .map((it, i) => {
      const q = it.question.length > 140 ? it.question.slice(0, 137).trimEnd() + "…" : it.question;
      const state = it.filled ? "" : it.type === "open" ? "" : " _(shown next to the question)_";
      return `${i + 1}. ${q}\n   **→ ${it.answer || "(no answer)"}**${state}`;
    })
    .join("\n");
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
  const filled = []; // fill mode: {question, type, answer, filled} per answered question
  let answered = 0;
  let meta = {};
  try {
    const { sendScreenshot } = await getSettings();
    const license = await getLicense();
    const deviceId = await getDeviceId();
    const auth = { device_id: deviceId, license_key: license?.key || null };

    await save({ message: "Looking for questions on the page…" });
    const scanned = await scanQuestions(tab.id).catch(() => null);
    if (scanned?.questions.length) {
      const { questions } = scanned;
      const batches = batchQuestions(questions);
      const counts = { filled: 0, shown: 0 };
      await save({ total: questions.length, source: `${questions.length} question${questions.length > 1 ? "s" : ""} on the page`, fill: true });
      for (let b = 0; b < batches.length; b++) {
        if (state.cancelled) break;
        const batch = batches[b];
        await save({ step: answered, message: `Solving questions ${answered + 1}–${answered + batch.length} of ${questions.length}…` });
        let image = null;
        if (sendScreenshot) {
          await scrollToQuestion(tab.id, batch[0].id);
          image = await captureTab(tab);
        }
        const data = await api("/v1/solve", {
          ...auth,
          text: describeQuestions(batch),
          image,
          image_mime: "image/jpeg",
          question: fillQuestion(b, batches.length, scanned.title || tab.title || ""),
          mode: "fill",
          history: [],
          stream: false,
        }, { onRetry: () => save({ message: "Waking up the server…" }) });
        meta = data;
        const answers = Array.isArray(data.answers) ? data.answers : [];
        await save({ message: `Writing answers ${answered + 1}–${answered + batch.length} into the page…` });
        const applied = await applyAnswers(tab.id, answers, batch);
        counts.filled += applied.filled;
        counts.shown += applied.shown;
        const byId = new Map(answers.map((a) => [a.id, a]));
        for (const q of batch) {
          const a = byId.get(q.id);
          const picked = (a?.option_ids || []).map((id) => q.options?.find((o) => o.id === id)?.text).filter(Boolean);
          filled.push({ question: q.text, type: q.type, answer: a ? a.text || picked.join(", ") : "", filled: !!a && (q.type === "open" || picked.length > 0 || (q.type === "text" && !!a.text)) });
        }
        answered += batch.length;
        await save({ step: answered });
      }
      if (filled.length) await appendToThread(tab, job, [compileFilled(filled)], meta, fillProgress(answered, questions.length));
      const summary = summarise(counts, answered, questions.length);
      if (state.cancelled) await save({ status: "cancelled", message: `Stopped after ${answered} of ${questions.length} questions.`, results: answered, summary });
      else await save({ status: "done", message: `Done · ${summary}`, results: answered, summary, remaining: meta.remaining, plan: meta.plan });
      return job;
    }

    const { parts, source } = await planLesson(tab, { screenshot: sendScreenshot, onProgress: (message) => save({ message }) });
    await save({ total: parts.length, source });
    for (let i = 0; i < parts.length; i++) {
      if (state.cancelled) break;
      await save({ step: i + 1, message: `Solving part ${i + 1} of ${parts.length}…` });
      const data = await api("/v1/solve", {
        ...auth,
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
    if (job.fill && filled.length) await appendToThread(tab, job, [compileFilled(filled)], meta, fillProgress(answered, job.total)).catch(() => {});
    else if (!job.fill && results.length) await appendToThread(tab, job, results, meta).catch(() => {});
    await save({ status: "error", error: err.message || "Something went wrong", errorStatus: err.status || 0, results: job.fill ? answered : results.length });
  } finally {
    clearInterval(keepAlive);
    active.delete(tab.id);
  }
  return job;
}

const fillProgress = (answered, total) => (answered < total ? `${answered} of ${total} questions` : null);

function summarise(counts, answered, total) {
  const bits = [];
  if (counts.filled) bits.push(`${counts.filled} answer${counts.filled > 1 ? "s" : ""} filled in on the page`);
  if (counts.shown) bits.push(`${counts.shown} shown next to the question`);
  if (!bits.length) bits.push(`${answered} of ${total} questions answered`);
  return bits.join(", ");
}

async function appendToThread(tab, job, results, meta, progress = null) {
  const stored = await chrome.storage.session.get(threadKey(tab.id));
  const thread = stored[threadKey(tab.id)] || { url: tab.url || "", messages: [] };
  if (thread.url && tab.url && thread.url.split("#")[0] !== tab.url.split("#")[0]) thread.messages = [];
  thread.url = tab.url || thread.url;
  const partial = progress ? ` (${progress})` : !job.fill && results.length < job.total ? ` (${results.length} of ${job.total} parts)` : "";
  const remaining = meta.plan === "pro" || meta.remaining == null ? "" : ` · ${meta.remaining} free left today`;
  thread.messages.push(
    { role: "user", text: LESSON_PROMPT },
    { role: "model", text: compileAnswers(results), mode: job.mode, meta: `Agent · ${job.source}${partial}${remaining}. Double-check before submitting.` },
  );
  await chrome.storage.session.set({ [threadKey(tab.id)]: thread });
}
