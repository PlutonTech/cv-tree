// Free hosted AI: lets people use CV Tree without their own API key. Requests go through this server to OpenRouter
// on the admin's key, with a model the server chooses, a daily allowance per install, a per-IP cap and a global
// daily spending cap. Prompts and answers are streamed straight through and never stored; only token counts and cost are.
//
// Env:
//   OPENROUTER_API_KEY        turns the free AI on. A normal OpenRouter API key (not a management key).
//   HOSTED_MODEL              default anthropic/claude-haiku-5.5 (about $0.001 per CV)
//   HOSTED_DAILY_LIMIT        free requests per install per day, default 30
//   HOSTED_IP_DAILY_LIMIT     requests per IP address per day, default 100
//   HOSTED_DAILY_BUDGET_USD   stop for everyone once today's cost reaches this, default 3
//   OPENROUTER_BASE           default https://openrouter.ai/api/v1 (change only for testing)

const KEY = process.env.OPENROUTER_API_KEY || "";
export const hosted = {
  enabled: !!KEY,
  model: process.env.HOSTED_MODEL || "anthropic/claude-haiku-5.5",
  limit: Number(process.env.HOSTED_DAILY_LIMIT || 30),
  ipLimit: Number(process.env.HOSTED_IP_DAILY_LIMIT || 100),
  budget: Number(process.env.HOSTED_DAILY_BUDGET_USD || 3),
  base: (process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
};

const dayOf = t => new Date(t).toISOString().slice(0, 10);
const perIp = new Map();   // ip -> {day, n}; kept in memory only, never written to disk

export function setupHostedAi(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, install TEXT NOT NULL, status INTEGER NOT NULL,
      ok INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL, ms INTEGER, reason TEXT);
    CREATE INDEX IF NOT EXISTS ai_day ON ai_usage(day, install);`);
  const record = db.prepare("INSERT INTO ai_usage (at, day, install, status, ok, prompt_tokens, completion_tokens, cost, ms, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const usedToday = db.prepare("SELECT COUNT(*) n FROM ai_usage WHERE day = ? AND install = ? AND ok = 1");
  const costToday = db.prepare("SELECT COALESCE(SUM(cost), 0) c FROM ai_usage WHERE day = ?");

  const quota = install => {
    const used = usedToday.get(dayOf(Date.now()), install).n;
    return { enabled: hosted.enabled, model: hosted.model, limit: hosted.limit, used, remaining: Math.max(0, hosted.limit - used) };
  };

  /** Validate, apply limits, forward to OpenRouter and stream the answer back. */
  async function chat(req, res, body, { install, ip, send, cors }) {
    const now = Date.now(), day = dayOf(now);
    const reject = (status, code, message, extra = {}) => {
      record.run(now, day, install, status, 0, 0, 0, 0, 0, code);
      return send(res, status, { error: { code, message, ...extra } }, cors);
    };
    if (!hosted.enabled) return send(res, 503, { error: { code: "disabled", message: "Free AI isn't set up on this server." } }, cors);
    if (usedToday.get(day, install).n >= hosted.limit) return reject(429, "daily_limit", `Today's ${hosted.limit} free AI requests are used up.`, { limit: hosted.limit });
    const ipq = perIp.get(ip);
    const ipUsed = ipq?.day === day ? ipq.n : 0;
    if (ipUsed >= hosted.ipLimit) return reject(429, "ip_limit", "Too many free AI requests from this network today.");
    if (costToday.get(day).c >= hosted.budget) return reject(503, "budget", "The free AI has reached today's limit for everyone.");
    perIp.set(ip, { day, n: ipUsed + 1 });

    // Only what the extension needs; the model and limits are ours, not the caller's.
    const msgs = Array.isArray(body.messages) ? body.messages.slice(0, 4) : [];
    const size = msgs.reduce((n, m) => n + String(m?.content || "").length, 0);
    if (!msgs.length || size > 150000 || msgs.some(m => !["user", "assistant", "system"].includes(m?.role) || typeof m.content !== "string")) {
      return reject(400, "bad_request", "That request isn't one CV Tree makes.");
    }
    const upstreamBody = {
      model: hosted.model, messages: msgs, stream: !!body.stream,
      max_tokens: Math.min(Number(body.max_tokens) || 4000, 12000),
      usage: { include: true },
      ...(body.response_format?.type === "json_schema" ? { response_format: body.response_format } : {}),
    };
    const ctl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
    let upstream;
    try {
      upstream = await fetch(hosted.base + "/chat/completions", {
        method: "POST", signal: ctl.signal,
        headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", "HTTP-Referer": "https://cvtree.app", "X-Title": "CV Tree" },
        body: JSON.stringify(upstreamBody),
      });
    } catch { return reject(502, "upstream", "Couldn't reach the AI service. Try again."); }

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      // Our key or credits are the problem, not the user's request: say so without exposing details.
      const ours = [401, 402, 403].includes(upstream.status);
      record.run(now, day, install, upstream.status, 0, 0, 0, 0, Date.now() - now, ours ? "upstream_account" : "upstream_" + upstream.status);
      if (ours) console.error("Hosted AI: OpenRouter refused our key:", upstream.status, err?.error?.message);
      return send(res, ours ? 503 : upstream.status, { error: { code: ours ? "busy" : "upstream", message: ours ? "The free AI is unavailable right now." : (err?.error?.message || "The AI service returned an error.") } }, cors);
    }

    let usage = null;
    if (!upstreamBody.stream) {
      const data = await upstream.json();
      usage = data.usage;
      record.run(now, day, install, 200, 1, usage?.prompt_tokens || 0, usage?.completion_tokens || 0, usage?.cost || 0, Date.now() - now, "");
      delete data.usage;   // the cost is ours to know
      return send(res, 200, data, cors);
    }

    res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    const reader = upstream.body.getReader(), dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line.startsWith("data:") && line.includes('"usage"')) { try { usage = JSON.parse(line.slice(5)).usage || usage; } catch {} }
        }
      }
    } catch { /* the user stopped it, or the connection dropped */ }
    res.end();
    record.run(now, day, install, 200, 1, usage?.prompt_tokens || 0, usage?.completion_tokens || 0, usage?.cost || 0, Date.now() - now, usage ? "" : "no_usage");
  }

  /** Numbers for the admin dashboard. */
  function stats(start, end, daysList) {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const period = one(`SELECT SUM(ok) requests, COUNT(DISTINCT CASE WHEN ok = 1 THEN install END) users, COALESCE(SUM(cost), 0) cost,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) tokens, SUM(reason = 'daily_limit') quotaHits, SUM(ok = 0 AND reason NOT IN ('daily_limit')) failures,
        ROUND(AVG(CASE WHEN ok = 1 THEN ms END)) avgMs FROM ai_usage WHERE day BETWEEN ? AND ?`, start, end);
    const today = one("SELECT SUM(ok) requests, COALESCE(SUM(cost), 0) cost FROM ai_usage WHERE day = ?", dayOf(Date.now()));
    const byDay = Object.fromEntries(db.prepare("SELECT day, SUM(ok) requests, COALESCE(SUM(cost), 0) cost FROM ai_usage WHERE day BETWEEN ? AND ? GROUP BY day").all(start, end).map(r => [r.day, r]));
    const top = db.prepare(`SELECT install, SUM(ok) requests, COALESCE(SUM(cost), 0) cost, SUM(reason = 'daily_limit') quotaHits FROM ai_usage
        WHERE day BETWEEN ? AND ? GROUP BY install ORDER BY cost DESC LIMIT 8`).all(start, end);
    return {
      enabled: hosted.enabled, model: hosted.model, limit: hosted.limit, budget: hosted.budget, ipLimit: hosted.ipLimit,
      period: { ...period, requests: period.requests || 0, quotaHits: period.quotaHits || 0, failures: period.failures || 0 },
      today: { requests: today.requests || 0, cost: today.cost || 0 },
      daily: daysList.map(d => ({ day: d, requests: byDay[d]?.requests || 0, cost: byDay[d]?.cost || 0 })),
      top,
    };
  }

  return { quota, chat, stats };
}
