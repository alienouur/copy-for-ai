import { BUILTIN_TEMPLATES, getSettings, saveSettings } from "./lib/settings.js";
import { activate, deactivate, getLicense, isPro } from "./lib/license.js";
import { clearHistory, getHistory, removeHistory } from "./lib/history.js";
import { formatCount } from "./lib/format.js";
import { PRO_CHECKOUT_URL } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
let settings;
let pro;
let editingId = null;

async function init() {
  settings = await getSettings();
  pro = await isPro();

  for (const a of document.querySelectorAll("nav a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      showTab(a.dataset.tab);
    });
  }
  const requested = (await chrome.storage.session?.get("openTab"))?.openTab;
  if (requested) chrome.storage.session.remove("openTab");
  showTab(requested || location.hash.slice(1) || "general");

  for (const key of ["includeHeader", "includeLinks", "includeImages", "wrapInFence"]) {
    const box = $(key);
    box.checked = settings[key];
    box.addEventListener("change", async () => {
      settings = await saveSettings({ [key]: box.checked });
    });
  }

  chrome.commands.getAll((cmds) => {
    const c = cmds.find((x) => x.name === "copy-page");
    $("shortcut").textContent = c?.shortcut || "not set";
  });
  $("shortcuts-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  for (const id of ["license-buy", "history-upgrade"]) $(id).href = PRO_CHECKOUT_URL;

  renderPlan();
  renderTemplates();
  renderLicense();
  renderHistory();

  $("tpl-save").addEventListener("click", saveTemplate);
  $("tpl-cancel").addEventListener("click", resetEditor);
  $("license-activate").addEventListener("click", onActivate);
  $("license-deactivate").addEventListener("click", onDeactivate);
  $("history-clear").addEventListener("click", async () => {
    await clearHistory();
    renderHistory();
  });
}

function showTab(name) {
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("active", a.dataset.tab === name);
  for (const s of document.querySelectorAll(".tab")) s.classList.toggle("active", s.id === `tab-${name}`);
  history.replaceState(null, "", `#${name}`);
}

function renderPlan() {
  $("plan").textContent = pro ? "Plan: Pro" : "Plan: Free";
}

// --- Templates

function renderTemplates() {
  const list = $("template-list");
  list.innerHTML = "";
  for (const t of BUILTIN_TEMPLATES) list.appendChild(templateItem(t));
  for (const t of settings.customTemplates) list.appendChild(templateItem(t));
}

function templateItem(t) {
  const el = document.createElement("div");
  el.className = "item";
  const grow = document.createElement("div");
  grow.className = "grow";
  grow.innerHTML = `<div class="title"></div><div class="sub"></div>`;
  grow.querySelector(".title").textContent = t.name + (t.builtin ? "" : " (custom)");
  grow.querySelector(".sub").textContent = t.body.replace(/\s+/g, " ").slice(0, 120);
  el.appendChild(grow);
  if (!t.builtin) {
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editingId = t.id;
      $("tpl-name").value = t.name;
      $("tpl-body").value = t.body;
      $("tpl-cancel").hidden = false;
      $("tpl-body").focus();
    });
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.addEventListener("click", async () => {
      settings = await saveSettings({
        customTemplates: settings.customTemplates.filter((x) => x.id !== t.id),
        templateId: settings.templateId === t.id ? "plain" : settings.templateId,
      });
      renderTemplates();
    });
    el.append(edit, del);
  }
  return el;
}

function resetEditor() {
  editingId = null;
  $("tpl-name").value = "";
  $("tpl-body").value = "";
  $("tpl-cancel").hidden = true;
  setMsg("tpl-msg", "", "");
}

async function saveTemplate() {
  if (!pro) {
    setMsg("tpl-msg", `Custom templates are a Pro feature. <a href="${PRO_CHECKOUT_URL}" target="_blank">Upgrade</a>`, "err");
    return;
  }
  const name = $("tpl-name").value.trim();
  const body = $("tpl-body").value.trim();
  if (!name || !body) return setMsg("tpl-msg", "Name and body are required", "err");
  if (!body.includes("{{content}}")) return setMsg("tpl-msg", "Template must contain {{content}}", "err");

  const templates = [...settings.customTemplates];
  if (editingId) {
    const i = templates.findIndex((t) => t.id === editingId);
    if (i >= 0) templates[i] = { ...templates[i], name, body };
  } else {
    templates.push({ id: `custom-${Date.now()}`, name, body });
  }
  settings = await saveSettings({ customTemplates: templates });
  renderTemplates();
  resetEditor();
  setMsg("tpl-msg", "Saved", "ok");
}

// --- License

async function renderLicense() {
  const license = await getLicense();
  const active = !!license && license.status === "active";
  $("license-free").hidden = active;
  $("license-active").hidden = !active;
  if (active) {
    const parts = [`Key: …${license.key.slice(-8)}`];
    if (license.email) parts.push(license.email);
    if (license.expiresAt) parts.push(`Renews/expires: ${license.expiresAt.slice(0, 10)}`);
    $("license-info").textContent = parts.join(" · ");
  }
}

async function onActivate() {
  const key = $("license-key").value.trim();
  if (!key) return setMsg("license-msg", "Paste your license key first", "err");
  $("license-activate").disabled = true;
  setMsg("license-msg", "Checking…", "");
  const result = await activate(key).catch((e) => ({ ok: false, error: e.message }));
  $("license-activate").disabled = false;
  if (!result.ok) return setMsg("license-msg", result.error, "err");
  pro = true;
  setMsg("license-msg", "Pro activated!", "ok");
  renderPlan();
  renderLicense();
  renderHistory();
}

async function onDeactivate() {
  await deactivate();
  pro = false;
  renderPlan();
  renderLicense();
  renderHistory();
}

// --- History

async function renderHistory() {
  $("history-locked").hidden = pro;
  $("history-actions").hidden = !pro;
  const list = $("history-list");
  list.innerHTML = "";
  if (!pro) return;
  const items = await getHistory();
  if (items.length === 0) {
    list.innerHTML = `<p class="muted">Nothing copied yet.</p>`;
    return;
  }
  for (const h of items) {
    const el = document.createElement("div");
    el.className = "item";
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.innerHTML = `<div class="title"></div><div class="sub"></div>`;
    grow.querySelector(".title").textContent = h.title;
    grow.querySelector(".sub").textContent = `${new Date(h.at).toLocaleString()} · ~${formatCount(h.tokens)} tokens · ${h.url}`;
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(h.text);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.addEventListener("click", async () => {
      await removeHistory(h.id);
      renderHistory();
    });
    el.append(grow, copy, del);
    list.appendChild(el);
  }
}

function setMsg(id, html, kind) {
  const el = $(id);
  el.className = `msg ${kind}`;
  el.innerHTML = html;
}

init();
