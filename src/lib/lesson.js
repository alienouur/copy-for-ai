// "Solve whole lesson" agent. It first looks for questions with answer fields on the page (radios, checkboxes,
// selects, text boxes, drag-and-drop matching, or plain numbered questions) and answers them in place, batch by
// batch, on the same tab. With the "auto-submit" setting on it then clicks the page's Next / Submit / Check button,
// waits for the next page or question to appear, and repeats until no new questions show up. Pages without
// recognisable questions fall back to text chunks / one screenshot per screen solved into the panel. Everything runs
// in the background worker with progress in chrome.storage.session so the side panel can show it and pick up the
// result even if it was closed.
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
const MAX_PAGES = 60; // hard stop for auto-advance
const MAX_IDLE_CLICKS = 3; // Next/Submit clicks in a row that reveal no new questions (e.g. summary -> confirm -> review)
const PAGE_SETTLE_MS = 900;
const PAGE_LOAD_TIMEOUT_MS = 15_000;

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

/** Clicks the page's Next / Submit button (see fill.js advance()). Returns its label or null. */
async function advancePage(tabId) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__copyForAIFill.advance() });
  return result?.result || null;
}

// Option order is ignored: dropped items move around in the document.
const optionKey = (q) => `${q.type}:${(q.options || []).map((o) => o.text.slice(0, 40)).sort().join("|")}`;

/**
 * Remembers answered questions so a Check / feedback re-render of the same page is not solved twice. A rescanned
 * question counts as the same one when type and options match and its text is the old text with feedback appended
 * (or vice versa); genuinely new questions differ earlier in their text.
 */
function answeredSet() {
  const byOptions = new Map();
  return {
    has(q) {
      const text = q.text.slice(0, 300);
      return (byOptions.get(optionKey(q)) || []).some((t) => t === text || (Math.min(t.length, text.length) >= 20 && (t.startsWith(text) || text.startsWith(t))));
    },
    add(q) {
      const key = optionKey(q);
      if (!byOptions.has(key)) byOptions.set(key, []);
      byOptions.get(key).push(q.text.slice(0, 300));
    },
  };
}

/** A rescan counts as a new page when most of its questions are ones we have not answered yet. */
const isNewPage = (fresh, all) => fresh.length * 2 >= all.length;

/** After a click: wait for any navigation to finish (or the SPA to re-render), then return the fresh tab. */
async function waitForPage(tabId) {
  await sleep(PAGE_SETTLE_MS);
  const until = Date.now() + PAGE_LOAD_TIMEOUT_MS;
  let tab = await chrome.tabs.get(tabId);
  while (tab.status === "loading" && Date.now() < until) {
    await sleep(300);
    tab = await chrome.tabs.get(tabId);
  }
  await sleep(PAGE_SETTLE_MS / 2);
  return tab;
}

/** scan() right after navigation can race the document; retry a few times. */
async function scanWithRetry(tabId, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await scanQuestions(tabId);
    } catch (err) {
      last = err;
      await sleep(700);
    }
  }
  throw last;
}

async function scrollToQuestion(tabId, id) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (qid) => document.querySelector(`[data-cfa-q="${qid}"]`)?.scrollIntoView({ block: "start" }),
    args: [id],
  }).catch(() => {});
  await sleep(SHOT_SETTLE_MS);
}

/**
 * Serialises questions for the fill prompt: "Q <id> [<type>]: text" followed by "- <option id>: text" lines and, for
 * drag-and-drop matching, "> <target id>: text" lines for the places the items go.
 */
export function describeQuestions(questions) {
  return questions
    .map((q) => {
      const opts = (q.options || []).map((o) => `- ${o.id}: ${o.text}`);
      const targets = (q.targets || []).map((t) => `> ${t.id}: ${t.text}`);
      return [`Q ${q.id} [${q.type}]: ${q.text}`, ...opts, ...targets].join("\n");
    })
    .join("\n\n");
}

