export function estimateTokens(text) {
  // Rough GPT/Claude estimate: ~4 chars per token for English, fewer for CJK.
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4 + cjk);
}

export function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

export function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function contextWarning(tokens) {
  if (tokens > 190_000) return "Exceeds Claude/GPT-4o context (~200k tokens)";
  if (tokens > 120_000) return "Exceeds GPT-4o context (128k tokens)";
  if (tokens > 30_000) return "Large – some free tiers will truncate this";
  return "";
}

export function renderDocument(doc, settings) {
  const parts = [];
  if (settings.includeHeader) {
    parts.push(`# ${doc.title || "Untitled"}`);
    const meta = [`Source: ${doc.url}`];
    if (doc.byline) meta.push(`Author: ${doc.byline}`);
    if (doc.usedSelection) meta.push("(selected text)");
    parts.push(meta.join("\n"));
    parts.push("");
  }
  parts.push(settings.wrapInFence ? `\`\`\`markdown\n${doc.markdown}\n\`\`\`` : doc.markdown);
  return parts.join("\n");
}

export function renderBundle(docs, settings) {
  return docs.map((d) => renderDocument(d, settings)).join("\n\n---\n\n");
}

export function applyTemplate(template, content, docs) {
  const first = docs[0] || {};
  return template.body
    .replaceAll("{{content}}", content)
    .replaceAll("{{title}}", first.title || "")
    .replaceAll("{{url}}", first.url || "")
    .replaceAll("{{date}}", new Date().toISOString().slice(0, 10));
}

export function buildOutput(docs, settings, template) {
  const content = docs.length === 1 ? renderDocument(docs[0], settings) : renderBundle(docs, settings);
  return applyTemplate(template, content, docs);
}
