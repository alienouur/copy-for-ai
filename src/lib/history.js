import { HISTORY_ITEM_CHAR_LIMIT, MAX_HISTORY } from "./config.js";

export async function getHistory() {
  const { history } = await chrome.storage.local.get("history");
  return history || [];
}

export async function addHistory(entry) {
  const history = await getHistory();
  history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    title: entry.title,
    url: entry.url,
    tabs: entry.tabs || 1,
    tokens: entry.tokens,
    text: entry.text.slice(0, HISTORY_ITEM_CHAR_LIMIT),
  });
  await chrome.storage.local.set({ history: history.slice(0, MAX_HISTORY) });
}

export async function removeHistory(id) {
  const history = await getHistory();
  await chrome.storage.local.set({ history: history.filter((h) => h.id !== id) });
}

export async function clearHistory() {
  await chrome.storage.local.remove("history");
}
