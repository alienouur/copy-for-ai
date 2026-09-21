// Loads dist/ into a throwaway Chrome profile and exercises extraction, the side panel and options.
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// Local stand-in for the answer server: the background worker's lesson agent talks to it directly
// (page.route can't intercept service-worker fetches), and it also serves a long lesson page.
const lessonCalls = [];
let lessonDelayMs = 0;
let lessonFailAt = 0; // 1-based index of the request that should be rejected with 402
// Prose lesson without answer fields or numbered questions -> the agent falls back to text chunks.
const sections = Array.from({ length: 60 }, (_, i) =>
  `<h3>Section ${i + 1}</h3><p>${`Compute the value of the expression ${i + 1} + ${i + 2} and explain the property used. `.repeat(6)}</p>`,
).join("\n");
const lessonHtml = `<!doctype html><html><head><title>Algebra Lesson 3</title></head><body><article><h1>Algebra Lesson 3</h1><p>${"This lesson covers addition. ".repeat(20)}</p>${sections}</article></body></html>`;
// Quiz with every kind of answer field; the agent must fill it in place and never submit.
const quizHtml = `<!doctype html><html><head><title>Maths Quiz 1</title></head><body>
<nav><input type="search" name="q" placeholder="Search"></nav>
<form id="quiz" action="/submitted" method="post">
<fieldset><legend>1. What is 6 × 7?</legend>
<label><input type="radio" name="q1" value="a"> 40</label>
<label><input type="radio" name="q1" value="b"> 42</label>
<label><input type="radio" name="q1" value="c"> 48</label></fieldset>
<div class="question"><p>2. Which of these numbers are prime? (tick all that apply)</p>
<ul><li><label><input type="checkbox" name="p2"> 2</label></li><li><label><input type="checkbox" name="p3"> 3</label></li><li><label><input type="checkbox" name="p4" checked> 4</label></li></ul></div>
<p>3. The capital of France is <select name="q3"><option value="">Choose…</option><option value="rome">Rome</option><option value="paris">Paris</option></select></p>
<p>4. Solve x + 1 = 3. Then x = <input type="text" name="q4"></p>
<p>5. Explain briefly why the sky is blue.</p><textarea name="q5" rows="3"></textarea>
<p><label><input type="checkbox" name="agree"> I agree to the terms</label></p>
<button type="submit">Submit</button>
</form>
<script>document.getElementById("quiz").addEventListener("submit", (e) => { e.preventDefault(); window.__submitted = (window.__submitted || 0) + 1; });
window.__changes = []; document.addEventListener("change", (e) => window.__changes.push(e.target.name));</script>
</body></html>`;
// Worksheet without any fields: answers are shown next to each numbered question.
const worksheetHtml = `<!doctype html><html><head><title>Worksheet</title></head><body><article><h1>Fractions worksheet</h1>
<p>Answer the following.</p><ol><li>What is 1/2 + 1/4?</li><li>Simplify 6/8.</li><li>Is 3/5 bigger than 1/2?</li></ol></article></body></html>`;
// Three-step course: real navigation (Next), drag-and-drop matching + Check that reveals Next, an SPA step swap, a form
// Submit that navigates to a results page. Every click is logged in localStorage so the test can see the exact sequence.
const courseHead = `<!doctype html><html><head><title>Geography course</title><meta charset="utf-8"><style>.dropzone{display:inline-block;min-width:120px;min-height:32px;border:1px dashed #888;vertical-align:middle}[draggable]{display:inline-block;padding:4px 8px;border:1px solid #333;margin:4px;cursor:grab}</style></head><body>
<script>window.log = (e) => localStorage.setItem("__log", (localStorage.getItem("__log") || "") + e + ";");</script>
<nav><a href="/course/1.html">Course home</a><button onclick="log('nav-menu')">Menu</button></nav>`;
const coursePages = {
  "/course/1.html": `${courseHead}<h1>Step 1 of 3</h1><form id="f1">
<fieldset><legend>1. What is 6 × 7?</legend><label><input type="radio" name="q1" value="a"> 40</label><label><input type="radio" name="q1" value="b"> 42</label><label><input type="radio" name="q1" value="c"> 48</label></fieldset>
<button type="button" onclick="log('back')">Back</button> <button type="button" id="next">Next</button></form>
<script>document.getElementById("next").onclick = () => { log("next1:" + (document.querySelector("input[name=q1]:checked")?.value || "none")); location.href = "/course/2.html"; };</script></body></html>`,
  "/course/2.html": `${courseHead}<h1>Step 2 of 3</h1><main id="step">
<section id="match"><h2>2. Drag each capital onto its country</h2>
<div class="items"><span draggable="true" id="i-paris">Paris</span><span draggable="true" id="i-rome">Rome</span><span draggable="true" id="i-berlin">Berlin</span></div>
<table><tr><td>France</td><td><span class="dropzone" data-accept="i-paris"></span></td></tr><tr><td>Italy</td><td><span class="dropzone" data-accept="i-rome"></span></td></tr></table>
<button type="button" id="check">Check</button> <button type="button" id="next2" hidden>Next</button><p id="feedback"></p></section></main>
<script>
for (const d of document.querySelectorAll("[draggable]")) d.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text", d.id); log("dragstart:" + d.id); });
for (const z of document.querySelectorAll(".dropzone")) {
  z.addEventListener("dragover", (e) => e.preventDefault());
  z.addEventListener("drop", (e) => { e.preventDefault(); const el = document.getElementById(e.dataTransfer.getData("text")); if (el) { z.replaceChildren(el); log("drop:" + el.id + ">" + z.dataset.accept); } });
}
document.getElementById("check").onclick = () => {
  const ok = [...document.querySelectorAll(".dropzone")].filter((z) => z.firstElementChild?.id === z.dataset.accept).length;
  document.getElementById("feedback").textContent = ok + " of 2 correct";
  log("check:" + ok);
  document.getElementById("next2").hidden = false;
};
document.getElementById("next2").onclick = () => {
  log("next2");
  document.getElementById("step").innerHTML = '<form action="/course/done.html" method="get"><p>3. Solve x + 1 = 3. Then x = <input type="text" name="q3"></p><button type="button" onclick="log(&quot;reset&quot;)">Reset</button> <button type="submit">Submit</button></form>';
  document.querySelector("#step form").addEventListener("submit", () => log("submit:" + document.querySelector("input[name=q3]").value));
};
</script></body></html>`,
  "/course/done.html": `${courseHead}<h1>Results</h1><p>You have completed the course. Score: 3 / 3.</p>
<button type="button" onclick="log('review')">Review answers</button> <button type="button" onclick="log('again')">Try again</button> <a href="/course/1.html" class="btn" onclick="log('back-course')">Back to course</a></body></html>`,
};
const ANSWER_KEY = { "40": false, "42": true, "2": true, "3": true, "4": false, "Paris": true, "Rome": false };
const MATCH_KEY = { France: "Paris", Italy: "Rome" };
function fillAnswers(text) {
  const answers = [];
  let current = null;
  let type = "";
  for (const line of text.split("\n")) {
    const q = line.match(/^Q (\S+) \[(\w+)\]: (.*)$/);
    if (q) {
      type = q[2];
      current = { id: q[1], option_ids: [], pairs: [], options: {}, text: /x \+ 1/.test(q[3]) ? "2" : /sky/.test(q[3]) ? "Rayleigh scattering of sunlight" : `Answer for ${q[1]}` };
      answers.push(current);
      continue;
    }
    const o = line.match(/^- (\S+): (.*)$/);
    if (o && current) current.options[o[2].trim()] = o[1];
    if (o && current && type !== "match" && ANSWER_KEY[o[2].trim()]) {
      current.option_ids.push(o[1]);
      current.text = o[2].trim();
    }
    const t = line.match(/^> (\S+): (.*)$/);
    if (t && current && MATCH_KEY[t[2].trim()] && current.options[MATCH_KEY[t[2].trim()]]) {
      current.pairs.push({ option_id: current.options[MATCH_KEY[t[2].trim()]], target_id: t[1] });
      current.text = current.pairs.length === 1 ? `${MATCH_KEY[t[2].trim()]} → ${t[2].trim()}` : `${current.text}; ${MATCH_KEY[t[2].trim()]} → ${t[2].trim()}`;
    }
  }
  return answers.map(({ options, ...a }) => a);
}
const mock = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const pathname = req.url.split("?")[0];
    return res.end(coursePages[pathname] || (pathname.startsWith("/quiz") ? quizHtml : pathname.startsWith("/worksheet") ? worksheetHtml : lessonHtml));
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const reply = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url === "/v1/me") return reply(200, { plan: "free", remaining: 5, limit: 5, expired: false });
    lessonCalls.push(body);
    const n = lessonCalls.length;
    setTimeout(() => {
      if (n === lessonFailAt) return reply(402, { detail: "You've used today's free answers." });
      if (body.mode === "fill") return reply(200, { answers: fillAnswers(body.text), plan: "free", remaining: Math.max(0, 5 - n), model: "mock" });
      reply(200, { answer: `**Answers for part ${n}**\n\n1. ${n * 10}`, plan: "free", remaining: Math.max(0, 5 - n), model: "mock" });
    }, lessonDelayMs);
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

