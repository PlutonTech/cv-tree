// CV Tree server: anonymous usage stats, the admin dashboard, the free hosted AI and the privacy policy page.
// No dependencies (Node 22.13+ for the built-in node:sqlite). Run:  ADMIN_TOKEN=... node server/server.mjs
//
// Env:
//   ADMIN_TOKEN     required. Password for the admin dashboard.
//   INGEST_KEY      must match "ingestKey" in cvtree.config.json (default "cvtree-ingest"). Not a secret; it filters noise.
//   PORT            default 8787
//   DB_PATH         default server/cvtree-analytics.db
//   PUBLISHER_NAME  shown on the privacy policy (e.g. your name or company)
//   CONTACT_EMAIL   shown on the privacy policy
//   OPENROUTER_API_KEY and HOSTED_*: the free hosted AI, see hosted-ai.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb } from "./db.mjs";
import { setupHostedAi, hosted } from "./hosted-ai.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const INGEST_KEY = process.env.INGEST_KEY || "cvtree-ingest";
const DB_PATH = process.env.DB_PATH || join(here, "cvtree-analytics.db");
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error("Set ADMIN_TOKEN to a password of at least 12 characters, e.g.  ADMIN_TOKEN=change-me-please node server/server.mjs");
  process.exit(1);
}

/* ---------- storage ---------- */
const db = openDb(DB_PATH);
const freeAi = setupHostedAi(db);

const insertEvent = db.prepare("INSERT INTO events (install, type, at, day, props, version, received) VALUES (?, ?, ?, ?, ?, ?, ?)");
const upsertInstall = db.prepare(`INSERT INTO installs (install, first_seen, last_seen, version, browser, locale, events) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(install) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen),
  version = excluded.version, browser = excluded.browser, locale = excluded.locale, events = events + excluded.events`);

/* ---------- ingest ---------- */
const perInstallToday = new Map();   // install -> {day, n}: at most 3000 events per install per day
const ID = /^[0-9a-f-]{36}$/i, TYPE = /^[a-z_]{1,40}$/;
const DAY_MS = 86400e3;
const dayOf = t => new Date(t).toISOString().slice(0, 10);

function cleanProps(p) {
  const out = {};
  if (!p || typeof p !== "object") return out;
  for (const [k, v] of Object.entries(p).slice(0, 20)) {
    if (!/^[a-zA-Z_]{1,30}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 80);
  }
  return out;
}

function ingest(body) {
  if (!ID.test(body?.install || "") || !Array.isArray(body.events)) return { status: 400, error: "bad batch" };
  const now = Date.now(), today = dayOf(now);
  const quota = perInstallToday.get(body.install);
  const used = quota?.day === today ? quota.n : 0;
  const events = body.events.slice(0, 200).filter(e => TYPE.test(e?.type || ""));
  if (used + events.length > 3000) return { status: 429, error: "too many events" };
  perInstallToday.set(body.install, { day: today, n: used + events.length });
  const version = String(body.version || "").slice(0, 20), browser = String(body.browser || "").slice(0, 20), locale = String(body.locale || "").slice(0, 20);
  let first = now, last = 0;
  db.exec("BEGIN");
  try {
    for (const e of events) {
      // Trust the device clock only within a week; otherwise use the time we received it.
      const at = Number.isFinite(e.at) && e.at > now - 7 * DAY_MS && e.at < now + 3600e3 ? e.at : now;
      first = Math.min(first, at); last = Math.max(last, at);
      insertEvent.run(body.install, e.type, at, dayOf(at), JSON.stringify(cleanProps(e.props)), version, now);
    }
    if (events.length) upsertInstall.run(body.install, first, last, version, browser, locale, events.length);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  return { status: 200, accepted: events.length };
}

/* ---------- admin auth: one password, a signed cookie ---------- */
const SESSION = createHmac("sha256", ADMIN_TOKEN).update("cvtree-admin-session").digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
function isAdmin(req) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (bearer && same(bearer, ADMIN_TOKEN)) return true;
  const cookie = /(?:^|;\s*)cvtree_admin=([a-f0-9]{64})/.exec(req.headers.cookie || "")?.[1];
  return !!cookie && same(cookie, SESSION);
}
const failedLogins = new Map();   // ip -> {n, until}

