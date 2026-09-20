// Injected into the lesson tab by the agent. scan() finds every question on the page together with the form control
// that answers it and tags them with data-cfa-* ids; apply() then selects / types the model's answers into those
// controls and shows each answer beside its question. Nothing is ever submitted.
const Q_ATTR = "data-cfa-q";
const O_ATTR = "data-cfa-o";
const BADGE_CLASS = "cfa-answer";
const PICKED_CLASS = "cfa-picked";
const STYLE_ID = "cfa-answer-style";
const MAX_QUESTION_CHARS = 1500;
const MAX_OPTION_CHARS = 300;
const MAX_OPEN_QUESTIONS = 150;
const MIN_QUESTION_CHARS = 12;
const SKIP_FIELD = /search|e-?mail|password|passwd|login|username|user_?name|first.?name|last.?name|full.?name|phone|tel\b|zip|postal|captcha|coupon|promo|subscribe|newsletter|remember|agree|terms|website/i;
const TEXT_TYPES = new Set(["", "text", "number", "search", "tel", "url", "email"]);
const OPEN_QUESTION = /^\s*((\d{1,3}|[a-zA-Z]|[ivxIVX]{1,5})\s*[.)\]:\-–]\s+\S|(Question|Exercise|Exercice|Problem|Task|Q)\s*\d)/;
const CONTROL_SEL = "input, select, textarea, [role=radio], [role=checkbox], [contenteditable=true]";
const GROUP_SEL = "[role=radiogroup], [role=group], fieldset, ul, ol, table";
const INLINE_TAGS = new Set(["SPAN", "B", "STRONG", "EM", "I", "U", "A", "CODE", "SUB", "SUP", "SMALL", "MARK", "BR", "IMG", "LABEL", "FONT", "MATH"]);

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

function isVisible(el) {
  if (!el.isConnected || el.type === "hidden") return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
}

function inSkippedRegion(el) {
  return !!el.closest(`nav, header, footer, [role=search], [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true], .${BADGE_CLASS}`);
}

