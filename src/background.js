// Service worker: makes every AI call (so API keys never touch web pages),
// opens the full app, saves downloads, and handles the toolbar button.
// Two providers: OpenRouter (default, has free models) and Anthropic (Claude API).
import Anthropic from "@anthropic-ai/sdk";
import { load, aiProvider } from "./lib/store.js";
import { enqueue, flush, getInstallId } from "./lib/analytics.js";
import { CONFIG, SERVER } from "./lib/config.js";
import { RANK_SCHEMA, LINKEDIN_SCHEMA, rankPrompt, generatePrompt, linkedinPrompt, formatPrompt, letterPrompt } from "./lib/match.js";

function coded(code, message, text) { return Object.assign(new Error(message), { code, text }); }

/* ======================= OpenRouter ======================= */
const OR_URL = "https://openrouter.ai/api/v1";
const MGMT_KEY = "This is an OpenRouter management key, which can't run AI requests. Create a normal API key at openrouter.ai/settings/keys and paste that instead.";

function orHeaders(settings) {
  if (!settings.orKey) throw coded("no_key", "Add your OpenRouter API key in CV Tree settings first.");
  return {
    Authorization: "Bearer " + settings.orKey,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/cv-tree",
    "X-Title": "CV Tree",
  };
}

async function orError(res) {
  const body = await res.json().catch(() => ({}));
  const msg = body?.error?.message || res.statusText || "";
  if (res.status === 401 && /user not found/i.test(msg)) return coded("auth", MGMT_KEY);
  if (res.status === 401) return coded("auth", "OpenRouter rejected your API key. Check it in Settings.");
  if (res.status === 402) return coded("credits", "This model needs OpenRouter credits. Pick a free model (ending in “:free”, or openrouter/free) in Settings.");
  if (res.status === 429) return coded("rate_limited", "OpenRouter's free-model limit was hit. Wait a minute, or try again tomorrow if you've used today's free requests.");
  if (/data policy|privacy/i.test(msg)) return coded("privacy", "Free models need a privacy setting changed: open openrouter.ai/settings/privacy and allow free model providers, then try again.");
  if (res.status === 400) return coded("bad_request", "OpenRouter couldn't take that request: " + msg, body);
  return coded("api", `OpenRouter returned an error (${res.status})${msg ? ": " + msg : ""}. Try again or pick another model.`);
}

/* CV Tree free AI: same request format as OpenRouter, sent to your server, which picks the model and applies limits. */
async function hostedChat(body, signal) {
  const res = await fetch(SERVER + "/v1/ai/chat/completions", {
    method: "POST", signal, body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-CVTree-Key": CONFIG.ingestKey, "X-CVTree-Install": await getInstallId() },
  });
  if (!res.ok) throw await hostedError(res);
  return res;
}

async function hostedError(res) {
  const { error = {} } = await res.json().catch(() => ({}));
  const ownKey = "add your own free OpenRouter key in Settings";
  if (error.code === "daily_limit") return coded("quota", `You've used today's ${error.limit} free AI requests. They reset at midnight (UTC). For unlimited use, ${ownKey}.`);
  if (error.code === "ip_limit") return coded("quota", `Too many free AI requests from your network today. Try tomorrow, or ${ownKey}.`);
  if (error.code === "budget" || error.code === "busy") return coded("busy", `CV Tree's free AI has reached today's limit for everyone. Try again tomorrow, or ${ownKey}.`);
  if (error.code === "disabled") return coded("disabled", `The free AI isn't available. To keep going, ${ownKey}.`);
  return coded("api", error.message || `The free AI returned an error (${res.status}). Try again.`);
}

async function orChat(settings, body, signal) {
  if (aiProvider(settings) === "cvtree") return hostedChat(body, signal);
  const res = await fetch(OR_URL + "/chat/completions", { method: "POST", headers: orHeaders(settings), body: JSON.stringify({ model: settings.orModel || "openrouter/free", ...body }), signal });
  if (!res.ok) throw await orError(res);
  return res;
}

/** Pull a JSON object out of a model reply, tolerating ```json fences or chatter around it. */
function parseJson(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw coded("bad_json", "The model's answer wasn't in the expected format. Try again, or pick a different model in Settings.");
}

