import { copyTabs } from "./lib/copy.js";
import { ensureAllTabsPermission } from "./lib/extractor.js";
import { allTemplates, getSettings, saveSettings } from "./lib/settings.js";
import { checkProAccess, isPro } from "./lib/license.js";
import { contextWarning, formatCount } from "./lib/format.js";
import { PRO_CHECKOUT_URL } from "./lib/config.js";
import { fetchPlan, hasPageAccess, requestPageAccess, solveTab } from "./lib/solver.js";
import { renderMarkdown } from "./lib/markdown.js";
import { jobKey, loadJob } from "./lib/lesson.js";

const $ = (id) => document.getElementById(id);
const SOLVE_PROMPT = "Solve the questions on this page.";
const PENDING_MAX_AGE_MS = 20_000;

let currentTab = null;
let thread = null; // { url, messages: [{ role: "user"|"model", text, mode?, meta? }] }
let solving = false;

// --- Threads are kept per tab for the browser session, so reloading the page or reopening the panel keeps the answers.

const threadKey = (tabId) => `thread:${tabId}`;

async function loadThread(tabId) {
  const stored = await chrome.storage.session.get(threadKey(tabId));
  return stored[threadKey(tabId)] || null;
}

function saveThread() {
  if (!currentTab) return;
  if (thread?.messages?.length) chrome.storage.session.set({ [threadKey(currentTab.id)]: thread });
  else chrome.storage.session.remove(threadKey(currentTab.id));
}

const pageKey = (url) => (url || "").split("#")[0];

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function syncTab() {
  const tab = await activeTab();
  if (!tab) return;
  const switched = !currentTab || currentTab.id !== tab.id;
  const navigated = !!(tab.url && currentTab?.url && pageKey(tab.url) !== pageKey(currentTab.url));
  currentTab = tab;
  $("page-title").textContent = tab.title || safeHost(tab.url) || "This page";
  if (solving) return;
  if (switched || navigated || !thread) {
    thread = await loadThread(tab.id);
    if (thread && tab.url && thread.url && pageKey(thread.url) !== pageKey(tab.url)) {
      thread = null;
      saveThread();
    }
    renderThread();
  }
  if (switched || navigated || !job) renderJob(await loadJob(tab.id));
}

// --- Whole-lesson agent (runs in the background worker; the panel only shows storage-backed progress)

let job = null;

async function startLesson() {
  if (solving) return;
  const tab = await activeTab();
  if (!tab) return;
  currentTab = tab;
  hideStatus();
  await ensureAccess(tab);
  const mode = $("answerOnly").checked ? "answer" : "explain";
  renderJob({ status: "running", tabId: tab.id, step: 0, total: 0, message: "Starting…" });
  const res = await chrome.runtime.sendMessage({ type: "cfa-lesson-start", tab: { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title }, mode }).catch(() => null);
  if (!res?.ok) renderJob({ status: "error", tabId: tab.id, error: res?.error || "Could not start the agent. Reload the extension and try again." });
}

function cancelLesson() {
  if (!job) return;
  chrome.runtime.sendMessage({ type: "cfa-lesson-cancel", tabId: job.tabId }).catch(() => {});
  renderJob({ ...job, message: "Stopping after the current part…" });
  $("job-cancel").disabled = true;
}

async function dismissJob() {
  if (job) chrome.storage.session.remove(jobKey(job.tabId));
  renderJob(null);
}