function fieldLooksIrrelevant(el) {
  const hints = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""} ${el.autocomplete || ""}`;
  return SKIP_FIELD.test(hints);
}

function cssId(id) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
}

/** Text of the <label> for a control: aria-label(ledby), label[for], wrapping label, or the text right after it. */
function labelText(el) {
  const own = el.getAttribute("aria-label");
  if (own) return clean(own);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
    if (t) return t;
  }
  if (el.id) {
    for (const l of document.querySelectorAll(`label[for="${cssId(el.id)}"]`)) {
      const t = clean(l.innerText);
      if (t) return t;
    }
  }
  const wrap = el.closest("label");
  if (wrap) {
    const t = clean(wrap.innerText);
    if (t) return t;
  }
  let node = el.nextSibling;
  let text = "";
  while (node && text.length < 60) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches(CONTROL_SEL) || node.tagName === "BR") break;
      text += node.innerText || "";
    }
    node = node.nextSibling;
  }
  text = clean(text);
  if (text) return text;
  const parent = el.parentElement;
  return parent && parent.children.length <= 3 && !parent.querySelector(`${CONTROL_SEL}:not([${O_ATTR}])`) ? clean(parent.innerText) : clean(el.innerText);
}

/** Elements whose text belongs to an option, not to the question: the control plus whatever labels it. */
function labelHosts(el) {
  const hosts = [el];
  const wrap = el.closest("label");
  if (wrap) hosts.push(wrap);
  if (el.id) hosts.push(...document.querySelectorAll(`label[for="${cssId(el.id)}"]`));
  const by = el.getAttribute("aria-labelledby");
  if (by) for (const id of by.split(/\s+/)) if (document.getElementById(id)) hosts.push(document.getElementById(id));
  if (!wrap && !el.id && !by && el.matches("input[type=radio], input[type=checkbox]")) {
    // Bare "<input> text" - the following inline text is its label.
    const parent = el.parentElement;
    if (parent && !parent.querySelector(`${CONTROL_SEL}:not([${O_ATTR}])`)) hosts.push(parent);
  }
  return hosts;
}

/** Visible-ish text of root, skipping anything inside the excluded elements (and scripts / styles). */
function textExcluding(root, excluded) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest("script, style, noscript, template") || excluded.some((x) => x.contains(n))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) text += n.textContent + " ";
  return clean(text);
}

function commonAncestor(els) {
  let anc = els[0];
  for (const el of els.slice(1)) {
    while (anc && !anc.contains(el)) anc = anc.parentElement;
  }
  return anc || document.body;
}

/**
 * Finds the question text for a group of controls: walks up from their common ancestor until the text left after
 * removing the option labels is meaningful, stopping before it would swallow another question's controls.
 */
function questionFor(container, excluded, allControls, own) {
  let el = container;
  let last = container;
  let best = "";
  for (let depth = 0; el && el !== document.body && depth < 8; depth++) {
    if (depth > 0 && [...el.querySelectorAll(CONTROL_SEL)].some((c) => allControls.has(c) && !own.has(c))) break;
    const text = textExcluding(el, excluded);
    if (text.length >= MIN_QUESTION_CHARS) return { text: text.slice(0, MAX_QUESTION_CHARS), container: el };
    if (text.length > best.length) best = text;
    last = el;
    el = el.parentElement;
  }
  if (best.length >= 6) return { text: best, container: last };
  for (const start of [last, container]) {
    let prev = start.previousElementSibling;
    for (let i = 0; prev && i < 4; i++, prev = prev.previousElementSibling) {
      if (prev.querySelector(CONTROL_SEL) || prev.matches(CONTROL_SEL)) break;
      const t = clean(prev.innerText);
      if (t.length >= 8) return { text: t.slice(0, MAX_QUESTION_CHARS), container: last };
    }
  }
  return { text: best, container: last };
}

/** Text written directly in a block (its own text nodes and inline children), ignoring nested blocks. */
function directText(el) {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    else if (node.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(node.tagName)) text += node.innerText || "";
  }
  return clean(text);
}

/** Scans the page. Returns {title, questions: [{id, type, text, options?: [{id, text}]}]}. */
export function scan() {
  clear();
  for (const el of document.querySelectorAll(`[${Q_ATTR}], [${O_ATTR}]`)) {
    el.removeAttribute(Q_ATTR);
    el.removeAttribute(O_ATTR);
  }
  let seq = 0;
  const questions = [];
  const controls = [...document.querySelectorAll(CONTROL_SEL)].filter((c) => isVisible(c) && !c.disabled && !inSkippedRegion(c));
  const allControls = new Set(controls);
  const used = new Set();

  const addQuestion = (type, controlEls, optionEls, optionOf) => {
    const options = optionEls.map((el) => ({ el, text: clean(optionOf(el)).slice(0, MAX_OPTION_CHARS) }));
    const container = commonAncestor(controlEls);
    const excluded = [...new Set([...controlEls, ...optionEls].flatMap(labelHosts))];
    let { text, container: qEl } = questionFor(container, excluded, allControls, new Set(controlEls));
    if (qEl.hasAttribute(Q_ATTR)) qEl = container.hasAttribute(Q_ATTR) ? controlEls[0] : container;
    const id = `q${++seq}`;
    qEl.setAttribute(Q_ATTR, id);
    const question = { id, type, text };
    if (type !== "text") {
      question.options = options.map((o, k) => {
        o.el.setAttribute(O_ATTR, `${id}-${k}`);
        return { id: `${id}-${k}`, text: o.text || `option ${k + 1}` };
      });
    }
    controlEls.forEach((c) => used.add(c));
    questions.push(question);
    return question;
  };

  // Radios: grouped by name (mutually exclusive by definition). Checkboxes and ARIA widgets: by enclosing group.
  const groups = [];
  for (const c of controls) {
    const isRadio = c.matches("input[type=radio], [role=radio]");
    const isCheck = c.matches("input[type=checkbox], [role=checkbox]");
    if (!isRadio && !isCheck) continue;
    const type = isRadio ? "choice" : "multi";
    const form = c.form || c.closest("form");
    const key = isRadio && c.name ? `${c.name}|${form ? form.id || form.getAttribute("action") || "form" : ""}` : null;
    const container = c.closest(GROUP_SEL) || c.parentElement?.parentElement || document.body;
    let g = groups.find((x) => x.type === type && (key ? x.key === key : !x.key && x.container === container));
    if (!g) groups.push((g = { type, key, container, members: [] }));
    g.members.push(c);
  }
  for (const g of groups) {
    if (g.type === "multi" && g.members.length === 1 && (fieldLooksIrrelevant(g.members[0]) || SKIP_FIELD.test(labelText(g.members[0])))) continue;
    addQuestion(g.type, g.members, g.members, (m) => (m.matches("input") ? labelText(m) : clean(m.getAttribute("aria-label") || m.innerText) || labelText(m)));
  }

  for (const c of controls) {
    if (used.has(c) || fieldLooksIrrelevant(c) || c.readOnly) continue;
    if (c.matches("select")) {
      const opts = [...c.options].filter((o, k) => !o.disabled && clean(o.textContent) && !(k === 0 && (o.value === "" || /^(-+|\.+|choose|select|please|pick)/i.test(clean(o.textContent)))));
      if (opts.length < 2) continue;
      const q = addQuestion("select", [c], opts, (o) => o.textContent);
      c.setAttribute(O_ATTR, `${q.id}-select`);
    } else if (c.matches("input") ? TEXT_TYPES.has(c.type) : c.matches("textarea, [contenteditable=true]")) {
      const q = addQuestion("text", [c], [], () => "");
      c.setAttribute(O_ATTR, `${q.id}-0`);
      if (q.text.length < MIN_QUESTION_CHARS) q.text = clean(`${q.text} ${labelText(c)} ${c.placeholder || ""}`) || "(unlabelled answer field)";
    }
  }

  // Pages without answer fields (worksheets, exercise lists): tag question blocks so answers can be shown inline.
  if (!questions.length) {
    const blocks = document.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, td, dt, dd, div, blockquote");
    for (const el of blocks) {
      if (questions.length >= MAX_OPEN_QUESTIONS) break;
      if (el.closest(`[${Q_ATTR}]`) || inSkippedRegion(el) || !isVisible(el)) continue;
      const own = directText(el);
      const numbered = el.tagName === "LI" && el.parentElement?.tagName === "OL";
      if (own.length < 4 || (!numbered && !OPEN_QUESTION.test(own) && !/\?\s*$/.test(own))) continue;
      const full = clean(el.innerText);
      if (full.length > 3000) continue;
      const id = `q${++seq}`;
      el.setAttribute(Q_ATTR, id);
      questions.push({ id, type: "open", text: full.slice(0, MAX_QUESTION_CHARS) });
    }
  }

  const pos = new Map(questions.map((q) => [q.id, document.querySelector(`[${Q_ATTR}="${q.id}"]`)]));
  questions.sort((a, b) => {
    const ea = pos.get(a.id);
    const eb = pos.get(b.id);
    if (!ea || !eb || ea === eb) return 0;
    return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return { title: document.title, questions };
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${BADGE_CLASS}{display:inline-block;margin:6px 4px;padding:4px 10px;border-radius:8px;background:#ecfdf5;color:#065f46;border:1px solid #6ee7b7;font:13px/1.4 system-ui,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;max-width:100%;box-sizing:border-box;vertical-align:middle;text-align:left}
.${BADGE_CLASS}.cfa-block{display:block;width:fit-content;margin:6px 0}
.${BADGE_CLASS}.cfa-miss{background:#fffbeb;color:#92400e;border-color:#fcd34d}
.${BADGE_CLASS} b{font-weight:600}
.${PICKED_CLASS}{outline:2px solid #10b981;outline-offset:2px;border-radius:4px}`;
  (document.head || document.documentElement).appendChild(style);
}

