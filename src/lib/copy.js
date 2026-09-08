import { buildOutput, estimateTokens, countWords } from "./format.js";
import { extractFromTab, extractFromTabs, isSupportedUrl } from "./extractor.js";
import { findTemplate, getSettings } from "./settings.js";
import { isPro } from "./license.js";
import { addHistory } from "./history.js";

/**
 * Extracts the given tabs, renders the output, writes it to the clipboard and
 * records history for Pro users. Returns stats for the UI.
 */
export async function copyTabs({ tabs, mode = "auto", writeClipboard, onProgress }) {
  const settings = await getSettings();
  const template = findTemplate(settings, settings.templateId);
  const opts = { mode, includeLinks: settings.includeLinks, includeImages: settings.includeImages };

  let docs;
  let skipped = [];
  if (tabs.length === 1) {
    const tab = tabs[0];
    if (!isSupportedUrl(tab.url)) throw new Error("This page can't be read by extensions (browser or store page)");
    docs = [await extractFromTab(tab.id, opts)];
  } else {
    ({ docs, skipped } = await extractFromTabs(tabs, opts, onProgress));
    if (docs.length === 0) throw new Error("None of the tabs could be read");
  }

  const text = buildOutput(docs, settings, template);
  await writeClipboard(text);

  const tokens = estimateTokens(text);
  const stats = { text, tokens, words: countWords(text), tabs: docs.length, skipped, usedSelection: docs[0].usedSelection };

  if (await isPro()) {
    await addHistory({
      title: docs.length === 1 ? docs[0].title : `${docs.length} tabs: ${docs[0].title}`,
      url: docs[0].url,
      tabs: docs.length,
      tokens,
      text,
    });
  }
  return stats;
}
