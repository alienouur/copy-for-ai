// Remembers where a visitor came from (utm_* / ref) and tags the store and checkout links with it,
// so installs and payments can be attributed per channel. First touch wins. Nothing personal is stored.
(function () {
  var KEY = "cfa_source";
  var params = new URLSearchParams(location.search);
  var fresh = [params.get("utm_source") || params.get("ref"), params.get("utm_campaign") || params.get("utm_medium"), params.get("utm_content")]
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  var source = "";
  try {
    source = localStorage.getItem(KEY) || "";
    if (!source && fresh) {
      localStorage.setItem(KEY, fresh);
      source = fresh;
    }
  } catch (e) {
    source = fresh;
  }
  if (!source) return;
  window.cfaSource = source;

  document.querySelectorAll('a[href*="buy.stripe.com"]').forEach(function (a) {
    var u = new URL(a.href);
    u.searchParams.set("client_reference_id", "web_" + source);
    a.href = u.toString();
  });
  document.querySelectorAll('a[href*="chromewebstore.google.com"]').forEach(function (a) {
    var u = new URL(a.href);
    u.searchParams.set("utm_source", source);
    a.href = u.toString();
  });

  // welcome.html is opened by the extension right after install with ?ext=<extension id>:
  // hand the source over so the extension can report it with its API calls and checkout link.
  var ext = params.get("ext");
  if (ext && window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage(ext, { type: "cfa-source", source: source }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* extension not reachable */
    }
  }
})();
