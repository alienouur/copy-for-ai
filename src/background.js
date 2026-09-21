import { copyTabs } from "./lib/copy.js";
import { LANDING_URL } from "./lib/config.js";
import { cancelLesson, isLessonRunning, jobKey, loadJob, runLesson, threadKey } from "./lib/lesson.js";

const MENU_SOLVE = "cfa-solve";
const MENU_LESSON = "cfa-lesson";
const NOTIFY_LESSON = "cfa-lesson:";
const MENU_PAGE = "cfa-copy-page";
const MENU_SELECTION = "cfa-copy-selection";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SOLVE, title: "Solve with Copy for AI", contexts: ["page", "selection"] });
    chrome.contextMenus.create({ id: MENU_LESSON, title: "Solve whole lesson (Agent)", contexts: ["page", "selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Copy page for AI (Markdown)", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Copy selection for AI (Markdown)", contexts: ["selection"] });
  });
  if (reason === "install") {
    chrome.tabs.create({ url: `${LANDING_URL}/welcome.html` }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === MENU_SOLVE) {
    openSolver(tab);
    return;
  }
  if (info.menuItemId === MENU_LESSON) {
    startLesson(tab);
    return;
  }
  run(tab, info.menuItemId === MENU_SELECTION ? "selection" : "page");
});

/** Opens the side panel for the tab's window and asks it to solve the page right away. */
async function openSolver(tab) {
  // open() must run within the user gesture, so don't await anything before it.
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  await chrome.storage.session.set({ pendingSolve: { tabId: tab.id, ts: Date.now() } });
  try {
    await opening;
  } catch {
    notify("Copy for AI", "Click the Copy for AI icon in the toolbar to open the solver.");
    return;
  }
  // Already-open panels won't reload, so nudge them; a freshly opened one reads pendingSolve itself.
  chrome.runtime.sendMessage({ type: "cfa-solve-now" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "cfa-lesson-start") {
    startLesson(msg.tab, msg.mode, msg.autoSubmit);
    sendResponse({ ok: true });
  }
  if (msg?.type === "cfa-lesson-cancel") {
    cancelLesson(msg.tabId);
    sendResponse({ ok: true });
  }
  if (msg?.type === "cfa-lesson-running") {
    sendResponse({ running: isLessonRunning(msg.tabId) });
  }
});

async function startLesson(tab, mode, autoSubmit) {
  if (!tab?.id || isLessonRunning(tab.id)) return;
  if (!mode) {
    const { settings } = await chrome.storage.sync.get("settings");
    mode = settings?.answerOnly === false ? "explain" : "answer";
  }
  const job = await runLesson(tab, { mode, autoSubmit });
  const title = (job.title || "this page").slice(0, 60);
  const unit = job.fill ? "question" : "part";
  if (job.status === "done") {
    const what = job.summary || `${job.results} ${unit}${job.results > 1 ? "s" : ""} answered`;
    notify("Lesson solved ✓", `${what} on “${title}”. ${job.submitted ? "Check the results." : "Review it, then submit."}`, `${NOTIFY_LESSON}${tab.id}`, false);
  } else if (job.status === "error") {
    notify("Lesson agent stopped", `${job.error}${job.results ? ` (${job.results} of ${job.total} ${unit}s done)` : ""}`, `${NOTIFY_LESSON}${tab.id}`, false);
  }
  if (job.status !== "cancelled") flashBadge(job.status === "done" ? "✓" : "!", job.status === "done" ? "#16a34a" : "#dc2626", tab.id);
  chrome.runtime.sendMessage({ type: "cfa-lesson-finished", tabId: tab.id }).catch(() => {});
}

chrome.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith(NOTIFY_LESSON)) return;
  chrome.notifications.clear(id);
  const tabId = Number(id.slice(NOTIFY_LESSON.length));
  // open() must run within the user gesture, so don't await anything before it.
  const opening = chrome.sidePanel.open({ tabId }).catch(() => {});
  chrome.tabs.get(tabId).then(
    async (tab) => {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      await opening;
    },
    async () => {
      const job = await loadJob(tabId);
      if (job?.url) chrome.tabs.create({ url: job.url }).catch(() => {});
    },
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelLesson(tabId);
  chrome.storage.session.remove([jobKey(tabId), threadKey(tabId)]).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target) return;
  if (command === "solve-page") openSolver(target);
  else if (command === "copy-page") run(target, "auto");
});

async function run(tab, mode) {
  try {
    const stats = await copyTabs({ tabs: [tab], mode, writeClipboard });
    flashBadge("✓", "#16a34a", tab.id);
    notify("Copied for AI", `${stats.words.toLocaleString()} words · ~${stats.tokens.toLocaleString()} tokens`);
  } catch (err) {
    flashBadge("!", "#dc2626", tab.id);
    notify("Copy for AI", err.message || "Could not copy this page");
  }
}

function flashBadge(text, color, tabId) {
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 1800);
}

function notify(title, message, id, silent = true) {
  if (!chrome.notifications) return;
  const opts = { type: "basic", iconUrl: "icons/icon128.png", title, message, silent, requireInteraction: !silent };
  const done = () => void chrome.runtime.lastError;
  if (id) chrome.notifications.create(id, opts, done);
  else chrome.notifications.create(opts, done);
}

// --- Clipboard via offscreen document (service workers have no clipboard API)

let offscreenReady;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  offscreenReady ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD"],
    justification: "Write extracted Markdown to the clipboard from keyboard shortcut / context menu",
  });
  await offscreenReady;
  offscreenReady = undefined;
}

async function writeClipboard(text) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: "cfa-clipboard-write", text });
  if (!res?.ok) throw new Error("Clipboard write failed");
}
