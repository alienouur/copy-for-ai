// Loads dist/ into a throwaway Chrome profile and exercises extraction, the side panel and options.
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

// 2) side panel: patch tabs.query so the panel targets the article tab
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 400, height: 720 });
await popup.addInitScript((tabId) => {
  const orig = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => {
    const tabs = await orig({});
    if (q.active) return tabs.filter((t) => t.id === tabId);
    return tabs.filter((t) => !t.url.startsWith("chrome-extension://"));
  };
}, articleTabId);
// Mock the solver API (SSE stream) so the test needs neither Gemini nor the live server.
const solveCalls = [];
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
await popup.route("**/v1/me", (route) =>
  route.fulfill({ json: { plan: "free", remaining: 5 - solveCalls.length, limit: 5, expired: false } }),
);
await popup.route("**/v1/solve", (route) => {
  const body = route.request().postDataJSON();
  solveCalls.push(body);
  if (solveCalls.length === 4) return route.fulfill({ status: 402, json: { detail: "You've used today's free answers." } });
  const deltas = body.mode === "answer" ? ["**4", "2**"] : ["## Steps\n\n1. Read the page\n", "2. Think\n\nFinal answer: **42**"];
  const events = [...deltas.map((delta) => ({ delta })), { done: true, plan: "free", remaining: 5 - solveCalls.length, model: "mock" }];
  return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse(events) });
});
await popup.goto(`chrome-extension://${extId}/sidepanel.html`);
await popup.waitForFunction(() => /free left/.test(document.getElementById("quota").textContent));
console.log("quota:", await popup.textContent("#quota"));
console.log("page title:", await popup.textContent("#page-title"));
if (!/Markdown/.test(await popup.textContent("#page-title"))) throw new Error("page bar does not show the active tab");

const lastAnswer = () => popup.locator(".msg.model .bubble").last();
const settled = () => popup.waitForFunction(() => document.querySelectorAll(".msg.model .bubble.streaming").length === 0 && !document.querySelector("button[disabled]#send-btn"), null, { timeout: 20000 });

// 2a) Solve: answer-only with text + screenshot, streamed
await popup.check("#answerOnly");
await popup.check("#sendScreenshot");
await popup.click("#solve-btn");
await popup.waitForSelector(".msg.model", { timeout: 20000 });
await settled();
let req = solveCalls.at(-1);
console.log("solve request:", { mode: req.mode, stream: req.stream, textChars: req.text.length, imageChars: req.image?.length ?? 0, history: req.history.length });
if (req.mode !== "answer" || req.stream !== true || req.history.length !== 0 || !req.text.includes("Markdown") || !req.image || req.image.length < 5000) throw new Error("solve request payload wrong");
if (req.image.startsWith("data:")) throw new Error("image must be raw base64");
if ((await lastAnswer().textContent()).trim() !== "42" || !(await lastAnswer().locator("strong").count())) throw new Error("answer not rendered");
const meta1 = await popup.locator(".msg.model .meta").last().textContent();
console.log("answer meta:", meta1);
if (!/page text \+ screenshot/.test(meta1)) throw new Error("answer meta wrong");
if ((await popup.locator(".msg.user .bubble").first().textContent()) !== "Solve the questions on this page.") throw new Error("user turn missing");
await popup.locator(".msg.model .copy").last().click();
if ((await popup.evaluate(() => navigator.clipboard.readText())) !== "**42**") throw new Error("copy answer failed");
if (await popup.isHidden("#chips")) throw new Error("follow-up chips should show after an answer");