// Automation can't perform the toolbar click that grants activeTab, so the
// test build gets static host permissions instead. Extraction code is identical.
const dist = path.resolve("dist-test");
rmSync(dist, { recursive: true, force: true });
cpSync(path.resolve("dist"), dist, { recursive: true });
const manifest = JSON.parse(readFileSync(`${dist}/manifest.json`, "utf8"));
manifest.host_permissions = ["<all_urls>"];
manifest.permissions.push("tabs");
writeFileSync(`${dist}/manifest.json`, JSON.stringify(manifest));
const bg = readFileSync(`${dist}/background.js`, "utf8");
if (!bg.includes("https://copyforai-license.onrender.com")) throw new Error("license API url not found in background bundle");
writeFileSync(`${dist}/background.js`, bg.replaceAll("https://copyforai-license.onrender.com", mockUrl));

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
sw.on("console", (m) => console.log("[sw]", m.text()));

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
async function openPanel() {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 400, height: 720 });
  await page.addInitScript((tabId) => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      const tabs = await orig({});
      if (q.active) return tabs.filter((t) => t.id === tabId);
      return tabs.filter((t) => !t.url.startsWith("chrome-extension://"));
    };
  }, articleTabId);
  return page;
}
let popup = await openPanel();
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

// 2e) Whole-lesson agent: runs in the worker, chunks the lesson, survives the panel closing, notifies when done
await sw.evaluate(() => {
  globalThis.__notes = [];
  chrome.notifications.create = (id, opts, cb) => {
    globalThis.__notes.push({ id, ...opts });
    cb?.(id);
  };
});
await article.goto(`${mockUrl}/lesson.html`, { waitUntil: "domcontentloaded" });
await popup.waitForFunction(() => /Algebra Lesson/.test(document.getElementById("page-title").textContent));
await popup.check("#answerOnly");
lessonDelayMs = 1500;
await popup.click("#lesson-btn");
await popup.waitForSelector("#job.running", { timeout: 10000 });
await popup.waitForFunction(() => /\/\d+$/.test(document.getElementById("job-count").textContent), null, { timeout: 20000 });
console.log("lesson job started:", await popup.textContent("#job-count"), "-", await popup.textContent("#job-msg"));
if (await popup.isHidden("#job-cancel") || !(await popup.isDisabled("#lesson-btn"))) throw new Error("running job should show Cancel and lock the agent button");
// Closing the side panel must not stop the agent.
await popup.close();
const panel2 = await openPanel();
await panel2.route("**/v1/me", (route) => route.fulfill({ json: { plan: "free", remaining: 5, limit: 5, expired: false } }));
await panel2.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel2.waitForSelector("#job.done", { timeout: 60000 });
const total = Number((await panel2.textContent("#job-count")).split("/")[1]);
console.log("lesson job done:", await panel2.textContent("#job-count"), "-", await panel2.textContent("#job-msg"), "- parts:", lessonCalls.length);
if (total < 3 || lessonCalls.length !== total) throw new Error("lesson should be split into several parts, one request each");
const part1 = lessonCalls[0];
if (part1.stream !== false || part1.mode !== "answer" || !/part 1 of \d+/.test(part1.question) || !part1.text.includes("Section 1") || part1.text.length > 13000) throw new Error("lesson part request wrong");
if (!lessonCalls.at(-1).text.includes("Section 60")) throw new Error("last part should contain the end of the lesson");
if (lessonCalls.some((c, i) => i && /Section 1(?!\d)/.test(c.text))) throw new Error("parts overlap");
if (!(await panel2.isHidden("#job-cancel")) || (await panel2.isVisible("#job-cancel"))) throw new Error("Cancel should hide once done");
const lessonMsgs = await panel2.locator(".msg").count();
const lessonAnswer = await panel2.locator(".msg.model .bubble").last().textContent();
const lessonMeta = await panel2.locator(".msg.model .meta").last().textContent();
console.log("lesson meta:", lessonMeta);
if (lessonMsgs !== 2 || !lessonAnswer.includes("Part 1") || !lessonAnswer.includes(`Part ${total}`) || !lessonAnswer.includes(`${total * 10}`)) throw new Error("compiled lesson answer not in thread");
if (!/Agent · page text/.test(lessonMeta)) throw new Error("lesson meta wrong");
if ((await panel2.locator(".msg.user .bubble").first().textContent()) !== "Solve the whole lesson on this page.") throw new Error("lesson user turn missing");
const notes = await sw.evaluate(() => globalThis.__notes);
console.log("notifications:", notes.map((n) => `${n.id}: ${n.title} – ${n.message}`));
if (notes.length !== 1 || !/Lesson solved/.test(notes[0].title) || !notes[0].message.includes(`${total} parts`) || notes[0].silent !== false) throw new Error("completion notification wrong");
await panel2.screenshot({ path: "release/screenshot-agent.png" });
// Notification click re-opens the panel for that tab (sidePanel.open needs a gesture, so it may throw; the fallback must not create a tab).
await sw.evaluate(async (id) => {
  globalThis.__opened = [];
  chrome.sidePanel.open = async (o) => void globalThis.__opened.push(o);
  await new Promise((r) => setTimeout(r, 0));
  chrome.notifications.onClicked.dispatch(id);
}, notes[0].id);
await panel2.waitForTimeout(500);
const opened = await sw.evaluate(() => globalThis.__opened);
if (opened.length !== 1 || opened[0].tabId !== articleTabId) throw new Error("notification click should open the side panel for the lesson tab");
await panel2.bringToFront();
await panel2.click("#job-dismiss");
if (!(await panel2.isHidden("#job"))) throw new Error("dismiss should hide the job card");

