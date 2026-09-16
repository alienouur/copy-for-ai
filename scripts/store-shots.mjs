// Renders the Chrome Web Store screenshots (1280x800): a fixture quiz page next to the side panel.
// Solver responses are mocked so the shots are deterministic. Output: release/store/*.png
import { chromium } from "playwright";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const PANEL_W = 400;
const PAGE_W = 1280 - PANEL_W;
const H = 800;

const dist = path.resolve("dist-shots");
rmSync(dist, { recursive: true, force: true });
cpSync(path.resolve("dist"), dist, { recursive: true });
const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, "utf8"));
manifest.host_permissions = ["<all_urls>"];
manifest.permissions.push("tabs");
writeFileSync(`${dist}/manifest.json`, JSON.stringify(manifest));

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;font:16px/1.55 "Segoe UI",system-ui,sans-serif;color:#1f2937;background:#f3f4f6}
header{background:#1e3a8a;color:#fff;padding:14px 32px;font-weight:600;display:flex;justify-content:space-between}
header span{opacity:.75;font-weight:400}
main{max-width:720px;margin:28px auto;background:#fff;padding:28px 36px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 4px}.sub{color:#6b7280;margin:0 0 22px;font-size:14px}
.q{margin:0 0 20px}.q b{display:block;margin-bottom:6px}
.q label{display:block;padding:6px 10px;border:1px solid #e5e7eb;border-radius:6px;margin:4px 0}
.q input{margin-right:8px}
.timer{float:right;background:#fef3c7;color:#92400e;padding:2px 10px;border-radius:12px;font-size:13px}
.math{font-family:Georgia,serif;font-size:17px}
</style></head><body><header>Campus Learn <span>Student: Ali E. · Due today 23:59</span></header><main>${body}</main></body></html>`;

const quiz = page("Quiz 4 – Cell Biology", `
<span class="timer">⏱ 14:32 left</span><h1>Quiz 4 – Cell Biology</h1><p class="sub">BIO 101 · 5 questions · 10 points</p>
<div class="q"><b>1. Which organelle is known as the "powerhouse of the cell"?</b>
<label><input type="radio">A) Ribosome</label><label><input type="radio">B) Mitochondrion</label><label><input type="radio">C) Golgi apparatus</label><label><input type="radio">D) Lysosome</label></div>
<div class="q"><b>2. Which of the following is NOT found in a prokaryotic cell?</b>
<label><input type="radio">A) Ribosomes</label><label><input type="radio">B) Cell membrane</label><label><input type="radio">C) DNA</label><label><input type="radio">D) Nucleus</label></div>
<div class="q"><b>3. The process by which a cell engulfs large particles is called:</b>
<label><input type="radio">A) Phagocytosis</label><label><input type="radio">B) Osmosis</label><label><input type="radio">C) Exocytosis</label><label><input type="radio">D) Diffusion</label></div>
<div class="q"><b>4. During which phase of mitosis do chromosomes line up at the cell's equator?</b>
<label><input type="radio">A) Prophase</label><label><input type="radio">B) Anaphase</label><label><input type="radio">C) Metaphase</label><label><input type="radio">D) Telophase</label></div>
<div class="q"><b>5. True or false: Plant cells have a cell wall made of cellulose.</b>
<label><input type="radio">True</label><label><input type="radio">False</label></div>`);

const math = page("Homework 6 – Quadratic equations", `
<h1>Homework 6 – Quadratic equations</h1><p class="sub">MATH 110 · Show your work</p>
<div class="q math"><b>Exercise 1.</b> Solve for x: &nbsp; x² − 5x + 6 = 0</div>
<div class="q math"><b>Exercise 2.</b> Find the vertex of the parabola &nbsp; y = 2x² − 8x + 3</div>
<div class="q math"><b>Exercise 3.</b> For which values of k does &nbsp; x² + kx + 9 = 0 &nbsp; have exactly one real solution?</div>
<div class="q math"><b>Exercise 4.</b> A ball is thrown upward with h(t) = −5t² + 20t + 1. After how many seconds does it hit the ground? (round to 2 decimals)</div>`);

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url.startsWith("/math") ? math : quiz);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(tmpdir(), "cfa-shots-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  viewport: { width: PAGE_W, height: H },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const welcome = ctx.pages().find((p) => p.url().includes("welcome")) || (await ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null));
if (welcome) await welcome.close().catch(() => {});

mkdirSync("release/store", { recursive: true });
const site = await ctx.newPage();
await site.goto(`${base}/quiz`);
await site.bringToFront();
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);

const panel = await ctx.newPage();
await panel.setViewportSize({ width: PANEL_W, height: H });
await panel.addInitScript((id) => {
  const orig = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => {
    const tabs = await orig({});
    return q.active ? tabs.filter((t) => t.id === id) : tabs.filter((t) => !t.url.startsWith("chrome-extension://"));
  };
}, tabId);

let plan = { plan: "pro", remaining: 300, limit: 300, expired: false };
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
let nextAnswer = "";
await panel.route("**/v1/me", (route) => route.fulfill({ json: plan }));
await panel.route("**/v1/solve", (route) =>
  route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse([{ delta: nextAnswer }, { done: true, plan: plan.plan, remaining: plan.remaining, model: "gemini" }]) }),
);
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForSelector("#page-title");
const settled = () => panel.waitForFunction(() => document.querySelectorAll(".msg.model .bubble.streaming").length === 0 && !document.querySelector("button[disabled]#send-btn"), null, { timeout: 20000 });

// Shot 1: answer-only on the quiz
await panel.check("#answerOnly");
nextAnswer = "1. **B**\n2. **D**\n3. **A**\n4. **C**\n5. **True**";
await panel.click("#solve-btn");
await panel.waitForSelector(".msg.model");
await settled();
await panel.waitForTimeout(400);
await site.bringToFront();
await site.screenshot({ path: "release/store/_page1.png" });
await panel.bringToFront();
await panel.screenshot({ path: "release/store/_panel1.png" });

// Shot 2: math homework, explain a follow-up
await site.goto(`${base}/math`);
await panel.waitForSelector("#empty:not([hidden])", { timeout: 10000 });
nextAnswer = "1. x = 2 or x = 3\n2. Vertex (2, −5)\n3. k = 6 or k = −6\n4. t ≈ 4.05 s";
await panel.click("#solve-btn");
await panel.waitForSelector(".msg.model");
await settled();
nextAnswer = "**Exercise 3 – step by step**\n\nA quadratic has exactly one real solution when its discriminant is zero:\n\n1. Discriminant: Δ = b² − 4ac = k² − 4·1·9 = k² − 36\n2. Set Δ = 0 → k² = 36\n3. Solve → **k = 6** or **k = −6**\n\nCheck: k = 6 gives (x + 3)² = 0, a single root x = −3.";
await panel.uncheck("#answerOnly");
await panel.fill("#question", "explain #3");
await panel.press("#question", "Enter");
await panel.waitForFunction(() => document.querySelectorAll(".msg").length === 4, null, { timeout: 20000 });
await settled();
await panel.waitForTimeout(400);
await site.bringToFront();
await site.screenshot({ path: "release/store/_page2.png" });
await panel.bringToFront();
await panel.screenshot({ path: "release/store/_panel2.png" });

// Shot 3: copy tools (Markdown) on the same page
await panel.click("#copy-tools summary");
await panel.waitForTimeout(300);
await panel.bringToFront();
await panel.screenshot({ path: "release/store/_panel3.png" });

// Shot 4: options page (license)
const options = await ctx.newPage();
await options.setViewportSize({ width: 1280, height: H });
await options.goto(`chrome-extension://${extId}/options.html#license`);
await options.waitForTimeout(500);
await options.bringToFront();
await options.screenshot({ path: "release/store/_options.png" });

await ctx.close();
server.close();
console.log("shots rendered");