/* ---------- analytics queries ---------- */
const FEATURE_LABELS = {
  match: "Matched a job", cv_tailored: "Tailored a CV", cv_written: "Wrote a new CV", letter: "Wrote a cover letter",
  format: "Formatted an upload", linkedin: "Imported LinkedIn", pdf_download: "Downloaded a PDF", cv_attach: "Attached to a form",
  cv_drag: "Dragged a CV", cv_added: "Added a CV", github_import: "Imported GitHub", widget_open: "Opened the quick menu",
  job_upload: "Uploaded a job description", text_download: "Downloaded text",
};

export function summary(days = 30, now = Date.now()) {
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const end = dayOf(now), start = dayOf(now - (days - 1) * DAY_MS);
  const prevEnd = dayOf(now - days * DAY_MS), prevStart = dayOf(now - (2 * days - 1) * DAY_MS);
  const range = [start, end], prev = [prevStart, prevEnd];

  const activeIn = ([a, b]) => one("SELECT COUNT(DISTINCT install) n FROM events WHERE day BETWEEN ? AND ?", a, b).n;
  const newIn = ([a, b]) => one("SELECT COUNT(*) n FROM installs WHERE date(first_seen/1000,'unixepoch') BETWEEN ? AND ?", a, b).n;
  const aiIn = ([a, b]) => one(`SELECT COUNT(*) n, SUM(json_extract(props,'$.ok')) ok, AVG(json_extract(props,'$.ms')) ms
    FROM events WHERE type='ai_request' AND json_extract(props,'$.op') != 'ping' AND day BETWEEN ? AND ?`, a, b);
  const countIn = (type, [a, b]) => one("SELECT COUNT(*) n FROM events WHERE type=? AND day BETWEEN ? AND ?", type, a, b).n;
  const ai = aiIn(range), aiPrev = aiIn(prev);

  const kpis = {
    totalInstalls: one("SELECT COUNT(*) n FROM installs").n,
    dau: activeIn([end, end]), wau: activeIn([dayOf(now - 6 * DAY_MS), end]), mau: activeIn([dayOf(now - 29 * DAY_MS), end]),
    active: activeIn(range), activePrev: activeIn(prev),
    newInstalls: newIn(range), newInstallsPrev: newIn(prev),
    aiRequests: ai.n, aiRequestsPrev: aiPrev.n,
    aiSuccess: ai.n ? ai.ok / ai.n : null, aiAvgMs: ai.ms ? Math.round(ai.ms) : null,
    pdfDownloads: countIn("pdf_download", range), attaches: one("SELECT COUNT(*) n FROM events WHERE type='cv_attach' AND json_extract(props,'$.ok')=1 AND day BETWEEN ? AND ?", ...range).n,
    events: one("SELECT COUNT(*) n FROM events WHERE day BETWEEN ? AND ?", ...range).n,
  };

  // Daily series, every day in the range present (zeros included).
  const byDay = Object.fromEntries(q(`SELECT day, COUNT(DISTINCT install) active,
      SUM(type='ai_request' AND json_extract(props,'$.op')!='ping') ai FROM events WHERE day BETWEEN ? AND ? GROUP BY day`, ...range).map(r => [r.day, r]));
  const installsByDay = Object.fromEntries(q(`SELECT date(first_seen/1000,'unixepoch') day, COUNT(*) n FROM installs
      WHERE date(first_seen/1000,'unixepoch') BETWEEN ? AND ? GROUP BY 1`, ...range).map(r => [r.day, r.n]));
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayOf(now - i * DAY_MS);
    daily.push({ day: d, active: byDay[d]?.active || 0, installs: installsByDay[d] || 0, ai: byDay[d]?.ai || 0 });
  }

  // Feature use: one row per thing a person did, with how many people did it.
  const feat = (key, where) => ({ key, label: FEATURE_LABELS[key], ...one(`SELECT COUNT(*) uses, COUNT(DISTINCT install) users FROM events WHERE ${where} AND day BETWEEN ? AND ?`, ...range) });
  const okAi = op => `type='ai_request' AND json_extract(props,'$.ok')=1 AND json_extract(props,'$.op')='${op}'`;
  const features = [
    feat("match", `(type IN ('match_keyword','match_paste') OR (${okAi("rank")}))`),
    feat("cv_tailored", `${okAi("generate")} AND json_extract(props,'$.tailored')=1`),
    feat("cv_written", `${okAi("generate")} AND json_extract(props,'$.tailored')=0`),
    feat("letter", okAi("letter")), feat("format", okAi("format")), feat("linkedin", okAi("linkedin")),
    feat("pdf_download", "type='pdf_download'"), feat("cv_attach", "type='cv_attach' AND json_extract(props,'$.ok')=1"),
    feat("cv_drag", "type='cv_drag'"), feat("cv_added", "type='cv_added'"), feat("github_import", "type='github_import'"),
    feat("widget_open", "type='widget_open'"), feat("job_upload", "type='job_upload'"),
  ].sort((a, b) => b.users - a.users || b.uses - a.uses);

  const aiModels = q(`SELECT json_extract(props,'$.provider') provider, json_extract(props,'$.model') model, COUNT(*) requests,
      SUM(json_extract(props,'$.ok')) ok, ROUND(AVG(json_extract(props,'$.ms'))) avgMs, COUNT(DISTINCT install) users
      FROM events WHERE type='ai_request' AND json_extract(props,'$.op')!='ping' AND day BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY requests DESC LIMIT 20`, ...range);
  const aiOps = q(`SELECT json_extract(props,'$.op') op, COUNT(*) requests, SUM(json_extract(props,'$.ok')) ok, ROUND(AVG(json_extract(props,'$.ms'))) avgMs,
      SUM(json_extract(props,'$.from')='widget') fromWidget
      FROM events WHERE type='ai_request' AND json_extract(props,'$.op')!='ping' AND day BETWEEN ? AND ? GROUP BY 1 ORDER BY requests DESC`, ...range);
  const errors = q(`SELECT json_extract(props,'$.code') code, json_extract(props,'$.op') op, COUNT(*) n, COUNT(DISTINCT install) users, MAX(at) last
      FROM events WHERE type='ai_request' AND json_extract(props,'$.ok')=0 AND day BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 15`, ...range);
  const sites = q(`SELECT json_extract(props,'$.host') host, COUNT(*) jobs, COUNT(DISTINCT install) users
      FROM events WHERE type='job_detected' AND day BETWEEN ? AND ? GROUP BY 1 ORDER BY users DESC, jobs DESC LIMIT 12`, ...range);
  const cvSources = q(`SELECT json_extract(props,'$.source') source, COUNT(*) n FROM events WHERE type='cv_added' AND day BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC`, ...range);
  const templates = q(`SELECT json_extract(props,'$.template') template, json_extract(props,'$.kind') kind, COUNT(*) n
      FROM events WHERE type='pdf_download' AND day BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY n DESC`, ...range);
  const views = q(`SELECT json_extract(props,'$.view') view, COUNT(*) n, COUNT(DISTINCT install) users FROM events WHERE type='view' AND day BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC`, ...range);

  // Funnel over everyone who installed in the range: how far did they get?
  const cohort = `SELECT install FROM installs WHERE date(first_seen/1000,'unixepoch') BETWEEN '${start}' AND '${end}'`;
  const reached = where => one(`SELECT COUNT(DISTINCT install) n FROM events WHERE install IN (${cohort}) AND (${where})`).n;
  const installed = one(`SELECT COUNT(*) n FROM (${cohort})`).n;
  const funnel = [
    { step: "Installed", n: installed },
    { step: "Added a CV", n: reached("type='cv_added'") },
    { step: "Matched a job", n: reached(`type IN ('match_keyword','match_paste') OR (${okAi("rank")})`) },
    { step: "Wrote a CV or letter", n: reached(`${okAi("generate")} OR ${okAi("letter")}`) },
    { step: "Sent a CV (PDF, attach or drag)", n: reached("type IN ('pdf_download','cv_drag') OR (type='cv_attach' AND json_extract(props,'$.ok')=1)") },
  ];

  // Weekly retention: of people who installed in week W, how many were active in weeks W+1..W+4.
  const weekStart = t => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime(); };
  const retention = [];
  const thisWeek = weekStart(now);
  for (let w = 7; w >= 0; w--) {
    const ws = thisWeek - w * 7 * DAY_MS, we = ws + 7 * DAY_MS;
    const ids = q("SELECT install FROM installs WHERE first_seen >= ? AND first_seen < ?", ws, we).map(r => r.install);
    const row = { week: dayOf(ws), size: ids.length, weeks: [] };
    for (let k = 1; k <= 4; k++) {
      const ks = ws + k * 7 * DAY_MS;
      if (ks > now) { row.weeks.push(null); continue; }
      const n = ids.length ? one(`SELECT COUNT(DISTINCT install) n FROM events WHERE type='active' AND at >= ? AND at < ? AND install IN (${ids.map(() => "?").join(",")})`, ks, ks + 7 * DAY_MS, ...ids).n : 0;
      row.weeks.push(ids.length ? n / ids.length : null);
    }
    retention.push(row);
  }

  const versions = q("SELECT version, COUNT(*) installs, MAX(last_seen) last FROM installs GROUP BY 1 ORDER BY installs DESC LIMIT 10");
  const browsers = q("SELECT browser, COUNT(*) installs FROM installs GROUP BY 1 ORDER BY installs DESC");
  const clients = q(`SELECT i.install, i.first_seen, i.last_seen, i.version, i.browser, i.locale, i.events,
      (SELECT COUNT(*) FROM events e WHERE e.install = i.install AND e.type='ai_request' AND json_extract(e.props,'$.op')!='ping') ai,
      (SELECT COUNT(*) FROM events e WHERE e.install = i.install AND e.type='cv_added') cvs,
      (SELECT COUNT(*) FROM events e WHERE e.install = i.install AND e.type='pdf_download') pdfs,
      (SELECT COUNT(DISTINCT day) FROM events e WHERE e.install = i.install) activeDays
      FROM installs i ORDER BY i.last_seen DESC LIMIT 100`);
  const recent = q("SELECT install, type, at, props FROM events WHERE type NOT IN ('active','view') ORDER BY at DESC LIMIT 40")
    .map(r => ({ ...r, props: JSON.parse(r.props) }));

  const hostedAi = freeAi.stats(start, end, daily.map(d => d.day));
  return { days, start, end, generated: now, kpis, hostedAi, daily, features, aiModels, aiOps, errors, sites, cvSources, templates, views, funnel, retention, versions, browsers, clients, recent };
}