// Cancel stops after the current part; partial answers are kept.
const before = lessonCalls.length;
await panel2.click("#lesson-chip");
await panel2.waitForFunction(() => /^2\//.test(document.getElementById("job-count").textContent), null, { timeout: 20000, polling: 50 });
await panel2.click("#job-cancel");
await panel2.waitForSelector("#job.cancelled", { timeout: 20000 });
console.log("cancelled:", await panel2.textContent("#job-msg"), "- requests:", lessonCalls.length - before);
if (lessonCalls.length - before !== 2 || !/Stopped after 2 of/.test(await panel2.textContent("#job-msg"))) throw new Error("cancel should stop after the in-flight part");
if ((await panel2.locator(".msg").count()) !== 4 || !/2 of \d+ parts/.test(await panel2.locator(".msg.model .meta").last().textContent())) throw new Error("partial answers should be appended");
if ((await sw.evaluate(() => globalThis.__notes.length)) !== 1) throw new Error("no notification expected on cancel");
await sw.evaluate(() => (globalThis.__notes = []));

// Quota error mid-way -> failed job with upgrade link + notification, partial answers kept.
lessonDelayMs = 0;
lessonCalls.length = 0;
lessonFailAt = 2;
await panel2.click("#job-dismiss");
await panel2.click("#lesson-chip");
await panel2.waitForSelector("#job.error", { timeout: 30000 });
console.log("failed:", await panel2.textContent("#job-msg"));
if (lessonCalls.length !== 2 || !/free answers/.test(await panel2.textContent("#job-msg")) || !(await panel2.locator("#job-msg a[href*='stripe.com']").count())) throw new Error("402 in agent should stop and offer upgrade");
if ((await panel2.locator(".msg").count()) !== 6 || !/1 of \d+ parts/.test(await panel2.locator(".msg.model .meta").last().textContent())) throw new Error("partial answer should be kept on failure");
const failNotes = await sw.evaluate(() => globalThis.__notes);
if (failNotes.length !== 1 || !/stopped/.test(failNotes[0].title) || !/1 of \d+ parts done/.test(failNotes[0].message)) throw new Error("failure notification wrong");
// The failed state is still there when the panel is reopened later.
await panel2.close();
popup = await openPanel();
await popup.route("**/v1/me", (route) => route.fulfill({ json: { plan: "free", remaining: 5, limit: 5, expired: false } }));
await popup.goto(`chrome-extension://${extId}/sidepanel.html`);
await popup.waitForSelector("#job.error", { timeout: 10000 });
await popup.click("#job-dismiss");
await popup.click("#new-chat");

// 2f) Quiz page: the agent answers in place - radios / checkboxes / select / text / textarea - on the same tab. With
// "Auto-submit & next" off it must leave the Submit button alone.
lessonFailAt = 0;
lessonCalls.length = 0;
await sw.evaluate(() => (globalThis.__notes = []));
if (!(await popup.isChecked("#autoSubmit"))) throw new Error("auto-submit should be on by default");
await popup.uncheck("#autoSubmit");
await article.goto(`${mockUrl}/quiz.html`, { waitUntil: "domcontentloaded" });
await popup.waitForFunction(() => /Maths Quiz/.test(document.getElementById("page-title").textContent));
await popup.click("#lesson-btn");
await popup.waitForSelector("#job.done", { timeout: 30000 });
console.log("quiz job:", await popup.textContent("#job-count"), "-", await popup.textContent("#job-msg"));
if (lessonCalls.length !== 1 || lessonCalls[0].mode !== "fill" || lessonCalls[0].stream !== false) throw new Error("quiz should be one fill request");
const qText = lessonCalls[0].text;
console.log("fill request:\n" + qText);
const qIds = [...qText.matchAll(/^Q (\S+) \[(\w+)\]: (.*)$/gm)].map((m) => [m[2], m[3]]);
if (qIds.length !== 5) throw new Error(`expected 5 questions, got ${qIds.length}`);
if (qIds.map((q) => q[0]).join() !== "choice,multi,select,text,text") throw new Error("question types wrong: " + qIds.map((q) => q[0]).join());
if (!/6 × 7/.test(qIds[0][1]) || !/prime/.test(qIds[1][1]) || !/capital of France/.test(qIds[2][1]) || !/x \+ 1 = 3/.test(qIds[3][1]) || !/sky is blue/.test(qIds[4][1])) throw new Error("question texts wrong");
if (/Search|agree/.test(qText)) throw new Error("search box / consent checkbox must be ignored");
if (!/^- \S+: 42$/m.test(qText) || !/^- \S+: Paris$/m.test(qText) || /Choose/.test(qText)) throw new Error("options wrong");
const filledState = await article.evaluate(() => ({
  q1: document.querySelector("input[name=q1]:checked")?.value,
  p2: document.querySelector("input[name=p2]").checked,
  p3: document.querySelector("input[name=p3]").checked,
  p4: document.querySelector("input[name=p4]").checked,
  agree: document.querySelector("input[name=agree]").checked,
  q3: document.querySelector("select[name=q3]").value,
  q4: document.querySelector("input[name=q4]").value,
  q5: document.querySelector("textarea[name=q5]").value,
  badges: [...document.querySelectorAll(".cfa-answer")].map((b) => b.textContent),
  picked: document.querySelectorAll(".cfa-picked").length,
  submitted: window.__submitted || 0,
  changes: window.__changes,
  url: location.pathname,
}));
console.log("page state after agent:", filledState);
if (filledState.q1 !== "b" || !filledState.p2 || !filledState.p3 || filledState.p4 || filledState.agree) throw new Error("choices not filled correctly");
if (filledState.q3 !== "paris" || filledState.q4 !== "2" || !/Rayleigh/.test(filledState.q5)) throw new Error("select / text fields not filled");
if (filledState.badges.length !== 5 || !filledState.badges.some((b) => b.includes("42")) || filledState.picked < 4) throw new Error("answer badges missing");
if (filledState.submitted !== 0 || filledState.url !== "/quiz.html") throw new Error("the agent must not submit the form");
if (!["q1", "p2", "p4", "q3", "q4", "q5"].every((n) => filledState.changes.includes(n))) throw new Error("change events should fire for frameworks: " + filledState.changes);
if (!/5 answers filled in on the page/.test(await popup.textContent("#job-msg"))) throw new Error("fill summary wrong");
const quizAnswer = await popup.locator(".msg.model .bubble").last().textContent();
if (!/1\..*6 × 7/.test(quizAnswer) || !/→ 42/.test(quizAnswer) || !/→ Paris/.test(quizAnswer) || !/Rayleigh/.test(quizAnswer)) throw new Error("quiz answers not listed in the thread");
const quizMeta = await popup.locator(".msg.model .meta").last().textContent();
if (!/Agent · 5 questions on the page/.test(quizMeta) || /parts\)/.test(quizMeta)) throw new Error("quiz meta wrong: " + quizMeta);
const quizNotes = await sw.evaluate(() => globalThis.__notes);
if (quizNotes.length !== 1 || !/5 answers filled in/.test(quizNotes[0].message) || !/Review it, then submit/.test(quizNotes[0].message)) throw new Error("quiz notification wrong: " + JSON.stringify(quizNotes));
await article.screenshot({ path: "release/screenshot-quiz-filled.png" });