function renderJob(next) {
  job = next;
  const box = $("job");
  if (!job) {
    box.hidden = true;
    $("lesson-btn").disabled = false;
    return;
  }
  const running = job.status === "running";
  box.hidden = false;
  box.className = `job ${job.status}`;
  $("lesson-btn").disabled = running;
  $("job-cancel").hidden = !running;
  $("job-cancel").disabled = false;
  $("job-dismiss").hidden = running;
  $("job-count").textContent = job.total ? `${Math.min(job.step, job.total)}/${job.total}` : "";
  const fill = $("job-bar");
  fill.classList.toggle("indeterminate", running && !job.total);
  const done = job.status === "done" ? job.total : Math.max(0, job.step - (running && !job.fill ? 1 : 0));
  fill.style.width = job.total ? `${Math.round((done / job.total) * 100)}%` : running ? "" : "100%";
  const msg = $("job-msg");
  if (job.status === "error") {
    msg.innerHTML = job.errorStatus === 402 ? `${escapeHtml(job.error)} ${upgradeLink("Upgrade – $4.99/month")}` : escapeHtml(job.error || "Something went wrong");
  } else {
    msg.textContent = job.message || "";
  }
  if (running) scrollToBottom();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

chrome.storage.session.onChanged.addListener(async (changes) => {
  if (!currentTab) return;
  const jobChange = changes[jobKey(currentTab.id)];
  if (jobChange) renderJob(jobChange.newValue || null);
  const threadChange = changes[threadKey(currentTab.id)];
  if (threadChange && !solving) {
    thread = threadChange.newValue || null;
    renderThread();
  }
  if (jobChange?.newValue && jobChange.newValue.status !== "running") refreshQuota();
});

function safeHost(url) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

// --- Rendering

function renderThread() {
  const msgs = thread?.messages || [];
  const has = msgs.length > 0;
  $("empty").hidden = has;
  $("chips").hidden = !has || solving;
  $("new-chat").hidden = !has;
  $("send-btn").textContent = has ? "Send" : "Solve";
  $("question").placeholder = has ? "Ask a follow-up… (why? explain #3)" : "Ask about this page… (optional)";
  const box = $("messages");
  box.replaceChildren(...msgs.map(renderMessage));
  scrollToBottom();
}

function renderMessage(m) {
  const node = $(m.role === "user" ? "tpl-user" : "tpl-model").content.firstElementChild.cloneNode(true);
  const bubble = node.querySelector(".bubble");
  if (m.role === "user") {
    bubble.textContent = m.text;
    return node;
  }
  fillAnswer(bubble, m.text, m.mode);
  node.querySelector(".meta").textContent = m.meta || "";
  const copy = node.querySelector(".copy");
  copy.addEventListener("click", () => flashCopy(copy, m.text));
  const explain = node.querySelector(".explain");
  explain.hidden = m.mode === "explain";
  explain.addEventListener("click", () => ask({ question: "Explain the answers step by step.", mode: "explain" }));
  return node;
}

function fillAnswer(bubble, text, mode) {
  bubble.innerHTML = renderMarkdown(text);
  const single = mode === "answer" && !text.includes("\n") && text.length <= 80;
  bubble.classList.toggle("single", single);
}

function scrollToBottom() {
  const el = $("thread");
  el.scrollTop = el.scrollHeight;
}

let pendingFrame = 0;
function scheduleAnswerRender(bubble, text, mode) {
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    fillAnswer(bubble, text, mode);
    scrollToBottom();
  });
}

function setBusy(busy) {
  for (const b of document.querySelectorAll("button")) b.disabled = busy;
  $("send-btn").textContent = busy ? "…" : thread?.messages?.length ? "Send" : "Solve";
}

function showStatus(html, kind) {
  const status = $("status");
  status.hidden = false;
  status.className = `status ${kind}`;
  status.innerHTML = html;
  scrollToBottom();
}

function hideStatus() {
  $("status").hidden = true;
}

const upgradeLink = (label = "Upgrade to Pro") => `<a href="${PRO_CHECKOUT_URL}" target="_blank">${label}</a>`;

function showQuota(me, pro) {
  const el = $("quota");
  if (!me) {
    el.textContent = pro ? "Pro" : "";
    return;
  }
  if (me.plan === "pro") {
    el.textContent = "Pro · unlimited";
    return;
  }
  const expired = me.expired ? "Subscription ended. " : "";
  el.innerHTML = `${expired}${me.remaining} free left today · ${upgradeLink("Go unlimited")}`;
}

async function refreshQuota() {
  try {
    showQuota(await fetchPlan(), await isPro());
  } catch {
    showQuota(null, await isPro());
  }
}

function metaText(result) {
  const sources = [];
  if (result.usedSelection) sources.push("selected text");
  else if (result.hadText) sources.push("page text");
  if (result.usedScreenshot) sources.push("screenshot");
  const remaining = result.plan === "pro" ? "" : ` · ${result.remaining} free left today`;
  return `Based on ${sources.join(" + ") || "your question"}${remaining}. Double-check before submitting.`;
}

// --- Solving

async function ensureAccess(tab) {
  if (await hasPageAccess(tab)) return;
  const { declinedAllSites } = await chrome.storage.local.get("declinedAllSites");
  if (declinedAllSites) return;
  const granted = await requestPageAccess();
  if (!granted) chrome.storage.local.set({ declinedAllSites: true });
}

