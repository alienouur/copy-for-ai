const UNSUPPORTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|file):/;

export function isSupportedUrl(url) {
  return !!url && !UNSUPPORTED.test(url) && !url.startsWith("https://chrome.google.com/webstore") && !url.startsWith("https://chromewebstore.google.com");
}

export async function extractFromTab(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (o) => globalThis.__copyForAI.extract(o),
    args: [opts],
  });
  const doc = result && result.result;
  if (!doc) throw new Error("Could not read this page");
  if (doc.error === "no-selection") throw new Error("Select some text on the page first");
  return doc;
}

export async function ensureAllTabsPermission() {
  const wanted = { permissions: ["tabs"], origins: ["<all_urls>"] };
  if (await chrome.permissions.contains(wanted)) return true;
  return chrome.permissions.request(wanted);
}

export async function extractFromTabs(tabs, opts, onProgress) {
  const docs = [];
  const skipped = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    onProgress?.(i + 1, tabs.length);
    if (!isSupportedUrl(tab.url)) {
      skipped.push(tab.title || tab.url);
      continue;
    }
    try {
      docs.push(await extractFromTab(tab.id, { ...opts, mode: "page" }));
    } catch {
      skipped.push(tab.title || tab.url);
    }
  }
  return { docs, skipped };
}
