// Anonymous usage events for the CV Tree admin dashboard.
// Sent: what was used (event names, counts, timings, model names, job-site domains, template names).
// Never sent: CV or letter text, names, contact details, job descriptions, profile data or API keys.
// Off entirely unless cvtree.config.json has a serverUrl (set at build time), and users can turn it off in Settings.
import { CONFIG, SERVER, analyticsConfigured } from "./config.js";
export { analyticsConfigured };

/** Record an event from any page of the extension. The background worker batches and sends them. */
export function track(type, props = {}) {
  if (!analyticsConfigured) return;
  try { chrome.runtime.sendMessage({ type: "track", event: { type, props, at: Date.now() } }).catch(() => {}); } catch {}
}

/* ---------- background side ---------- */
const MAX_QUEUE = 500, BATCH = 100;

// Keep only short, primitive values: guards against ever shipping personal text by mistake.
function clean(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {}).slice(0, 20)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 80);
  }
  return out;
}

export async function enqueue(event) {
  if (!analyticsConfigured) return;
  const { settings = {}, analyticsQueue = [], lastActiveDay } = await chrome.storage.local.get(["settings", "analyticsQueue", "lastActiveDay"]);
  if (settings.shareUsage === false) return;
  const day = new Date().toISOString().slice(0, 10);
  // One "active" event per day per install gives daily / weekly / monthly active users.
  if (lastActiveDay !== day) analyticsQueue.push({ type: "active", props: {}, at: Date.now() });
  analyticsQueue.push({ type: String(event.type).slice(0, 40), props: clean(event.props), at: Number(event.at) || Date.now() });
  await chrome.storage.local.set({ analyticsQueue: analyticsQueue.slice(-MAX_QUEUE), lastActiveDay: day });
  if (analyticsQueue.length >= 20) flush();
}

let flushing = false;
export async function flush() {
  if (!analyticsConfigured || flushing) return;
  flushing = true;
  try {
    const { analyticsQueue = [], installId, settings = {} } = await chrome.storage.local.get(["analyticsQueue", "installId", "settings"]);
    if (!analyticsQueue.length || settings.shareUsage === false) return;
    const id = installId || await getInstallId();
    const batch = analyticsQueue.slice(0, BATCH);
    const res = await fetch(SERVER + "/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CVTree-Key": CONFIG.ingestKey },
      body: JSON.stringify({
        install: id,
        version: chrome.runtime.getManifest().version,
        browser: /Edg\//.test(navigator.userAgent) ? "Edge" : /OPR\//.test(navigator.userAgent) ? "Opera" : /Brave/.test(navigator.userAgent) ? "Brave" : "Chrome",
        locale: navigator.language,
        events: batch,
      }),
    });
    if (res.ok) {
      const { analyticsQueue: now = [] } = await chrome.storage.local.get("analyticsQueue");
      await chrome.storage.local.set({ analyticsQueue: now.slice(batch.length) });
    }
  } catch { /* offline or server down: keep the queue and try again later */ }
  finally { flushing = false; }
}

/** A random ID for this install, shared by usage stats and the hosted AI's daily allowance. */
export async function getInstallId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

/** Forget everything queued (used when someone turns sharing off). */
export const clearQueue = () => chrome.storage.local.set({ analyticsQueue: [] });