/**
 * question: typed text (may be empty for the first solve). mode: "answer" | "explain" | undefined (use setting).
 * fresh: start a new thread even if one exists.
 */
async function ask({ question = "", mode, fresh = false } = {}) {
  if (solving) return;
  const tab = await activeTab();
  if (!tab) return;
  currentTab = tab;
  const q = question.trim();
  const followUp = !fresh && !!thread?.messages?.length;
  if (followUp && !q) {
    $("question").focus();
    return;
  }
  mode ||= $("answerOnly").checked ? "answer" : "explain";

  solving = true;
  setBusy(true);
  hideStatus();
  await ensureAccess(tab);

  if (!followUp) thread = { url: tab.url || "", messages: [] };
  const history = followUp ? thread.messages.map(({ role, text }) => ({ role, text })) : [];
  thread.messages.push({ role: "user", text: q || SOLVE_PROMPT });
  const reply = { role: "model", text: "", mode, meta: "" };
  thread.messages.push(reply);
  renderThread();
  $("question").value = "";
  autosize();
  const bubble = $("messages").lastElementChild.querySelector(".bubble");
  bubble.classList.add("streaming");

  try {
    const result = await solveTab({
      tab,
      mode,
      question: q,
      screenshot: $("sendScreenshot").checked,
      history,
      onProgress: (msg) => showStatus(msg, "busy"),
      onDelta: (_, answerSoFar) => {
        hideStatus();
        reply.text = answerSoFar;
        scheduleAnswerRender(bubble, answerSoFar, mode);
      },
    });
    hideStatus();
    reply.text = result.answer;
    reply.meta = metaText(result);
    saveThread();
    showQuota(result, result.plan === "pro");
  } catch (err) {
    thread.messages.splice(-2, 2);
    if (!thread.messages.length) thread = null;
    saveThread();
    $("question").value = q;
    autosize();
    if (err.status === 402) showStatus(`${err.message} ${upgradeLink("Upgrade – $4.99/month")}`, "err");
    else showStatus(err.message, "err");
  } finally {
    solving = false;
    cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
    setBusy(false);
    renderThread();
  }
}

function flashCopy(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const label = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = label), 1500);
  });
}

function autosize() {
  const ta = $("question");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  ta.classList.toggle("scroll", ta.scrollHeight > 140);
}

// Shortcut / context menu handoff from the background worker.
async function consumePendingSolve() {
  const { pendingSolve } = await chrome.storage.session.get("pendingSolve");
  if (!pendingSolve) return;
  await chrome.storage.session.remove("pendingSolve");
  if (Date.now() - pendingSolve.ts > PENDING_MAX_AGE_MS) return;
  ask({ fresh: true });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "cfa-solve-now") consumePendingSolve();
});

// A job left as "running" without a live worker (e.g. the worker was restarted) is shown as interrupted.
async function reconcileJob() {
  if (job?.status !== "running") return;
  const res = await chrome.runtime.sendMessage({ type: "cfa-lesson-running", tabId: job.tabId }).catch(() => null);
  if (res && !res.running) {
    const stale = { ...job, status: "error", error: "The agent was interrupted. Any solved parts are in the chat above — run it again to finish." };
    chrome.storage.session.set({ [jobKey(job.tabId)]: stale });
  }
}

// --- Copy as Markdown (legacy tools)

