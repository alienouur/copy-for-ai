import { copyTabs } from "./lib/copy.js";
import { ensureAllTabsPermission } from "./lib/extractor.js";
import { allTemplates, getSettings, saveSettings } from "./lib/settings.js";
import { checkProAccess, isPro } from "./lib/license.js";
import { contextWarning, formatCount } from "./lib/format.js";
import { PRO_CHECKOUT_URL } from "./lib/config.js";
import { fetchPlan, solveTab } from "./lib/solver.js";
import { renderMarkdown } from "./lib/markdown.js";

const $ = (id) => document.getElementById(id);
const status = $("status");
let lastAnswer = "";
let solving = false;

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
  for (const t of allTemplates(settings)) {
    const opt = new Option(t.name, t.id);
    select.add(opt);
  }
  select.value = settings.templateId;
  select.addEventListener("change", () => saveSettings({ templateId: select.value }));

  for (const key of ["includeLinks", "includeImages", "includeHeader", "answerOnly", "sendScreenshot"]) {
    const box = $(key);
    box.checked = settings[key];
    box.addEventListener("change", () => saveSettings({ [key]: box.checked }));
  }

  $("solve-btn").addEventListener("click", () => solve($("answerOnly").checked ? "answer" : "explain"));
  $("explain-btn").addEventListener("click", () => solve("explain"));
  $("copy-answer").addEventListener("click", copyAnswer);
  $("question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("solve-btn").click();
    }
  });
  refreshQuota(pro);

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
    const c = cmds.find((x) => x.name === "copy-page");
    if (c?.shortcut) $("shortcut-hint").textContent = c.shortcut;
  });
}

function openOptions(e) {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

function setBusy(busy) {
  for (const b of document.querySelectorAll("button")) b.disabled = busy;
}

function showStatus(html, kind) {
  status.hidden = false;
  status.className = `status ${kind}`;
  status.innerHTML = html;
}

function hideStatus() {
  status.hidden = true;
}

const upgradeLink = (label = "Upgrade to Pro") => `<a href="${PRO_CHECKOUT_URL}" target="_blank">${label}</a>`;

// --- Solve

async function refreshQuota(pro) {
  const el = $("quota");
  try {
    const me = await fetchPlan();
    if (me.plan === "pro") {
      el.textContent = "Pro · unlimited answers";
    } else {
      const expired = me.expired ? "Subscription ended. " : "";
      el.innerHTML = `${expired}${me.remaining} free answer${me.remaining === 1 ? "" : "s"} left today · ${upgradeLink("Go unlimited")}`;
    }
  } catch {
    el.textContent = pro ? "Pro" : "";
  }
}

async function solve(mode) {
  if (solving) return;
  solving = true;
  setBusy(true);
  $("answer-box").hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await solveTab({
      tab,
      mode,
      question: $("question").value,
      screenshot: $("sendScreenshot").checked,
      onProgress: (msg) => showStatus(msg, "busy"),
    });
    hideStatus();
    renderAnswer(result, mode);
  } catch (err) {
    if (err.status === 402) {
      showStatus(`${err.message} ${upgradeLink("Upgrade – $4.99/month")}`, "err");
    } else {
      showStatus(err.message, "err");
    }
  } finally {
    solving = false;
    setBusy(false);
    refreshQuota(await isPro());
  }
}

function renderAnswer(result, mode) {
  lastAnswer = result.answer;
  const box = $("answer");
  box.innerHTML = renderMarkdown(result.answer);
  const isSingleLine = mode === "answer" && !result.answer.includes("\n") && result.answer.length <= 80;
  box.classList.toggle("single", isSingleLine);
  $("explain-btn").hidden = mode === "explain";

  const sources = [];
  if (result.usedSelection) sources.push("selected text");
  else if (result.hadText) sources.push("page text");
  if (result.usedScreenshot) sources.push("screenshot");
  const remaining = result.plan === "pro" ? "" : ` · ${result.remaining} free left today`;
  $("answer-meta").textContent = `Based on ${sources.join(" + ") || "your question"}${remaining}. Double-check before submitting.`;
  $("answer-box").hidden = false;
}

async function copyAnswer() {
  if (!lastAnswer) return;
  await writeClipboard(lastAnswer);
  const btn = $("copy-answer");
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = "Copy answer"), 1500);
}

// --- Copy as Markdown

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
  showStatus("Reading page…", "");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const stats = await copyTabs({ tabs: [tab], mode, writeClipboard });
    showStatus(successMessage(stats), "ok");
  } catch (err) {
    showStatus(err.message, "err");
  } finally {
    setBusy(false);
  }
}

async function copyAllTabs() {
  const access = await checkProAccess(false);
  if (!access.allowed) {
    showStatus(`Bundling all tabs is a Pro feature. ${upgradeLink("Upgrade – $4.99/month")}`, "err");
    return;
  }
  if (!(await ensureAllTabsPermission())) {
    showStatus("Permission to read your tabs is required for this feature", "err");
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
      onProgress: (i, n) => showStatus(`Reading tab ${i} of ${n}…`, ""),
    });
    await checkProAccess(true);
    const extra = access.pro ? "" : `Free trial: ${Math.max(0, access.trialsLeft - 1)} Pro uses left`;
    showStatus(successMessage(stats, extra), "ok");
  } catch (err) {
    showStatus(err.message, "err");
  } finally {
    setBusy(false);
  }
}

async function writeClipboard(text) {
  await navigator.clipboard.writeText(text);
}

init();