async function orStructured(settings, prompt, schema, signal) {
  const content = `${prompt}

Reply with a single JSON object only, no other text, matching this JSON Schema:
${JSON.stringify(schema)}`;
  const base = { messages: [{ role: "user", content }], max_tokens: 8000 };
  let structured = true, lastErr;
  // Free models (especially openrouter/free, which picks a model per request) sometimes answer in the wrong
  // format; asking again usually lands a model that gets it right.
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await orChat(settings, structured ? { ...base, response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } } } : base, signal);
    } catch (err) {
      // Some free models don't support structured output: retry with the instruction alone.
      if (err.code !== "bad_request" || !structured) throw err;
      structured = false; attempt--; continue;
    }
    const data = await res.json();
    if (data.error) { lastErr = coded("api", data.error.message || "The model returned an error."); continue; }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") throw coded("truncated", "The model's answer was cut off. Try with fewer or shorter CVs.");
    try { return parseJson(choice?.message?.content); } catch (err) { lastErr = err; }
  }
  throw aiProvider(settings) === "cvtree" ? coded("bad_json", "The free AI gave a garbled answer three times. Please try again in a moment.") : lastErr;
}

async function orStream(settings, prompt, signal, onText) {
  const res = await orChat(settings, { stream: true, max_tokens: 12000, messages: [{ role: "user", content: prompt }] }, signal);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", last = 0, finish = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;          // skips ": OPENROUTER PROCESSING" keep-alives
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.error) throw coded("api", chunk.error.message || "The model stopped with an error.", text);
      const c = chunk.choices?.[0];
      if (c?.delta?.content) text += c.delta.content;
      if (c?.finish_reason) finish = c.finish_reason;
      if (Date.now() - last > 80) { onText(text); last = Date.now(); }
    }
  }
  onText(text);
  if (!text.trim()) throw coded("empty", "The model returned nothing. Try again, or pick a different model in Settings.");
  return { text, truncated: finish === "length" };
}

async function orPing(settings, signal) {
  if (aiProvider(settings) === "cvtree") {
    const res = await fetch(`${SERVER}/v1/ai/quota`, { signal, headers: { "X-CVTree-Key": CONFIG.ingestKey, "X-CVTree-Install": await getInstallId() } });
    if (!res.ok) throw await hostedError(res);
    const q = await res.json();
    if (!q.enabled) throw coded("disabled", "The free AI isn't available right now. Add your own free OpenRouter key instead.");
    return { name: "CV Tree free AI", remaining: q.remaining, limit: q.limit };
  }
  const res = await fetch(OR_URL + "/key", { headers: orHeaders(settings), signal });
  if (!res.ok) throw await orError(res);
  const { data } = await res.json();
  if (data?.is_management_key || data?.is_provisioning_key) throw coded("auth", MGMT_KEY);
  const model = settings.orModel || "openrouter/free";
  return { name: `${model}${data?.is_free_tier ? " (free tier)" : ""}` };
}