/** Human-readable answer for the thread: option texts, "item → box" pairs, or the plain text. */
export function answerLabel(q, a) {
  if (!a) return "";
  if (q.type === "match" && a.pairs?.length) {
    const pairs = a.pairs
      .map((p) => {
        const o = q.options?.find((x) => x.id === p.option_id)?.text;
        const t = q.targets?.find((x) => x.id === p.target_id)?.text;
        return o && t ? `${o} → ${t}` : null;
      })
      .filter(Boolean);
    if (pairs.length) return pairs.join("; ");
  }
  const picked = (a.option_ids || []).map((id) => q.options?.find((o) => o.id === id)?.text).filter(Boolean);
  return a.text || picked.join(", ");
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

function fillQuestion(i, n, title, page = 1) {
  const where = page > 1 ? `page ${page} of the lesson "${title}"` : `the lesson "${title}"`;
  const scope = n > 1 ? `These are questions batch ${i + 1}/${n} of ${where}. ` : `These are the questions of ${where}. `;
  return `${scope}Answer every one of them correctly.`;
}

const sourceLabel = (n, pages) => `${n} question${n > 1 ? "s" : ""} on the page${pages > 1 ? ` (${pages} pages)` : ""}`;

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
export async function runLesson(tab, { mode, autoSubmit }) {
  if (active.has(tab.id)) return loadJob(tab.id);
  const state = { cancelled: false };
  active.set(tab.id, state);
  tab = { ...tab };
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
  const counts = { filled: 0, shown: 0, pages: 0, clicks: 0 };
  try {
    const settings = await getSettings();
    const { sendScreenshot } = settings;
    autoSubmit ??= settings.autoSubmit;
    const license = await getLicense();
    const deviceId = await getDeviceId();
    const auth = { device_id: deviceId, license_key: license?.key || null };

    await save({ message: "Looking for questions on the page…" });
    let scanned = await scanQuestions(tab.id).catch(() => null);
    if (scanned?.questions.length) {
      const seen = answeredSet();
      let idleClicks = 0;
      let emptyScans = 0;
      let lastClick = null;
      await save({ fill: true, autoSubmit: !!autoSubmit, pages: 0 });
      // Each round: answer everything new on the current page/question, then (auto-submit) click Next / Submit and rescan.
      while (!state.cancelled) {
        const questions = (scanned?.questions || []).filter((q) => !seen.has(q));
        if (questions.length) {
          questions.forEach((q) => seen.add(q));
          idleClicks = 0;
          if (isNewPage(questions, scanned.questions) || !counts.pages) counts.pages++;
          const page = counts.pages;
          const pageLabel = page > 1 || autoSubmit ? `Page ${page} · ` : "";
          const batches = batchQuestions(questions);
          const first = answered;
          await save({ total: first + questions.length, pages: page, source: sourceLabel(first + questions.length, page) });
          for (let b = 0; b < batches.length; b++) {
            if (state.cancelled) break;
            const batch = batches[b];
            await save({ step: answered, message: `${pageLabel}Solving questions ${answered - first + 1}–${answered - first + batch.length} of ${questions.length}…` });
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
              question: fillQuestion(b, batches.length, scanned.title || tab.title || "", page),
              mode: "fill",
              history: [],
              stream: false,
            }, { onRetry: () => save({ message: "Waking up the server…" }) });
            meta = data;
            const answers = Array.isArray(data.answers) ? data.answers : [];
            await save({ message: `${pageLabel}Writing answers ${answered - first + 1}–${answered - first + batch.length} into the page…` });
            const applied = await applyAnswers(tab.id, answers, batch);
            counts.filled += applied.filled;
            counts.shown += applied.shown;
            const byId = new Map(answers.map((a) => [a.id, a]));
            for (const q of batch) {
              const a = byId.get(q.id);
              const label = answerLabel(q, a);
              filled.push({ question: q.text, type: q.type, page, answer: label, filled: !!a && (q.type === "open" || !!label) });
            }
            answered += batch.length;
            await save({ step: answered });
          }
          if (state.cancelled) break;
        }
        if (!autoSubmit || counts.pages >= MAX_PAGES || idleClicks >= MAX_IDLE_CLICKS) break;
        // Move on: Next first, else Submit / Check / Finish. Stop when there is nothing to click, when clicks stop
        // revealing new questions, or when two pages in a row have no questions at all (results / summary pages).
        await save({ message: `Page ${counts.pages} answered · looking for Next / Submit…` });
        const clicked = await advancePage(tab.id).catch(() => null);
        if (!clicked) break;
        counts.clicks++;
        idleClicks++;
        lastClick = clicked;
        await save({ message: `Clicked “${clicked}” · waiting for the next page…` });
        const fresh = await waitForPage(tab.id).catch(() => null);
        if (!fresh || state.cancelled) break;
        tab.url = fresh.url || tab.url;
        tab.title = fresh.title || tab.title;
        await save({ url: tab.url, title: tab.title });
        scanned = await scanWithRetry(tab.id).catch(() => null);
        if (!scanned) break;
        emptyScans = scanned.questions.length ? 0 : emptyScans + 1;
        if (emptyScans >= 2) break;
      }
      job.submitted = counts.clicks > 0;
      if (filled.length) await appendToThread(tab, job, [compileFilled(filled)], meta, fillProgress(answered, job.total));
      const summary = summarise(counts, answered, job.total, lastClick);
      if (state.cancelled) await save({ status: "cancelled", message: `Stopped after ${answered} of ${job.total} questions${counts.pages > 1 ? ` (${counts.pages} pages)` : ""}.`, results: answered, summary });
      else await save({ status: "done", message: `Done · ${summary}`, results: answered, summary, submitted: counts.clicks > 0, remaining: meta.remaining, plan: meta.plan });
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

function summarise(counts, answered, total, lastClick) {
  const bits = [];
  if (counts.filled) bits.push(`${counts.filled} answer${counts.filled > 1 ? "s" : ""} filled in on the page${counts.pages > 1 ? ` (${counts.pages} pages)` : ""}`);
  if (counts.shown) bits.push(`${counts.shown} shown next to the question`);
  if (!bits.length) bits.push(`${answered} of ${total} questions answered`);
  if (lastClick) bits.push(`submitted via “${lastClick}”`);
  return bits.join(", ");
}

async function appendToThread(tab, job, results, meta, progress = null) {
  const stored = await chrome.storage.session.get(threadKey(tab.id));
  const thread = stored[threadKey(tab.id)] || { url: tab.url || "", messages: [] };
  if (thread.url && tab.url && thread.url.split("#")[0] !== tab.url.split("#")[0]) thread.messages = [];
  thread.url = tab.url || thread.url;
  const partial = progress ? ` (${progress})` : !job.fill && results.length < job.total ? ` (${results.length} of ${job.total} parts)` : "";
  const remaining = meta.plan === "pro" || meta.remaining == null ? "" : ` · ${meta.remaining} free left today`;
  const advice = job.submitted ? "Double-check the results." : "Double-check before submitting.";
  thread.messages.push(
    { role: "user", text: LESSON_PROMPT },
    { role: "model", text: compileAnswers(results), mode: job.mode, meta: `Agent · ${job.source}${partial}${remaining}. ${advice}` },
  );
  await chrome.storage.session.set({ [threadKey(tab.id)]: thread });
}
