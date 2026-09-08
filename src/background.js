import { copyTabs } from "./lib/copy.js";
import { LANDING_URL } from "./lib/config.js";

const MENU_PAGE = "cfa-copy-page";
const MENU_SELECTION = "cfa-copy-selection";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Copy page for AI (Markdown)", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Copy selection for AI (Markdown)", contexts: ["selection"] });
  });
  if (reason === "install") {
    chrome.tabs.create({ url: `${LANDING_URL}/welcome.html` }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  run(tab, info.menuItemId === MENU_SELECTION ? "selection" : "page");
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "copy-page") return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) run(target, "auto");
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

function notify(title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, silent: true }, () => void chrome.runtime.lastError);
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