/* ======================= Anthropic (Claude API) ======================= */
// fallbacks: "default" re-runs a request Claude's safety classifiers decline on Anthropic's recommended model.
// Haiku has no server-side fallback, so it goes without.
const withFallback = model => /haiku/.test(model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

function clientFor(settings) {
  if (!settings.apiKey) throw coded("no_key", "Add your Claude API key in CV Tree settings first.");
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function anthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) return coded("auth", "Your Claude API key was rejected. Check it in Settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return coded("auth", "This API key can't use that model. Pick another model in Settings.");
  if (err instanceof Anthropic.RateLimitError) return coded("rate_limited", "Claude is rate-limiting this key. Wait a minute and try again.");
  if (err instanceof Anthropic.BadRequestError) return coded("bad_request", "Claude couldn't take that request: " + err.message);
  if (err instanceof Anthropic.APIUserAbortError) return coded("cancelled", "Stopped.");
  if (err instanceof Anthropic.APIConnectionError) return coded("network", "Couldn't reach Claude. Check your connection.");
  if (err instanceof Anthropic.APIError) return coded("api", `Claude returned an error (${err.status ?? "unknown"}). Try again.`);
  return null;
}

function textOf(message) {
  if (message.stop_reason === "refusal") throw coded("refused", "Claude declined this request. Try rewording the job description.");
  return message.content.filter(b => b.type === "text").map(b => b.text).join("");
}

async function anStructured(settings, prompt, schema, signal) {
  const res = await clientFor(settings).beta.messages.create({
    model: settings.model,
    max_tokens: 16000,
    ...withFallback(settings.model),
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  }, { signal });
  if (res.stop_reason === "max_tokens") throw coded("truncated", "Claude's answer was cut off. Try with fewer or shorter CVs.");
  return JSON.parse(textOf(res));
}

async function anStream(settings, prompt, signal, onText) {
  const stream = clientFor(settings).beta.messages.stream({
    model: settings.model,
    max_tokens: 64000,
    ...withFallback(settings.model),
    output_config: { effort: "high" },
    messages: [{ role: "user", content: prompt }],
  }, { signal });
  let text = "", last = 0;
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      if (Date.now() - last > 80) { onText(text); last = Date.now(); }
    }
  }
  const final = await stream.finalMessage();
  const full = textOf(final) || text;
  onText(full);
  return { text: full, truncated: final.stop_reason === "max_tokens" };
}

async function anPing(settings, signal) {
  const m = await clientFor(settings).models.retrieve(settings.model, {}, { signal });
  return { name: m.display_name || m.id };
}

/* ======================= provider switch ======================= */
const isOR = s => aiProvider(s) !== "anthropic";
const structured = (s, p, schema, signal) => isOR(s) ? orStructured(s, p, schema, signal) : anStructured(s, p, schema, signal);
const streamCv = (s, p, signal, onText) => isOR(s) ? orStream(s, p, signal, onText) : anStream(s, p, signal, onText);

function friendly(err) {
  if (err?.name === "AbortError") return coded("cancelled", "Stopped.");
  if (err?.code) return err;
  const an = anthropicError(err);
  if (an) return an;
  if (err instanceof TypeError) return coded("network", "Couldn't reach the AI service. Check your connection.");
  return coded("unknown", err?.message || "Something went wrong.");
}

// Free models are less strict about the schema: fill in anything missing so the UI never breaks.
function normaliseRank(res, cvs) {
  const ranking = (Array.isArray(res.ranking) ? res.ranking : [])
    .filter(r => r && cvs.some(c => c.id === r.id))
    .map(r => {
      const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)));
      return {
        id: r.id, score,
        fits: Array.isArray(r.fits) ? r.fits.map(String).slice(0, 3) : r.why ? [String(r.why)] : [],
        gaps: Array.isArray(r.gaps) ? r.gaps.map(String).slice(0, 4) : [],
        action: ["send", "tailor", "generate"].includes(r.action) ? r.action : score >= 80 ? "send" : score >= 55 ? "tailor" : "generate",
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!ranking.length) throw coded("bad_json", "The model didn't score your CVs. Try again, or pick a different model in Settings.");
  return {
    role: String(res.role || ""), company: String(res.company || ""),
    mustHaves: Array.isArray(res.mustHaves) ? res.mustHaves.map(String).slice(0, 6) : [],
    ranking,
    recommendation: ["send", "tailor", "generate"].includes(res.recommendation) ? res.recommendation : ranking[0].action,
    advice: String(res.advice || ""),
  };
}

