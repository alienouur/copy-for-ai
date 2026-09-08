chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "cfa-clipboard-write") return false;
  const ta = document.getElementById("clip");
  ta.value = msg.text;
  ta.select();
  const ok = document.execCommand("copy");
  ta.value = "";
  sendResponse({ ok });
  return false;
});
