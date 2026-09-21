// Injected into the lesson tab by the agent. scan() finds every question on the page together with the form control
// that answers it (including drag-and-drop matching: draggable items + drop targets) and tags them with data-cfa-*
// ids; apply() then selects / types / drags the model's answers into those controls and shows each answer beside its
// question. apply() never submits; advance() is the separate, opt-in step that clicks the page's Next / Submit button.
const Q_ATTR = "data-cfa-q";
const O_ATTR = "data-cfa-o";
const T_ATTR = "data-cfa-t";
const CLICKED_ATTR = "data-cfa-clicked";
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
const DRAG_SEL = "[draggable=true], [aria-grabbed], .draggable, .drag-item, .dragitem, [data-draggable], [data-drag]";
const DROP_SEL = "[dropzone], [aria-dropeffect], [ondrop], [data-drop], [data-dropzone], [data-droppable], [data-target], [data-accept], .dropzone, .drop-zone, .droppable, .drop-target, .drop-area, .droparea, .dropbox, .drop, .place, .slot, .gap, .blank, .bucket, .answer-box, .answer-slot, .target";
const NEXT_BTN = /\b(next|continue|proceed|go on|nächste|weiter|suivant|siguiente|avanti|próxim[oa]|далее|التالي|متابعة|استمر(ار)?)\b|^[›»→>]+$/i;
const SUBMIT_BTN = /\b(submit|check( (my )?answers?)?|finish|done|save|send|complete|grade|verify|confirm|ok|absenden|prüfen|überprüfen|senden|fertig|valider|envoyer|terminer|vérifier|enviar|comprobar|finalizar|إرسال|أرسل|تحقق|إنهاء|تسليم|حفظ|تأكيد|موافق)\b/i;
const NOT_BTN = /\b(cancel|previous|prev|back|skip|log ?out|sign ?out|exit|quit|delete|remove|clear|reset|search|close|menu|help|hint|show answer|review|retry|try again|إلغاء|السابق|رجوع|حذف|إعادة|بحث|إغلاق)\b/i;
const DIALOG_SEL = "dialog[open], [role=dialog], [role=alertdialog], .modal.show, .modal.in, .modal[style*='display: block']";
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
      if (!node.matches("script, style, noscript, template")) text += node.innerText || "";
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

/**
 * Own label of a drop target: aria-label / data-* / its text (minus dropped items) / the row or list item it sits in.
 * Returns {text, host}, host being the element the label was read from (excluded from the question text).
 */
function targetLabel(t, drags) {
  for (const attr of ["aria-label", "data-label", "data-title", "data-name", "title", "placeholder", "data-placeholder"]) {
    const v = clean(t.getAttribute(attr));
    if (v) return { text: v, host: t };
  }
  const own = textExcluding(t, drags);
  if (own) return { text: own.slice(0, MAX_OPTION_CHARS), host: t };
  const row = t.closest("tr, li, dt, dd, .row, [class*=row], [class*=pair], [class*=item], p");
  if (row && row.querySelectorAll(DROP_SEL).length === 1) {
    const txt = textExcluding(row, [t, ...drags]);
    if (txt) return { text: txt.slice(0, MAX_OPTION_CHARS), host: row };
  }
  const prev = t.previousElementSibling || t.parentElement?.previousElementSibling;
  if (prev && !prev.matches(DROP_SEL) && !prev.matches(DRAG_SEL)) {
    const txt = textExcluding(prev, drags);
    if (txt && txt.length <= MAX_OPTION_CHARS) return { text: txt, host: prev };
  }
  return { text: "", host: t };
}