const clientDetail = id => ({
  install: db.prepare("SELECT * FROM installs WHERE install = ?").get(id),
  events: db.prepare("SELECT type, at, props, version FROM events WHERE install = ? ORDER BY at DESC LIMIT 300").all(id).map(r => ({ ...r, props: JSON.parse(r.props) })),
});

function csv() {
  const rows = db.prepare("SELECT install, type, at, day, props, version FROM events ORDER BY at").all();
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return ["install,type,time,day,props,version", ...rows.map(r => [r.install, r.type, new Date(r.at).toISOString(), r.day, r.props, r.version].map(cell).join(","))].join("\n");
}

/* ---------- http ---------- */
const DASHBOARD = () => readFileSync(join(here, "dashboard.html"), "utf8");
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-CVTree-Key, X-CVTree-Install", "Access-Control-Max-Age": "86400" };
const PRIVACY = () => readFileSync(join(here, "privacy.html"), "utf8")
  .replace("{{UPDATED}}", "24 October 2026")
  .replace("{{PUBLISHER}}", escHtml(process.env.PUBLISHER_NAME || "the CV Tree team"))
  .replace("{{CONTACT}}", process.env.CONTACT_EMAIL ? `Questions or requests: <a href="mailto:${escHtml(process.env.CONTACT_EMAIL)}">${escHtml(process.env.CONTACT_EMAIL)}</a>` : "Contact the publisher through the Chrome Web Store listing.");