// Worksheet without fields: answers appear beside each question.
lessonCalls.length = 0;
await popup.click("#job-dismiss");
await popup.click("#new-chat");
await article.goto(`${mockUrl}/worksheet.html`, { waitUntil: "domcontentloaded" });
await popup.waitForFunction(() => /Worksheet/.test(document.getElementById("page-title").textContent));
await popup.click("#lesson-btn");
await popup.waitForSelector("#job.done", { timeout: 30000 });
console.log("worksheet job:", await popup.textContent("#job-msg"));
const wsIds = [...lessonCalls[0].text.matchAll(/^Q (\S+) \[(\w+)\]: (.*)$/gm)].map((m) => `${m[2]}|${m[3]}`);
console.log("worksheet questions:", wsIds);
if (wsIds.length !== 3 || !wsIds.every((q) => q.startsWith("open|")) || !/1\/2 \+ 1\/4/.test(wsIds[0])) throw new Error("worksheet questions wrong");
const wsBadges = await article.evaluate(() => [...document.querySelectorAll("li .cfa-answer")].map((b) => b.textContent));
console.log("worksheet badges:", wsBadges);
if (wsBadges.length !== 3 || !wsBadges.every((b) => /Answer for q\d/.test(b))) throw new Error("worksheet answers should be shown inline");
if (!/3 shown next to the question/.test(await popup.textContent("#job-msg"))) throw new Error("worksheet summary wrong");
await popup.click("#job-dismiss");
await popup.click("#new-chat");

