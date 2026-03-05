function withTimeout(ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "INTEGRATION_REQUEST") return;

  const method = message.method || "POST";
  const path = message.path || "/";
  const payload = message.payload || {};
  const bases = Array.isArray(message.bases) ? message.bases : [];

  (async () => {
    let lastErr = null;
    for (const base of bases) {
      const url = `${String(base).replace(/\/+$/, "")}${path}`;
      const timeout = withTimeout(5000);
      try {
        const init = {
          method,
          headers: { "Content-Type": "application/json" },
          signal: timeout.signal
        };
        if (method !== "GET") {
          init.body = JSON.stringify(payload);
        }
        const res = await fetch(url, init);
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (_) {
          data = { raw: text };
        }
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        sendResponse({ ok: true, data });
        return;
      } catch (err) {
        lastErr = err;
      } finally {
        timeout.done();
      }
    }
    sendResponse({ ok: false, error: String(lastErr?.message || "Failed to fetch") });
  })();

  return true;
});
