// Runs the background worker against a fake chrome API and a fake OpenRouter, to check
// request shapes, the structured-output fallback, JSON parsing and SSE streaming.
// Usage: node test/openrouter.test.mjs
import assert from "node:assert/strict";

const cvs = [
  { id: "cv-a", title: "Frontend Engineer", roles: "React", body: "React TypeScript" },
  { id: "cv-b", title: "GIS Developer", roles: "GIS", body: "QGIS Python" },
];
const store = { cvs, profile: { name: "Test", experience: "Dev at X" }, settings: { provider: "openrouter", orKey: "sk-or-test", orModel: "openrouter/free" } };
let connect;
globalThis.chrome = {
  storage: { local: { get: async keys => Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]])) }, onChanged: { addListener() {} } },
  runtime: { onConnect: { addListener: f => { connect = f; } }, onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, getURL: p => p, getManifest: () => ({ version: "test" }), getPlatformInfo: async () => ({}) },
  action: { onClicked: { addListener() {} } },
  alarms: { onAlarm: { addListener() {} }, create() {} },
  tabs: { create() {} }, downloads: { download: async () => {} },
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body, headers: init.headers });
  if (url.endsWith("/key")) return Response.json({ data: { is_free_tier: true } });
  if (body.stream) {
    const sse = [": OPENROUTER PROCESSING\n\n", 'data: {"choices":[{"delta":{"content":"# Test\\n## Sum"}}]}\n\nda',
      'ta: {"choices":[{"delta":{"content":"mary\\n- Built [add metric]"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"];
    return new Response(new ReadableStream({ start(c) { for (const s of sse) c.enqueue(new TextEncoder().encode(s)); c.close(); } }));
  }
  if (body.response_format) return Response.json({ error: { message: "response_format not supported" } }, { status: 400 });
  const answer = { role: "Frontend Engineer", company: "Acme", mustHaves: ["React"], recommendation: "tailor", advice: "Tailor it.",
    ranking: [{ id: "cv-b", score: "40", fits: ["Python"], gaps: [] }, { id: "cv-a", score: 88.4, why: "Strong React" }, { id: "cv-zzz", score: 99 }] };
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Sure! ```json\n" + JSON.stringify(answer) + "\n```" } }] });
};

await import("../src/background.js");

function run(msg) {
  return new Promise(resolve => {
    const texts = [];
    const port = {
      name: "ai",
      onDisconnect: { addListener() {} },
      onMessage: { addListener: f => setTimeout(() => f(msg)) },
      postMessage: m => { if (m.type === "text") texts.push(m.text); else resolve({ ...m, texts }); },
    };
    connect(port);
  });
}

const rank = await run({ op: "rank", job: { title: "FE", description: "React role" } });
assert.equal(rank.type, "done", JSON.stringify(rank));
assert.deepEqual(rank.result.ranking.map(r => r.id), ["cv-a", "cv-b"], "sorted, unknown ids dropped");
assert.equal(rank.result.ranking[0].score, 88);
assert.deepEqual(rank.result.ranking[0].fits, ["Strong React"], "old 'why' field becomes fits");
assert.equal(rank.result.ranking[0].action, "send");
const chat = calls.filter(c => c.url.endsWith("/chat/completions"));
assert.ok(chat[0].body.response_format, "first try asks for structured output");
assert.ok(!chat[1].body.response_format, "retry drops it");
assert.equal(chat[0].body.model, "openrouter/free");
assert.equal(chat[0].headers.Authorization, "Bearer sk-or-test");
console.log("rank ok");

const gen = await run({ op: "generate", job: { title: "FE", description: "React role" } });
assert.equal(gen.type, "done", JSON.stringify(gen));
assert.equal(gen.result.text, "# Test\n## Summary\n- Built [add metric]");
assert.equal(gen.result.truncated, false);
console.log("generate ok");

const letter = await run({ op: "letter", job: { title: "FE", company: "Acme", description: "React role" }, baseId: "cv-a", tone: "warm", length: "short" });
assert.equal(letter.type, "done", JSON.stringify(letter));
const lastPrompt = calls.at(-1).body.messages[0].content;
assert.match(lastPrompt, /warm and enthusiastic/); assert.match(lastPrompt, /about 180 words/); assert.match(lastPrompt, /React TypeScript/, "uses the chosen CV");
console.log("letter ok");

const ping = await run({ op: "ping" });
assert.equal(ping.result.name, "openrouter/free (free tier)");
console.log("ping ok");

store.settings.orKey = "";
const nokey = await run({ op: "rank", job: { description: "x" } });
assert.equal(nokey.type, "error"); assert.match(nokey.message, /OpenRouter API key/);
console.log("missing key ok");