// 2g) Multi-step course with auto-submit: fill -> Next (navigation) -> drag-and-drop matching -> Check -> Next (SPA swap)
// -> text answer -> Submit (navigation to results) -> stop. Same tab throughout; Back / Reset / Review / Try again untouched.
lessonCalls.length = 0;
await sw.evaluate(() => (globalThis.__notes = []));
await popup.check("#autoSubmit");
if ((await sw.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.autoSubmit)) !== true) throw new Error("auto-submit toggle should persist in settings");
const tabsBefore = ctx.pages().length;
await article.goto(`${mockUrl}/course/1.html`, { waitUntil: "domcontentloaded" });
await article.evaluate(() => localStorage.removeItem("__log"));
await popup.waitForFunction(() => /Geography course/.test(document.getElementById("page-title").textContent));
await popup.click("#lesson-btn");
await popup.waitForFunction(() => /Clicked|waiting for the next page/.test(document.getElementById("job-msg").textContent), null, { timeout: 30000, polling: 50 });
console.log("course progress:", await popup.textContent("#job-msg"));
await popup.waitForSelector("#job.done", { timeout: 60000 });
console.log("course job:", await popup.textContent("#job-count"), "-", await popup.textContent("#job-msg"));
const courseLog = await article.evaluate(() => localStorage.getItem("__log"));
console.log("course click log:", courseLog, "- final url:", article.url());
if (ctx.pages().length !== tabsBefore) throw new Error("the agent must stay on the same tab");
if (!article.url().endsWith("/course/done.html?q3=2")) throw new Error("course should end on the results page with the typed answer submitted");
const courseSteps = courseLog.split(";").filter(Boolean).filter((s) => !s.startsWith("dragstart"));
if (courseSteps.join() !== "next1:b,drop:i-paris>i-paris,drop:i-rome>i-rome,check:2,next2,submit:2") throw new Error("course click sequence wrong: " + courseSteps.join());
if (lessonCalls.length !== 3 || lessonCalls.some((c) => c.mode !== "fill")) throw new Error(`course should take 3 fill requests, got ${lessonCalls.length}`);
console.log("match request:\n" + lessonCalls[1].text);
if (!/^Q \S+ \[match\]: 2\. Drag each capital/m.test(lessonCalls[1].text) || !/^- \S+: Berlin$/m.test(lessonCalls[1].text) || !/^> \S+: France$/m.test(lessonCalls[1].text) || !/^> \S+: Italy$/m.test(lessonCalls[1].text)) throw new Error("match question should list draggable items and drop targets");
if (!/page 2 of the lesson/.test(lessonCalls[1].question) || !/^Q \S+ \[text\]: 3\. Solve x \+ 1 = 3/m.test(lessonCalls[2].text)) throw new Error("later pages should be scanned after the click");
if (!/3 answers filled in on the page \(3 pages\)/.test(await popup.textContent("#job-msg")) || !/submitted via “Submit”/.test(await popup.textContent("#job-msg"))) throw new Error("course summary wrong: " + (await popup.textContent("#job-msg")));
const courseAnswer = await popup.locator(".msg.model .bubble").last().textContent();
if (!/→ 42/.test(courseAnswer) || !/Paris → France; Rome → Italy/.test(courseAnswer) || !/→ 2/.test(courseAnswer)) throw new Error("course answers not listed in the thread: " + courseAnswer);
if (!/Agent · 3 questions on the page \(3 pages\)/.test(await popup.locator(".msg.model .meta").last().textContent())) throw new Error("course meta wrong");
const courseNotes = await sw.evaluate(() => globalThis.__notes);
if (courseNotes.length !== 1 || !/Check the results/.test(courseNotes[0].message)) throw new Error("course notification wrong: " + JSON.stringify(courseNotes));

