// Loads dist/ into a throwaway Chrome profile and exercises extraction, popup and options.
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Automation can't perform the toolbar click that grants activeTab, so the
// test build gets static host permissions instead. Extraction code is identical.
const dist = path.resolve("dist-test");
rmSync(dist, { recursive: true, force: true });
cpSync(path.resolve("dist"), dist, { recursive: true });
const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, "utf8"));
manifest.host_permissions = ["<all_urls>"];
manifest.permissions.push("tabs");
writeFileSync(`${dist}/manifest.json`, JSON.stringify(manifest));

const profile = mkdtempSync(path.join(tmpdir(), "cfa-profile-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  viewport: { width: 1200, height: 800 },
});
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
console.log("extension id", extId);

// Close the welcome tab opened on install so it doesn't count in the all-tabs bundle.
const welcome =
  ctx.pages().find((p) => p.url().includes("welcome")) ||
  (await ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null));
if (welcome) await welcome.close().catch(() => {});

const article = await ctx.newPage();
await article.goto("https://en.wikipedia.org/wiki/Markdown", { waitUntil: "domcontentloaded" });
await article.bringToFront();
const articleTabId = await sw.evaluate(async () => {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t.id;
});

// 1) raw extraction through the same path the popup uses
const doc = await sw.evaluate(async (tabId) => {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (o) => globalThis.__copyForAI.extract(o),
    args: [{ mode: "page", includeLinks: true, includeImages: false }],
  });
  return r.result;
}, articleTabId);
console.log("title:", doc.title);
console.log("markdown chars:", doc.markdown.length);
console.log("--- first 600 chars ---\n" + doc.markdown.slice(0, 600) + "\n---");
if (!/Markdown/.test(doc.title) || doc.markdown.length < 2000 || !/^#+ /m.test(doc.markdown)) {
  throw new Error("extraction looks wrong");
}

// 2) popup: patch tabs.query so the popup targets the article tab
const popup = await ctx.newPage();
await popup.addInitScript((tabId) => {
  const orig = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => {
    const tabs = await orig({});
    if (q.active) return tabs.filter((t) => t.id === tabId);
    return tabs.filter((t) => !t.url.startsWith("chrome-extension://"));
  };
}, articleTabId);
// Mock the solver API so the test needs neither Gemini nor the live server.
const solveCalls = [];
await popup.route("**/v1/me", (route) =>
  route.fulfill({ json: { plan: "free", remaining: 5 - solveCalls.length, limit: 5, expired: false } }),
);
await popup.route("**/v1/solve", (route) => {
  const body = route.request().postDataJSON();
  solveCalls.push(body);
  if (solveCalls.length === 3) return route.fulfill({ status: 402, json: { detail: "You've used today's free answers." } });
  const answer = body.mode === "answer" ? "**42**" : "## Steps\n\n1. Read the page\n2. Think\n\nFinal answer: **42**";
  return route.fulfill({ json: { answer, plan: "free", remaining: 5 - solveCalls.length, model: "mock" } });
});
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForFunction(() => /free answers? left/.test(document.getElementById("quota").textContent));
console.log("quota:", await popup.textContent("#quota"));

// 2a) Solve: answer-only with text + screenshot
await popup.check("#answerOnly");
await popup.check("#sendScreenshot");
await popup.click("#solve-btn");
await popup.waitForSelector("#answer-box:not([hidden])", { timeout: 20000 });
let req = solveCalls.at(-1);
console.log("solve request:", { mode: req.mode, textChars: req.text.length, imageChars: req.image?.length ?? 0, device: req.device_id.length });
if (req.mode !== "answer" || !req.text.includes("Markdown") || !req.image || req.image.length < 5000) throw new Error("solve request payload wrong");
if (req.image.startsWith("data:")) throw new Error("image must be raw base64");
if ((await popup.textContent("#answer")).trim() !== "42" || !(await popup.locator("#answer strong").count())) throw new Error("answer not rendered");
console.log("answer meta:", await popup.textContent("#answer-meta"));
if (!/page text \+ screenshot/.test(await popup.textContent("#answer-meta"))) throw new Error("answer meta wrong");
await popup.click("#copy-answer");
if ((await popup.evaluate(() => navigator.clipboard.readText())) !== "**42**") throw new Error("copy answer failed");
await popup.screenshot({ path: "release/screenshot-solve.png" });

