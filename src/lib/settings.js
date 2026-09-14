export const BUILTIN_TEMPLATES = [
  {
    id: "plain",
    name: "Plain (no instructions)",
    body: "{{content}}",
    builtin: true,
  },
  {
    id: "summarize",
    name: "Summarize",
    body: "Summarize the following page in 5 concise bullet points, then give a one-sentence takeaway.\n\n{{content}}",
    builtin: true,
  },
  {
    id: "explain",
    name: "Explain simply",
    body: "Explain the following content in simple terms, as if to a smart beginner. Define any jargon.\n\n{{content}}",
    builtin: true,
  },
  {
    id: "keypoints",
    name: "Key points & action items",
    body: "From the content below, list the key points, any decisions, and concrete action items.\n\n{{content}}",
    builtin: true,
  },
  {
    id: "qa",
    name: "Q&A context",
    body: "Use the following content as context. Answer my questions based only on it, and say when the answer is not in the content.\n\n{{content}}\n\nMy first question: ",
    builtin: true,
  },
];

export const DEFAULT_SETTINGS = {
  includeLinks: true,
  includeImages: false,
  includeHeader: true,
  wrapInFence: false,
  templateId: "plain",
  customTemplates: [],
  proTrialsUsed: 0,
  answerOnly: true,
  sendScreenshot: true,
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

export function allTemplates(settings) {
  return [...BUILTIN_TEMPLATES, ...(settings.customTemplates || [])];
}

export function findTemplate(settings, id) {
  return allTemplates(settings).find((t) => t.id === id) || BUILTIN_TEMPLATES[0];
}