const OPS = {
  async rank({ job }, settings, signal, data) {
    if (!data.cvs.length) throw coded("no_cvs", "Save at least one CV first.");
    return normaliseRank(await structured(settings, rankPrompt(job, data.cvs), RANK_SCHEMA, signal), data.cvs);
  },
  async generate({ job, baseId }, settings, signal, data, send) {
    const base = baseId ? data.cvs.find(c => c.id === baseId) : null;
    return streamCv(settings, generatePrompt(job, data.profile, base), signal, text => send({ type: "text", text }));
  },
  async letter({ job, baseId, baseText, tone, length }, settings, signal, data, send) {
    const base = baseId ? data.cvs.find(c => c.id === baseId) : baseText ? { title: "Tailored CV", body: baseText } : null;
    return streamCv(settings, letterPrompt(job, data.profile, base, { tone, length }), signal, t => send({ type: "text", text: t }));
  },
  async format({ text }, settings, signal, _data, send) {
    return streamCv(settings, formatPrompt(text), signal, t => send({ type: "text", text: t }));
  },
  async ping(_msg, settings, signal) {
    return isOR(settings) ? orPing(settings, signal) : anPing(settings, signal);
  },
  async linkedin({ pageText }, settings, signal) {
    const x = await structured(settings, linkedinPrompt(pageText), LINKEDIN_SCHEMA, signal);
    return {
      name: String(x.name || ""), headline: String(x.headline || ""),
      skills: Array.isArray(x.skills) ? x.skills.map(String) : String(x.skills || "").split(",").map(s => s.trim()).filter(Boolean),
      experience: String(x.experience || ""), education: String(x.education || ""),
    };
  },
};

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "ai") return;
  const ctl = new AbortController();
  let partial = "";
  const send = m => { if (m.type === "text") partial = m.text; try { port.postMessage(m); } catch {} };
  port.onDisconnect.addListener(() => ctl.abort());
  // Where the request came from, for usage stats: the full app or the widget on a site.
  const from = port.sender?.url?.startsWith(chrome.runtime.getURL("")) ? "app" : "widget";
  port.onMessage.addListener(async msg => {
    const started = Date.now();
    let settings = {}, code = "";
    try {
      const op = OPS[msg.op];
      if (!op) throw coded("bad_op", "Unknown request.");
      const data = await load();
      settings = data.settings;
      const result = await op(msg, data.settings, ctl.signal, data, send);
      send({ type: "done", result });
    } catch (err) {
      const e = friendly(err);
      code = e.code || "unknown";
      send({ type: "error", code: e.code, message: e.message, text: partial || (typeof e.text === "string" ? e.text : "") });
    }
    const provider = aiProvider(settings);
    enqueue({ type: "ai_request", at: started, props: {
      op: msg.op, from, provider, model: provider === "cvtree" ? "cvtree-free" : provider === "openrouter" ? settings.orModel || "openrouter/free" : settings.model || "",
      ms: Date.now() - started, ok: !code, code, tone: msg.tone || "", tailored: !!msg.baseId,
    } });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "track") {
    enqueue(msg.event);
  } else if (msg.type === "flushAnalytics") {
    flush();
  } else if (msg.type === "openApp") {
    chrome.tabs.create({ url: chrome.runtime.getURL("app.html" + (msg.hash ? "#" + msg.hash : "")) });
  } else if (msg.type === "openUrl" && /^https:\/\//.test(msg.url)) {
    chrome.tabs.create({ url: msg.url });
  } else if (msg.type === "downloadUrl" && /^data:application\/(pdf|vnd\.openxmlformats|octet-stream)/.test(msg.url)) {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: true })
      .then(() => reply({ ok: true }), e => reply({ ok: false, message: String(e?.message || e) }));
    return true;
  } else if (msg.type === "download") {
    const url = "data:text/markdown;charset=utf-8," + encodeURIComponent(msg.text);
    chrome.downloads.download({ url, filename: msg.filename, saveAs: true })
      .then(() => reply({ ok: true }), e => reply({ ok: false, message: String(e?.message || e) }));
    return true;
  }
});

// Toolbar button: show the widget on this page (even if it's not a job page), else open the app.
chrome.action.onClicked.addListener(async tab => {
  try { await chrome.tabs.sendMessage(tab.id, { type: "toggle" }); }
  catch { chrome.tabs.create({ url: chrome.runtime.getURL("app.html") }); }
});

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("app.html#welcome") });
  if (reason === "install" || reason === "update") enqueue({ type: reason, props: { from: previousVersion || "" } }).then(flush);
  chrome.alarms.create("cvtree-analytics", { periodInMinutes: 5 });
});
// Usage stats go out in small batches every few minutes (and sooner when 20 have queued up).
chrome.alarms.onAlarm.addListener(a => { if (a.name === "cvtree-analytics") flush(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create("cvtree-analytics", { periodInMinutes: 5 }); flush(); });
