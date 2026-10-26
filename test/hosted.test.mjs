// The free hosted AI from the extension's side: requests go to your server with the install ID,
// users with their own key bypass it, and the daily-limit error reads well.
// Usage: node test/hosted.test.mjs
import assert from "node:assert/strict";

globalThis.__CVTREE__ = { serverUrl: "https://cv.example.com", analytics: false, hostedAI: true, ingestKey: "test-key", githubClientId: "" };
const store = {
  cvs: [{ id: "cv-a", title: "Frontend", roles: "React", body: "React" }],
  profile: { name: "T", experience: "Dev" },
  settings: { provider: "" },
  installId: "11111111-2222-3333-4444-555555555555",
};
let connect;
globalThis.chrome = {
  storage: { local: { get: async keys => Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]])), set: async o => Object.assign(store, o) }, onChanged: { addListener() {} } },
  runtime: { onConnect: { addListener: f => { connect = f; } }, onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, getURL: p => "chrome-extension://x/" + p, getManifest: () => ({ version: "t" }) },
  action: { onClicked: { addListener() {} } }, alarms: { onAlarm: { addListener() {} }, create() {} }, tabs: { create() {} }, downloads: { download: async () => {} },
};
const calls = [];
let next = null;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
  if (next) { const r = next; next = null; return r; }
  if (url.endsWith("/v1/ai/quota")) return Response.json({ enabled: true, limit: 30, used: 4, remaining: 26 });
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ role: "FE", company: "", mustHaves: [], recommendation: "send", advice: "", ranking: [{ id: "cv-a", score: 90, fits: ["React"], gaps: [], action: "send" }] }) } }] });
};
await import("../src/background.js");
const run = msg => new Promise(resolve => connect({ name: "ai", sender: { url: "chrome-extension://x/app.html" }, onDisconnect: { addListener() {} },
  onMessage: { addListener: f => setTimeout(() => f(msg)) }, postMessage: m => { if (m.type !== "text") resolve(m); } }));

const ping = await run({ op: "ping" });
assert.equal(ping.result.remaining, 26);
const rank = await run({ op: "rank", job: { description: "React" } });
assert.equal(rank.type, "done", JSON.stringify(rank));
const last = calls.at(-1);
assert.equal(last.url, "https://cv.example.com/v1/ai/chat/completions");
assert.equal(last.headers["X-CVTree-Install"], store.installId);
assert.equal(last.headers["X-CVTree-Key"], "test-key");
assert.ok(!last.headers.Authorization, "no user key is sent to our server");
console.log("free AI used by default ok");

next = Response.json({ error: { code: "daily_limit", limit: 30 } }, { status: 429 });
const limited = await run({ op: "rank", job: { description: "React" } });
assert.equal(limited.code, "quota");
assert.match(limited.message, /today's 30 free AI requests.*own free OpenRouter key/);
console.log("daily limit message ok");

store.settings = { provider: "", orKey: "sk-or-v1-mine" };
await run({ op: "rank", job: { description: "React" } });
assert.match(calls.at(-1).url, /^https:\/\/openrouter\.ai\//);
assert.equal(calls.at(-1).headers.Authorization, "Bearer sk-or-v1-mine");
console.log("own key bypasses free AI ok");