/** Drag-and-drop matching: draggable items plus the boxes they belong in, grouped by the block that holds both. */
function scanDragDrop(addQuestion) {
  const drags = [...document.querySelectorAll(DRAG_SEL)].filter(
    (d) => isVisible(d) && !inSkippedRegion(d) && !d.matches("a[href], img") && !d.closest(`[${Q_ATTR}]`) && clean(d.innerText || d.getAttribute("aria-label") || d.alt || d.title).length > 0,
  );
  if (!drags.length) return;
  const dragSet = new Set(drags);
  const holds = (el) => drags.filter((d) => el !== d && el.contains(d)).length;
  let targets = [...document.querySelectorAll(DROP_SEL)].filter(
    (t) => isVisible(t) && !inSkippedRegion(t) && !dragSet.has(t) && !t.matches(`${CONTROL_SEL}, button, a, [data-toggle], [data-bs-toggle]`) && holds(t) < 2 && t.getBoundingClientRect().width >= 20,
  );
  targets = targets.filter((t) => !targets.some((o) => o !== t && t.contains(o)));
  if (!targets.length) return;
  // Group each box with the block that also holds the items still waiting to be placed; once everything is placed,
  // with the block holding an item that sits in another box. (Items already in the box itself never count, or an
  // answered box would form a group of its own and the page would look like a different question after a Check.)
  const loose = drags.filter((d) => !targets.some((t) => t.contains(d)));
  const groups = new Map();
  for (const t of targets) {
    const pool = loose.length ? loose : drags.filter((d) => !t.contains(d));
    let anc = t.parentElement;
    while (anc && anc !== document.body && !pool.some((d) => anc.contains(d))) anc = anc.parentElement;
    anc ||= document.body;
    if (!groups.has(anc)) groups.set(anc, []);
    groups.get(anc).push(t);
  }
  for (const [anc, ts] of groups) {
    const items = drags.filter((d) => anc.contains(d));
    if (!items.length) continue;
    const labels = ts.map((t) => targetLabel(t, items));
    const q = addQuestion("match", [...items, ...ts], items, (d) => d.innerText || d.getAttribute("aria-label") || d.alt || d.title, anc, labels.map((l) => l.host));
    q.targets = ts.map((t, k) => {
      t.setAttribute(T_ATTR, `${q.id}-t${k}`);
      return { id: `${q.id}-t${k}`, text: labels[k].text || `box ${k + 1}` };
    });
  }
}