function badge(el, text, miss) {
  ensureStyle();
  const b = document.createElement("span");
  b.className = `${BADGE_CLASS}${miss ? " cfa-miss" : ""}`;
  const label = document.createElement("b");
  label.textContent = miss ? "Copy for AI: " : "✓ ";
  b.append(label, document.createTextNode(text));
  if (INLINE_TAGS.has(el.tagName) || el.matches(CONTROL_SEL) || /^(TD|TH|DT|DD)$/.test(el.tagName)) {
    el.insertAdjacentElement("afterend", b);
  } else {
    b.classList.add("cfa-block");
    el.appendChild(b);
  }
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el, types) {
  for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
}

function setChecked(el, on) {
  if (el.matches("input")) {
    if (el.checked !== on) el.click();
    if (el.checked !== on) {
      el.checked = on;
      fire(el, ["input", "change"]);
    }
  } else if ((el.getAttribute("aria-checked") === "true") !== on) {
    el.click();
    if ((el.getAttribute("aria-checked") === "true") !== on) el.setAttribute("aria-checked", String(on));
  }
  const mark = el.closest("label") || el;
  if (on) mark.classList.add(PICKED_CLASS);
  else mark.classList.remove(PICKED_CLASS);
}

function typeInto(el, text) {
  el.focus?.();
  if (el.matches("input, textarea")) {
    if (el.type === "number") text = text.replace(",", ".").match(/-?\d+(\.\d+)?/)?.[0] ?? text;
    setNativeValue(el, text);
    if (el.type === "number" && el.value !== text) el.value = text;
    fire(el, ["input", "change"]);
  } else {
    el.textContent = text;
    fire(el, ["input"]);
  }
  el.blur?.();
}