function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function send(res, status, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(status, { ...SECURITY, "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const LOGIN = err => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CV Tree admin</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F8F7;font:15px system-ui,sans-serif;color:#10231C}
form{background:#fff;border:1px solid #E4EAE7;border-radius:14px;padding:28px;display:grid;gap:12px;width:min(340px,90vw)}
h1{margin:0;font-size:20px}input{padding:11px;border:1px solid #E4EAE7;border-radius:10px;font:inherit}
button{padding:11px;border:none;border-radius:10px;background:#0E7A55;color:#fff;font:700 15px system-ui;cursor:pointer}p{margin:0;color:#D9483F;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#0D1412;color:#E6EEEA}form{background:#131C19;border-color:#24322D}input{background:#0D1412;color:#E6EEEA;border-color:#24322D}}</style>
<form method="post" action="/admin/login"><h1>CV Tree admin</h1><label for="t">Admin password</label><input id="t" name="token" type="password" autocomplete="current-password" required autofocus>${err ? `<p>${err}</p>` : ""}<button>Sign in</button></form>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = req.socket.remoteAddress || "", ip0 = ip;
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });

    if (url.pathname === "/privacy") return send(res, 200, PRIVACY(), { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });

    if (url.pathname.startsWith("/v1/ai/")) {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      if (!same(req.headers["x-cvtree-key"] || "", INGEST_KEY)) return send(res, 401, { error: { code: "bad_key", message: "Unknown client." } }, CORS);
      const install = String(req.headers["x-cvtree-install"] || url.searchParams.get("install") || "");
      if (!/^[0-9a-f-]{36}$/i.test(install)) return send(res, 400, { error: { code: "bad_install", message: "Missing install ID." } }, CORS);
      if (url.pathname === "/v1/ai/quota" && req.method === "GET") return send(res, 200, freeAi.quota(install), { ...CORS, "Cache-Control": "no-store" });
      if (url.pathname === "/v1/ai/chat/completions" && req.method === "POST") {
        const ip = String(req.headers["x-forwarded-for"] || ip0).split(",")[0].trim();
        return await freeAi.chat(req, res, JSON.parse(await readBody(req, 600 * 1024)), { install, ip, send, cors: CORS });
      }
      return send(res, 404, { error: { code: "not_found", message: "Not found." } }, CORS);
    }

    if (url.pathname === "/v1/events") {
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
      if (req.method !== "POST") return send(res, 405, { error: "POST only" }, CORS);
      if (!same(req.headers["x-cvtree-key"] || "", INGEST_KEY)) return send(res, 401, { error: "bad key" }, CORS);
      const out = ingest(JSON.parse(await readBody(req)));
      return send(res, out.status, out, CORS);
    }

    if (url.pathname === "/admin/login" && req.method === "POST") {
      const f = failedLogins.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, LOGIN("Too many attempts. Wait a few minutes."), { "Content-Type": "text/html; charset=utf-8" });
      const token = new URLSearchParams(await readBody(req, 4096)).get("token") || "";
      if (!same(token, ADMIN_TOKEN)) {
        const n = (f?.n || 0) + 1;
        failedLogins.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60e3 : 0 });
        return send(res, 401, LOGIN("That password isn't right."), { "Content-Type": "text/html; charset=utf-8" });
      }
      failedLogins.delete(ip);
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      res.writeHead(303, { ...SECURITY, Location: "/admin", "Set-Cookie": `cvtree_admin=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
      return res.end();
    }
    if (url.pathname === "/admin/logout") {
      res.writeHead(303, { ...SECURITY, Location: "/admin", "Set-Cookie": "cvtree_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      return res.end();
    }

    if (url.pathname === "/" || url.pathname.startsWith("/admin")) {
      if (!isAdmin(req)) {
        if (url.pathname.startsWith("/admin/api")) return send(res, 401, { error: "sign in" });
        return send(res, 200, LOGIN(""), { "Content-Type": "text/html; charset=utf-8" });
      }
      if (url.pathname === "/" || url.pathname === "/admin") return send(res, 200, DASHBOARD(), { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      if (url.pathname === "/admin/api/summary") {
        const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
        return send(res, 200, summary(days), { "Cache-Control": "no-store" });
      }
      if (url.pathname === "/admin/api/client") return send(res, 200, clientDetail(url.searchParams.get("id") || ""), { "Cache-Control": "no-store" });
      if (url.pathname === "/admin/api/export.csv") return send(res, 200, csv(), { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="cvtree-events-${dayOf(Date.now())}.csv"` });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (!err.status && !(err instanceof SyntaxError)) console.error(new Date().toISOString(), req.method, url.pathname, err);
    send(res, err.status || 400, { error: err.status ? err.message : "bad request" }, url.pathname === "/v1/events" ? CORS : {});
  }
});

// Keep data only as long as the privacy policy says: usage events 24 months, free-AI records 12 months.
function prune() {
  const now = Date.now();
  db.prepare("DELETE FROM events WHERE at < ?").run(now - 730 * DAY_MS);
  db.prepare("DELETE FROM ai_usage WHERE at < ?").run(now - 365 * DAY_MS);
  db.prepare("DELETE FROM installs WHERE last_seen < ? AND install NOT IN (SELECT DISTINCT install FROM events)").run(now - 730 * DAY_MS);
}
prune();
setInterval(prune, DAY_MS).unref();

server.listen(PORT, () => console.log(`CV Tree server on http://localhost:${PORT}  (dashboard /admin · privacy /privacy · free AI ${hosted.enabled ? `on: ${hosted.model}, ${hosted.limit}/day per user, $${hosted.budget}/day cap` : "off: set OPENROUTER_API_KEY"})`));