function showCopyStatus(html, kind) {
  const el = $("copy-status");
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

function successMessage(stats, extra = "") {
  const warn = contextWarning(stats.tokens);
  const what = stats.tabs > 1 ? `${stats.tabs} tabs` : stats.usedSelection ? "Selection" : "Page";
  let html = `${what} copied · ${formatCount(stats.words)} words · ~${formatCount(stats.tokens)} tokens`;
  if (stats.skipped?.length) html += `<span class="warn">Skipped ${stats.skipped.length} tab(s) that can't be read</span>`;
  if (warn) html += `<span class="warn">${warn}</span>`;
  if (extra) html += `<span class="warn">${extra}</span>`;
  return html;
}

async function copyCurrent(mode) {
  setBusy(true);
  showCopyStatus("Reading page…", "");
  try {
    const tab = await activeTab();
    const stats = await copyTabs({ tabs: [tab], mode, writeClipboard });
    showCopyStatus(successMessage(stats), "ok");
  } catch (err) {
    showCopyStatus(err.message, "err");
  } finally {
    setBusy(false);
  }
}

async function copyAllTabs() {
  const access = await checkProAccess(false);
  if (!access.allowed) {
    showCopyStatus(`Bundling all tabs is a Pro feature. ${upgradeLink("Upgrade – $4.99/month")}`, "err");
    return;
  }
  if (!(await ensureAllTabsPermission())) {
    showCopyStatus("Permission to read your tabs is required for this feature", "err");
    return;
  }
  setBusy(true);
  try {
    const highlighted = await chrome.tabs.query({ currentWindow: true, highlighted: true });
    const tabs = highlighted.length > 1 ? highlighted : await chrome.tabs.query({ currentWindow: true });
    const stats = await copyTabs({
      tabs,
      mode: "page",
      writeClipboard,
      onProgress: (i, n) => showCopyStatus(`Reading tab ${i} of ${n}…`, ""),
    });
    await checkProAccess(true);
    const extra = access.pro ? "" : `Free trial: ${Math.max(0, access.trialsLeft - 1)} Pro uses left`;
    showCopyStatus(successMessage(stats, extra), "ok");
  } catch (err) {
    showCopyStatus(err.message, "err");
  } finally {
    setBusy(false);
  }
}

async function writeClipboard(text) {
  await navigator.clipboard.writeText(text);
}

// --- Init

function openOptions(e) {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

async function init() {
  const settings = await getSettings();
  const pro = await isPro();

  const badge = $("pro-badge");
  if (pro) {
    badge.textContent = "PRO";
    badge.classList.add("pro");
    badge.href = "#";
    badge.addEventListener("click", openOptions);
  } else {
    badge.href = PRO_CHECKOUT_URL;
    badge.target = "_blank";
  }

  const select = $("template");
  for (const t of allTemplates(settings)) select.add(new Option(t.name, t.id));
  select.value = settings.templateId;
  select.addEventListener("change", () => saveSettings({ templateId: select.value }));

  for (const key of ["includeLinks", "includeImages", "includeHeader", "answerOnly", "sendScreenshot"]) {
    const box = $(key);
    box.checked = settings[key];
    box.addEventListener("change", () => saveSettings({ [key]: box.checked }));
  }

  $("solve-btn").addEventListener("click", () => ask({ question: $("question").value, fresh: true }));
  $("lesson-btn").addEventListener("click", startLesson);
  $("lesson-chip").addEventListener("click", startLesson);
  $("job-cancel").addEventListener("click", cancelLesson);
  $("job-dismiss").addEventListener("click", dismissJob);
  $("send-btn").addEventListener("click", () => ask({ question: $("question").value }));
  $("new-chat").addEventListener("click", () => {
    thread = null;
    saveThread();
    hideStatus();
    renderThread();
    $("question").focus();
  });
  for (const chip of document.querySelectorAll(".chip[data-q]")) {
    chip.addEventListener("click", () =>
      ask({ question: chip.dataset.q, mode: chip.dataset.mode === "auto" ? undefined : chip.dataset.mode, fresh: !!chip.dataset.fresh }),
    );
  }
  const question = $("question");
  question.addEventListener("input", autosize);
  question.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask({ question: question.value });
    }
  });

  $("copy-page").addEventListener("click", () => copyCurrent("page"));
  $("copy-selection").addEventListener("click", () => copyCurrent("selection"));
  $("copy-tabs").addEventListener("click", copyAllTabs);
  $("open-options").addEventListener("click", openOptions);
  $("open-history").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    chrome.storage.session?.set({ openTab: "history" });
  });

  chrome.commands.getAll((cmds) => {
    const solve = cmds.find((x) => x.name === "solve-page");
    if (solve?.shortcut) $("shortcut-hint").textContent = solve.shortcut;
    const copy = cmds.find((x) => x.name === "copy-page");
    if (copy?.shortcut) $("copy-shortcut-hint").textContent = copy.shortcut;
  });

  chrome.tabs.onActivated.addListener(() => syncTab());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === currentTab?.id && (info.url || info.title || info.status === "complete")) syncTab();
  });
  chrome.windows.onFocusChanged?.addListener(() => syncTab());

  await syncTab();
  reconcileJob();
  refreshQuota();
  consumePendingSolve();
}

init();