const byAttr = (attr, id) => document.querySelector(`[${attr}="${id}"]`);

/**
 * Applies answers [{id, option_ids, text}] to the questions tagged by scan().
 * Returns {filled, shown, missing}: controls changed, answers only displayed beside the question, ids not found.
 */
export function apply(answers, questions) {
  const byId = new Map((questions || []).map((q) => [q.id, q]));
  const result = { filled: 0, shown: 0, missing: 0 };
  let firstEl = null;
  for (const a of answers || []) {
    const qEl = byAttr(Q_ATTR, a.id);
    const q = byId.get(a.id);
    if (!qEl || !q) {
      result.missing++;
      continue;
    }
    const text = clean(a.text);
    const wanted = new Set((a.option_ids || []).filter((id) => q.options?.some((o) => o.id === id)));
    let done = false;
    if (q.type === "select") {
      const select = byAttr(O_ATTR, `${q.id}-select`);
      const opt = [...wanted].map((id) => byAttr(O_ATTR, id)).find(Boolean);
      if (select && opt) {
        select.value = opt.value;
        fire(select, ["input", "change"]);
        select.classList.add(PICKED_CLASS);
        done = true;
      }
    } else if (q.type === "choice" || q.type === "multi") {
      for (const o of q.options) {
        const el = byAttr(O_ATTR, o.id);
        if (!el) continue;
        if (wanted.has(o.id)) {
          setChecked(el, true);
          done = true;
        } else if (q.type === "multi") setChecked(el, false);
      }
    } else if (q.type === "text") {
      const el = byAttr(O_ATTR, `${q.id}-0`);
      if (el && text) {
        typeInto(el, text);
        done = true;
      }
    }
    if (done) result.filled++;
    else if (text) result.shown++;
    const pickedText = wanted.size
      ? [...wanted].map((id) => q.options.find((o) => o.id === id)?.text).filter(Boolean).join(", ")
      : "";
    const label = q.type === "choice" || q.type === "multi" || q.type === "select" ? pickedText || text : text;
    if (label || done) badge(qEl, label || "answered", !done && q.type !== "open");
    firstEl ??= qEl;
  }
  firstEl?.scrollIntoView?.({ block: "center" });
  return result;
}

/** Removes the answer badges and highlights added by apply(). */
export function clear() {
  for (const b of document.querySelectorAll(`.${BADGE_CLASS}`)) b.remove();
  for (const el of document.querySelectorAll(`.${PICKED_CLASS}`)) el.classList.remove(PICKED_CLASS);
}

globalThis.__copyForAIFill = { scan, apply, clear };