// 2b) Explain, no screenshot, with a typed question
await popup.uncheck("#sendScreenshot");
await popup.fill("#question", "only question 3");
await popup.click("#explain-btn");
await popup.waitForFunction(() => document.querySelector("#answer h4"), null, { timeout: 20000 });
req = solveCalls.at(-1);
if (req.mode !== "explain" || req.image !== null || req.question !== "only question 3") throw new Error("explain request wrong");
if ((await popup.locator("#answer ol li").count()) !== 2) throw new Error("markdown list not rendered");
if (!(await popup.isHidden("#explain-btn"))) throw new Error("explain button should hide in explain mode");

// 2c) Quota exhausted -> upgrade prompt
await popup.click("#solve-btn");
await popup.waitForSelector(".status.err", { timeout: 20000 });
const quotaMsg = await popup.textContent("#status");
console.log("quota error:", quotaMsg);
if (!/free answers/.test(quotaMsg) || !(await popup.locator("#status a[href*='stripe.com']").count())) throw new Error("402 handling wrong");

// 2d) Copy tools still work
await popup.click("#copy-tools summary");
await popup.selectOption("#template", "summarize");
await popup.click("#copy-page");
await popup.waitForSelector(".status.ok", { timeout: 15000 });
console.log("popup status:", await popup.textContent("#status"));
const clip = await popup.evaluate(() => navigator.clipboard.readText());
console.log("clipboard starts with:", JSON.stringify(clip.slice(0, 120)));
if (!clip.startsWith("Summarize the following page") || !clip.includes("# Markdown")) throw new Error("clipboard content wrong");
await popup.screenshot({ path: "release/screenshot-popup.png" });

// selection with nothing selected -> friendly error
await popup.click("#copy-selection");
await popup.waitForSelector(".status.err", { timeout: 15000 });
console.log("selection error:", await popup.textContent("#status"));

// 3) all-tabs (free trial path)
const second = await ctx.newPage();
await second.goto("https://example.com/", { waitUntil: "domcontentloaded" });
await popup.bringToFront();
await popup.click("#copy-tabs");
await popup.waitForSelector(".status.ok", { timeout: 30000 });
const tabsStatus = await popup.textContent("#status");
console.log("all tabs status:", tabsStatus);
if (!/2 tabs copied/.test(tabsStatus) || !/Free trial: 4/.test(tabsStatus)) throw new Error("all-tabs bundling failed");
const bundle = await popup.evaluate(() => navigator.clipboard.readText());
if (!bundle.includes("\n---\n") || !bundle.includes("Example Domain")) throw new Error("bundle content wrong");

// 4) options page renders, license rejects garbage/tampered keys and accepts a signed one
const options = await ctx.newPage();
await options.goto(`chrome-extension://${extId}/options.html#license`);
async function tryKey(key) {
  await options.fill("#license-key", key);
  await options.click("#license-activate");
  await options.waitForSelector("#license-msg.err, #license-msg.ok", { timeout: 20000, state: "attached" });
  const cls = await options.getAttribute("#license-msg", "class");
  console.log("license msg:", await options.textContent("#license-msg"));
  return cls.includes("ok");
}
if (await tryKey("not-a-real-key")) throw new Error("garbage key accepted");
await options.screenshot({ path: "release/screenshot-options.png", fullPage: true });
if (process.env.TEST_LICENSE_KEY) {
  const real = process.env.TEST_LICENSE_KEY.trim();
  const tampered = real.replace(/\.([^.]+)$/, (m, sig) => "." + (sig[0] === "A" ? "B" : "A") + sig.slice(1));
  if (await tryKey(tampered)) throw new Error("tampered key accepted");
  if (!(await tryKey(real))) throw new Error("signed key rejected");
  if (!(await options.isVisible("#license-active"))) throw new Error("pro card not shown");
  await options.reload();
  if ((await options.textContent("#plan")) !== "Plan: Pro") throw new Error("pro not persisted");
}

writeFileSync("release/sample-output.md", clip);
console.log("OK");
await ctx.close();
