// Fills a SEPARATE database with made-up usage so you can preview the dashboard before real users arrive.
// Usage:  node server/seed-demo.mjs            (writes server/demo.db)
// Then:   DB_PATH=server/demo.db ADMIN_TOKEN=... node server/server.mjs
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "./db.mjs";

const path = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "demo.db");
for (const f of [path, path + "-wal", path + "-shm"]) rmSync(f, { force: true });
const db = openDb(path);

let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (arr, w) => { if (!w) return arr[Math.floor(rand() * arr.length)]; let r = rand() * w.reduce((a, b) => a + b); for (let i = 0; i < arr.length; i++) if ((r -= w[i]) < 0) return arr[i]; return arr.at(-1); };
const DAY = 86400e3, now = Date.now();
const day = t => new Date(t).toISOString().slice(0, 10);

const ev = db.prepare("INSERT INTO events (install, type, at, day, props, version, received) VALUES (?, ?, ?, ?, ?, ?, ?)");
const inst = db.prepare("INSERT INTO installs (install, first_seen, last_seen, version, browser, locale, events) VALUES (?, ?, ?, ?, ?, ?, ?)");
const MODELS = [["openrouter", "openrouter/free"], ["openrouter", "anthropic/claude-haiku-5.5"], ["openrouter", "anthropic/claude-sonnet-5.5"], ["anthropic", "claude-opus-5-5"]];
const HOSTS = ["linkedin.com", "indeed.com", "boards.greenhouse.io", "jobs.lever.co", "glassdoor.com", "myworkdayjobs.com", "wellfound.com", "jobs.ashbyhq.com"];

db.exec("BEGIN");
for (let n = 0; n < 140; n++) {
  const id = randomUUID();
  const first = now - Math.floor(rand() ** 1.4 * 75) * DAY - Math.floor(rand() * DAY);
  const engagement = rand();                                   // how keen this person is
  const [provider, model] = pick(MODELS, [5, 3, 2, 1]);
  const version = pick(["1.0.0", "1.1.0", "1.2.0"], [1, 2, 6]), browser = pick(["Chrome", "Edge", "Brave"], [7, 2, 1]), locale = pick(["en-GB", "en-US", "en-NG", "fr-FR"], [3, 3, 3, 1]);
  let count = 0, last = first;
  const add = (type, t, props = {}) => { ev.run(id, type, t, day(t), JSON.stringify(props), version, t); count++; last = Math.max(last, t); };
  add("install", first); add("active", first);
  const cvSource = pick(["pdf", "docx", "manual", "example", "generated"], [5, 3, 2, 2, 1]);
  if (rand() < 0.82) add("cv_added", first + 3e5, { source: cvSource, from: "app" });
  if (rand() < 0.35) add("github_import", first + 6e5, { method: rand() < 0.5 ? "public" : "signin", repos: 4 + Math.floor(rand() * 20) });
  for (let d = 0; first + d * DAY < now; d++) {
    const t0 = first + d * DAY;
    const p = d === 0 ? 1 : engagement * 0.55 * Math.exp(-d / (10 + engagement * 40));
    if (rand() > p) continue;
    if (d) add("active", t0);
    const host = pick(HOSTS, [8, 5, 3, 3, 2, 2, 1, 1]);
    add("job_detected", t0 + 1e4, { host, source: pick(["structured data", "job board", "page text"]), cvs: 2, top: 40 + Math.floor(rand() * 50) });
    if (rand() < 0.7) add("widget_open", t0 + 2e4, { page: "job", host });
    if (rand() < 0.6) add("view", t0 + 3e4, { view: pick(["dashboard", "cvs", "match", "letters", "profile", "cv"]) });
    const ok = rand() > (model === "openrouter/free" ? 0.12 : 0.03);
    add("ai_request", t0 + 4e4, { op: "rank", from: pick(["widget", "app"]), provider, model, ms: 1500 + rand() * 6000, ok, code: ok ? "" : pick(["rate_limited", "bad_json", "auth", "privacy"], [4, 2, 1, 1]) });
    if (ok && rand() < 0.55) {
      const tailored = rand() < 0.7;
      add("ai_request", t0 + 6e4, { op: "generate", from: pick(["widget", "app"], [1, 2]), provider, model, ms: 9000 + rand() * 30000, ok: true, code: "", tailored });
      if (rand() < 0.6) add("pdf_download", t0 + 9e4, { kind: "cv", template: pick(["modern", "classic", "sidebar"], [5, 3, 2]), from: pick(["app", "widget"]) });
      if (rand() < 0.35) add("cv_attach", t0 + 1e5, { ok: rand() < 0.85, host });
      if (rand() < 0.2) add("cv_drag", t0 + 1e5, { ready: true, host });
    }
    if (rand() < 0.3) {
      add("ai_request", t0 + 2e5, { op: "letter", from: "app", provider, model, ms: 7000 + rand() * 15000, ok: true, code: "", tone: pick(["professional", "warm", "concise"]) });
      if (rand() < 0.6) add("pdf_download", t0 + 2.2e5, { kind: "letter", template: pick(["modern", "classic", "sidebar"], [5, 3, 2]), from: "app" });
    }
    if (rand() < 0.08) add("ai_request", t0 + 3e5, { op: "format", from: "app", provider, model, ms: 6000 + rand() * 8000, ok: true, code: "" });
    if (rand() < 0.05) add("match_paste", t0 + 3.5e5, { cvs: 3, top: 60 });
  }
  inst.run(id, first, last, version, browser, locale, count);
}
db.exec("COMMIT");
console.log(`Demo data written to ${path}: ${db.prepare("SELECT COUNT(*) n FROM installs").get().n} installs, ${db.prepare("SELECT COUNT(*) n FROM events").get().n} events.`);
