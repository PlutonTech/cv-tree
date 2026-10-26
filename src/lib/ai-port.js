// Talks to the background worker, which holds the API key and makes the Claude calls.
// Disconnecting the port (Stop button, closing the menu) cancels the request.

export function runAI(op, payload = {}, { onText, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connect({ name: "ai" });
    const finish = (fn, v) => { if (settled) return; settled = true; fn(v); try { port.disconnect(); } catch {} };
    port.onMessage.addListener(m => {
      if (m.type === "text") onText?.(m.text);
      else if (m.type === "done") finish(resolve, m.result);
      else if (m.type === "error") finish(reject, Object.assign(new Error(m.message), { code: m.code, text: m.text }));
    });
    port.onDisconnect.addListener(() => finish(reject, Object.assign(new Error("Stopped."), { code: "cancelled" })));
    signal?.addEventListener("abort", () => finish(reject, Object.assign(new Error("Stopped."), { code: "cancelled" })));
    port.postMessage({ op, ...payload });
  });
}
