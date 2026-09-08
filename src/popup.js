import { copyTabs } from "./lib/copy.js";
import { ensureAllTabsPermission } from "./lib/extractor.js";
import { allTemplates, getSettings, saveSettings } from "./lib/settings.js";
import { checkProAccess, isPro } from "./lib/license.js";
import { contextWarning, formatCount } from "./lib/format.js";
import { PRO_CHECKOUT_URL } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
const status = $("status");

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

  for (const key of ["includeLinks", "includeImages", "includeHeader"]) {
    const box = $(key);
    box.checked = settings[key];
    box.addEventListener("change", () => saveSettings({ [key]: box.checked }));
  }

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
    showStatus(`Bundling all tabs is a Pro feature. <a href="${PRO_CHECKOUT_URL}" target="_blank">Upgrade – one-time payment</a>`, "err");
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