// Drag-and-drop on its own page (no Next / Submit anywhere): the items land in their boxes and the job ends on that page.
lessonCalls.length = 0;
await popup.click("#job-dismiss");
await popup.click("#new-chat");
await article.goto(`${mockUrl}/course/2.html`, { waitUntil: "domcontentloaded" });
await article.evaluate(() => { localStorage.removeItem("__log"); document.getElementById("check").remove(); });
await popup.waitForFunction(() => /Geography course/.test(document.getElementById("page-title").textContent));
await popup.click("#lesson-btn");
await popup.waitForSelector("#job.done", { timeout: 30000 });
const dndState = await article.evaluate(() => ({
  france: document.querySelector("[data-accept=i-paris]").textContent,
  italy: document.querySelector("[data-accept=i-rome]").textContent,
  loose: [...document.querySelectorAll(".items [draggable]")].map((d) => d.textContent),
  picked: document.querySelectorAll(".cfa-picked").length,
  log: localStorage.getItem("__log"),
  url: location.pathname,
}));
console.log("drag-drop state:", dndState, "-", await popup.textContent("#job-msg"));
if (dndState.france !== "Paris" || dndState.italy !== "Rome" || dndState.loose.join() !== "Berlin" || dndState.picked !== 2) throw new Error("drag-and-drop answers not placed");
if (dndState.url !== "/course/2.html" || lessonCalls.length !== 1) throw new Error("without a Next / Submit button the agent should stop on the page");
await article.screenshot({ path: "release/screenshot-dragdrop.png" });
await popup.click("#job-dismiss");
await popup.click("#new-chat");
await article.goto("https://en.wikipedia.org/wiki/Markdown?e2e=nav2", { waitUntil: "domcontentloaded" });
await popup.waitForSelector("#empty:not([hidden])", { timeout: 10000 });

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
mock.close();
process.exit(0);