/** Scans the page. Returns {title, questions: [{id, type, text, options?: [{id, text}], targets?: [{id, text}]}]}. */
export function scan() {
  clear();
  for (const el of document.querySelectorAll(`[${Q_ATTR}], [${O_ATTR}], [${T_ATTR}]`)) {
    el.removeAttribute(Q_ATTR);
    el.removeAttribute(O_ATTR);
    el.removeAttribute(T_ATTR);
  }
  let seq = 0;
  const questions = [];
  const controls = [...document.querySelectorAll(CONTROL_SEL)].filter((c) => isVisible(c) && !c.disabled && !inSkippedRegion(c));
  const allControls = new Set(controls);
  const used = new Set();

  const addQuestion = (type, controlEls, optionEls, optionOf, block, extraExcluded = []) => {
    const options = optionEls.map((el) => ({ el, text: clean(optionOf(el)).slice(0, MAX_OPTION_CHARS) }));
    const container = block || commonAncestor(controlEls);
    const excluded = [...new Set([...controlEls, ...optionEls].flatMap(labelHosts).concat(extraExcluded))];
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

  scanDragDrop(addQuestion);

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

const KEY_DELAY_MS = 12;

function keyInfo(ch) {
  if (ch === "\b") return { key: "Backspace", code: "Backspace", keyCode: 8 };
  if (ch === "\n") return { key: "Enter", code: "Enter", keyCode: 13 };
  if (ch === " ") return { key: " ", code: "Space", keyCode: 32 };
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/^\d$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
  return { key: ch, code: "", keyCode: 0 };
}

function keyEvent(el, type, ch) {
  const { key, code, keyCode } = keyInfo(ch);
  return el.dispatchEvent(
    new KeyboardEvent(type, { key, code, keyCode, which: keyCode, charCode: type === "keypress" ? ch.charCodeAt(0) : 0, bubbles: true, cancelable: true, composed: true }),
  );
}

function inputEvent(el, type, data, inputType) {
  return el.dispatchEvent(new InputEvent(type, { data, inputType, bubbles: true, cancelable: type === "beforeinput", composed: true }));
}

const isEditable = (el) => !el.matches("input, textarea") && el.isContentEditable;

function selectAll(el, collapseToEnd = false) {
  if (el.matches("input, textarea")) {
    try {
      el.setSelectionRange(0, el.value.length);
    } catch {
      /* number/email inputs have no selection API */
    }
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (collapseToEnd) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Clears the field the way a user would: select everything, press Backspace. */
function clearField(el) {
  const empty = el.matches("input, textarea") ? !el.value : !clean(el.textContent);
  if (empty) return;
  selectAll(el);
  keyEvent(el, "keydown", "\b");
  if (el.matches("input, textarea")) {
    if (inputEvent(el, "beforeinput", null, "deleteContentBackward")) {
      setNativeValue(el, "");
      inputEvent(el, "input", null, "deleteContentBackward");
    }
  } else if (!document.execCommand("delete") && inputEvent(el, "beforeinput", null, "deleteContentBackward")) {
    // execCommand fires beforeinput/input itself; only the manual fallback needs synthetic ones.
    el.textContent = "";
    inputEvent(el, "input", null, "deleteContentBackward");
  }
  keyEvent(el, "keyup", "\b");
}

/**
 * Types `text` one character at a time with real keydown / keypress / beforeinput / input / keyup events,
 * so fields that block paste (or validate keystrokes) accept the answer like manual typing.
 */
async function typeInto(el, text) {
  if (el.matches("input") && el.type === "number") text = text.replace(",", ".").match(/-?\d+(\.\d+)?/)?.[0] ?? text;
  const native = el.matches("input, textarea");
  if (!native && !isEditable(el)) {
    el.textContent = text;
    fire(el, ["input"]);
    return;
  }
  el.focus?.();
  clearField(el);
  if (!native) selectAll(el, true);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const newline = ch === "\n";
    const inputType = newline ? (native ? "insertLineBreak" : "insertParagraph") : "insertText";
    if (keyEvent(el, "keydown", ch) && keyEvent(el, "keypress", ch)) {
      if (native) {
        if (inputEvent(el, "beforeinput", newline ? null : ch, inputType)) {
          const next = text.slice(0, i + 1);
          setNativeValue(el, next);
          if (el.type === "number" && el.value !== next) el.value = next;
          inputEvent(el, "input", newline ? null : ch, inputType);
        }
      } else if (!document.execCommand(newline ? "insertParagraph" : "insertText", false, ch)) {
        // execCommand fires beforeinput/input itself; only synthesise them on the manual fallback
        if (inputEvent(el, "beforeinput", newline ? null : ch, inputType)) {
          el.append(newline ? document.createElement("br") : ch);
          selectAll(el, true);
          inputEvent(el, "input", newline ? null : ch, inputType);
        }
      }
    }
    keyEvent(el, "keyup", ch);
    if (i % 3 === 2) await sleep(KEY_DELAY_MS);
  }
  const got = native ? el.value : clean(el.innerText);
  if (native ? got !== text : !got.includes(clean(text))) {
    if (native) setNativeValue(el, text);
    else el.textContent = text;
    fire(el, ["input"]);
  }
  fire(el, ["change"]);
  el.blur?.();
}

const byAttr = (attr, id) => document.querySelector(`[${attr}="${id}"]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const centre = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** True once the item (or a copy of its text) sits inside the target. */
function landed(src, tgt, text, before) {
  if (tgt.contains(src)) return true;
  const now = clean(tgt.innerText);
  return !!text && now !== before && now.includes(text);
}

function dragEvent(type, el, at, dt) {
  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, dataTransfer: dt }));
}

function pointerEvent(type, el, at) {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y, button: 0, buttons: /up|end/.test(type) ? 0 : 1, view: window };
  el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
}

/**
 * Moves a draggable into a drop target the way a user would, trying in turn: HTML5 drag events sharing one
 * DataTransfer (native / React DnD handlers), a pointer + mouse drag (SortableJS, jQuery UI, dnd-kit style
 * libraries), and click-to-pick then click-to-place. Resolves true when the target visibly accepted the item.
 */
async function dragTo(src, tgt) {
  const text = clean(src.innerText || src.getAttribute("aria-label") || src.alt || src.title);
  const before = clean(tgt.innerText);
  src.scrollIntoView?.({ block: "center" });
  const from = centre(src);
  const to = centre(tgt);
  const dt = new DataTransfer();
  dragEvent("dragstart", src, from, dt);
  if (!dt.types.length) dt.setData("text/plain", src.id || text);
  dragEvent("drag", src, from, dt);
  dragEvent("dragenter", tgt, to, dt);
  dragEvent("dragover", tgt, to, dt);
  dragEvent("drop", tgt, to, dt);
  dragEvent("dragend", src, to, dt);
  await sleep(80);
  if (landed(src, tgt, text, before)) return true;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  pointerEvent("pointerdown", src, from);
  pointerEvent("mousedown", src, from);
  await sleep(30);
  for (const at of [{ x: from.x + 6, y: from.y + 6 }, mid, to]) {
    const over = document.elementFromPoint(at.x, at.y) || tgt;
    pointerEvent("pointermove", over, at);
    pointerEvent("mousemove", over, at);
    await sleep(30);
  }
  const over = document.elementFromPoint(to.x, to.y) || tgt;
  pointerEvent("pointerup", over, to);
  pointerEvent("mouseup", over, to);
  await sleep(120);
  if (landed(src, tgt, text, before)) return true;
  src.click();
  await sleep(60);
  tgt.click();
  await sleep(120);
  return landed(src, tgt, text, before);
}

/**
 * Applies answers [{id, option_ids, text, pairs?: [{option_id, target_id}]}] to the questions tagged by scan().
 * Returns {filled, shown, missing}: controls changed, answers only displayed beside the question, ids not found.
 */
export async function apply(answers, questions) {
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
        await typeInto(el, text);
        done = true;
      }
    } else if (q.type === "match") {
      let dropped = 0;
      const pairs = (a.pairs || []).filter((p) => q.options?.some((o) => o.id === p.option_id) && q.targets?.some((t) => t.id === p.target_id));
      for (const p of pairs) {
        const src = byAttr(O_ATTR, p.option_id);
        const tgt = byAttr(T_ATTR, p.target_id);
        if (!src || !tgt) continue;
        const ok = await dragTo(src, tgt);
        if (ok) {
          dropped++;
          tgt.classList.add(PICKED_CLASS);
        } else badge(tgt, q.options.find((o) => o.id === p.option_id)?.text || "?", true);
      }
      done = dropped > 0 && dropped === pairs.length;
      if (dropped) result.filled++;
      else if (pairs.length || text) result.shown++;
      if (!done && pairs.length) badge(qEl, text || pairs.map((p) => `${q.options.find((o) => o.id === p.option_id)?.text} → ${q.targets.find((t) => t.id === p.target_id)?.text}`).join("; "), true);
      firstEl ??= qEl;
      continue;
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

function buttonText(el) {
  return clean(el.matches("input") ? el.value || el.getAttribute("aria-label") || el.title : el.innerText || el.getAttribute("aria-label") || el.title || el.value);
}

/**
 * Clicks the page's Next / Continue button, or - when there is none - its Submit / Check / Finish button, so the agent
 * can move on to the next question or page. Buttons inside an open dialog win (confirmations); a button this agent
 * already clicked on this page is only clicked again when nothing else qualifies (Check → Next flows). Buttons that go
 * backwards, cancel, reset or delete are never clicked. Returns the button's text, or null when nothing was clicked.
 */
export function advance() {
  const dialog = [...document.querySelectorAll(DIALOG_SEL)].filter(isVisible).at(-1);
  const root = dialog || document;
  const candidates = [...root.querySelectorAll("button, input[type=submit], input[type=button], input[type=image], [role=button], a.btn, a.button, a[class*=next], a[class*=submit]")].filter((el) => {
    if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true" || el.closest(`[aria-hidden=true], .${BADGE_CLASS}`)) return false;
    if (!dialog && el.closest("nav, header, [role=navigation], [role=banner], [role=search]")) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 12 && r.height >= 12;
  });
  const labelled = candidates.map((el) => ({ el, text: buttonText(el).slice(0, 80) })).filter((c) => c.text.length && c.text.length <= 60 && !NOT_BTN.test(c.text));
  const best = (list) => list.filter((c) => NEXT_BTN.test(c.text)).at(-1) || list.filter((c) => SUBMIT_BTN.test(c.text)).at(-1);
  const pick = best(labelled.filter((c) => !c.el.hasAttribute(CLICKED_ATTR))) || best(labelled);
  if (!pick) return null;
  pick.el.setAttribute(CLICKED_ATTR, "1");
  pick.el.scrollIntoView?.({ block: "center" });
  pick.el.click();
  return pick.text;
}

globalThis.__copyForAIFill = { scan, apply, clear, advance };
