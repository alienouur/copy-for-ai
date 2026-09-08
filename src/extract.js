import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const NOISE_TAGS = ["script", "style", "noscript", "iframe", "svg", "canvas", "form", "button", "input", "select", "textarea", "nav", "footer", "aside"];
const NOISE_SELECTOR = "[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.ad,.ads,.advert,.cookie,.cookie-banner,.newsletter,.share,.social,.comments,#comments,.mw-editsection";

function makeTurndown(opts) {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
  });
  td.use(gfm);
  td.remove(NOISE_TAGS);
  td.addRule("fencedCodeWithLang", {
    filter: (node) => node.nodeName === "PRE" && node.firstChild && node.firstChild.nodeName === "CODE",
    replacement: (_content, node) => {
      const code = node.firstChild;
      const lang = (code.className.match(/(?:language|lang)-([\w+#-]+)/) || [])[1] || "";
      return `\n\n\`\`\`${lang}\n${code.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
    },
  });
  td.addRule("dropFootnoteRefs", {
    filter: (node) => node.nodeName === "SUP" && node.querySelector("a[href*='#']") && /^\s*\[?\d+\]?\s*$|^\s*\[[^\]]{1,20}\]\s*$/.test(node.textContent),
    replacement: () => "",
  });
  if (!opts.includeImages) {
    td.addRule("dropImages", { filter: "img", replacement: () => "" });
    td.addRule("dropEmptyLinks", {
      filter: (node) => node.nodeName === "A" && !node.textContent.trim(),
      replacement: () => "",
    });
  }
  if (!opts.includeLinks) {
    td.addRule("dropLinks", { filter: (node) => node.nodeName === "A", replacement: (content) => content });
  }
  return td;
}

function selectionContainer() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const container = document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) container.appendChild(sel.getRangeAt(i).cloneContents());
  return container.textContent.trim() ? container : null;
}

function toElement(html) {
  if (typeof html !== "string") return html;
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

function absolutizeUrls(root) {
  for (const a of root.querySelectorAll("a[href]")) {
    try { a.setAttribute("href", new URL(a.getAttribute("href"), location.href).href); } catch { /* ignore */ }
  }
  for (const img of root.querySelectorAll("img[src]")) {
    try { img.setAttribute("src", new URL(img.getAttribute("src"), location.href).href); } catch { /* ignore */ }
  }
}

function readableArticle() {
  try {
    const clone = document.cloneNode(true);
    for (const el of clone.querySelectorAll(NOISE_SELECTOR)) el.remove();
    const article = new Readability(clone, { keepClasses: false }).parse();
    if (article && article.content && article.textContent.trim().length >= 200) return article;
  } catch { /* fall back to body */ }
  return null;
}

function fullBody() {
  const body = document.body.cloneNode(true);
  for (const el of body.querySelectorAll(NOISE_SELECTOR)) el.remove();
  return body;
}

export function extract(opts = {}) {
  const td = makeTurndown(opts);
  let title = document.title || location.hostname;
  let byline = "";
  let excerpt = "";
  let root;
  let usedSelection = false;

  const sel = opts.mode === "page" ? null : selectionContainer();
  if (sel) {
    root = sel;
    usedSelection = true;
  } else if (opts.mode === "selection") {
    return { error: "no-selection" };
  } else {
    const article = readableArticle();
    if (article) {
      root = toElement(article.content);
      title = article.title || title;
      byline = article.byline || "";
      excerpt = article.excerpt || "";
    } else {
      root = fullBody();
    }
  }

  absolutizeUrls(root);
  const markdown = td.turndown(root).replace(/\n{3,}/g, "\n\n").trim();
  return {
    title: title.trim(),
    url: location.href,
    byline: byline.trim(),
    excerpt: excerpt.trim(),
    markdown,
    usedSelection,
  };
}

globalThis.__copyForAI = { extract };