// 2b) Follow-up question (Enter) carries the conversation; no screenshot this time
await popup.uncheck("#sendScreenshot");
await popup.fill("#question", "why?");
await popup.press("#question", "Enter");
await popup.waitForFunction(() => document.querySelectorAll(".msg").length === 4, null, { timeout: 20000 });
await settled();
req = solveCalls.at(-1);
console.log("follow-up request:", { mode: req.mode, question: req.question, history: req.history.map((t) => `${t.role}:${t.text.slice(0, 12)}`) });
if (req.mode !== "answer" || req.image !== null || req.question !== "why?" || req.history.length !== 2) throw new Error("follow-up request wrong");
if (req.history[0].role !== "user" || req.history[1].role !== "model" || req.history[1].text !== "**42**") throw new Error("history content wrong");
if ((await popup.inputValue("#question")) !== "") throw new Error("composer should clear after sending");

// Explain button on an answer -> explain-mode follow-up with Markdown headings/lists
await popup.locator(".msg.model .explain").last().click();
await popup.waitForFunction(() => document.querySelector("#messages h4"), null, { timeout: 20000 });
await settled();
req = solveCalls.at(-1);
if (req.mode !== "explain" || req.history.length !== 4 || !/step by step/.test(req.question)) throw new Error("explain request wrong");
if ((await lastAnswer().locator("ol li").count()) !== 2) throw new Error("markdown list not rendered");
if (!(await popup.locator(".msg.model .explain").last().isHidden())) throw new Error("explain button should hide on explain answers");
await popup.screenshot({ path: "release/screenshot-sidepanel.png" });

// Thread survives a panel reload and a page refresh, resets on navigation to another page
await popup.reload();
await popup.waitForFunction(() => document.querySelectorAll(".msg").length === 6, null, { timeout: 10000 });
await article.reload({ waitUntil: "domcontentloaded" });
await popup.waitForTimeout(1000);
if ((await popup.locator(".msg").count()) !== 6) throw new Error("thread lost after page refresh");
console.log("thread persisted across panel reload + page refresh");
await article.goto("https://en.wikipedia.org/wiki/Markdown?e2e=nav", { waitUntil: "domcontentloaded" });
await popup.waitForSelector("#empty:not([hidden])", { timeout: 10000 });
if ((await popup.locator(".msg").count()) !== 0) throw new Error("thread should reset on navigation");
console.log("thread reset on navigation");

// 2c) Quota exhausted -> upgrade prompt, failed turn is rolled back
await popup.fill("#question", "q4");
await popup.click("#send-btn");
await popup.waitForSelector(".status.err", { timeout: 20000 });
const quotaMsg = await popup.textContent("#status");
console.log("quota error:", quotaMsg);
if (!/free answers/.test(quotaMsg) || !(await popup.locator("#status a[href*='stripe.com']").count())) throw new Error("402 handling wrong");
if ((await popup.locator(".msg").count()) !== 0 || (await popup.inputValue("#question")) !== "q4") throw new Error("failed turn should be rolled back");

// 2d) Copy tools still work
await popup.click("#copy-tools summary");
await popup.selectOption("#template", "summarize");
await popup.click("#copy-page");
await popup.waitForSelector("#copy-status.ok", { timeout: 15000 });
console.log("copy status:", await popup.textContent("#copy-status"));
const clip = await popup.evaluate(() => navigator.clipboard.readText());
console.log("clipboard starts with:", JSON.stringify(clip.slice(0, 120)));
if (!clip.startsWith("Summarize the following page") || !clip.includes("# Markdown")) throw new Error("clipboard content wrong");
await popup.screenshot({ path: "release/screenshot-copytools.png" });

// selection with nothing selected -> friendly error
await popup.click("#copy-selection");
await popup.waitForSelector("#copy-status.err", { timeout: 15000 });
console.log("selection error:", await popup.textContent("#copy-status"));

// 3) all-tabs (free trial path)
const second = await ctx.newPage();
await second.goto("https://example.com/", { waitUntil: "domcontentloaded" });
await popup.bringToFront();
await popup.click("#copy-tabs");
await popup.waitForSelector("#copy-status.ok", { timeout: 30000 });
const tabsStatus = await popup.textContent("#copy-status");
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
