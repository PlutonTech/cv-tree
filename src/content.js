// The floating widget. Runs on every page but only shows itself on job postings
// (or LinkedIn profiles, for importing), unless you click the toolbar button.
import { detectJob, isLinkedInProfile, linkedInPageText } from "./lib/jobs.js";
import { load, save, upsertCv, uid, onChange, logActivity, hasAIKey } from "./lib/store.js";
import { svg } from "./lib/icons.js";
import { localRank, md, esc, slug } from "./lib/match.js";
import { renderHtml, parseCv, TEMPLATES } from "./lib/cvhtml.js";
import TPL_CSS from "../extension/templates.css";
import { runAI } from "./lib/ai-port.js";
import { track } from "./lib/analytics.js";


function main() {
  const S = {
    data: null, job: null, mode: null, forced: false, open: false, visible: false,
    rank: null,          // {kind: "keyword"|"claude", list, role, company, mustHaves, recommendation, advice}
    ranking: false,      // AI rank in progress
    gen: null,           // {text, running, base, savedId, note, error}
    li: null,            // {running, result, saved, error}
    ctl: null, lastUrl: "", tries: 0, flash: "",
    tab: null,           // "job" | "match" | "cvs"
    preview: null,       // id of the CV shown large in My CVs
    pasted: "",          // text typed into Match a job
  };
  const fileCache = new Map();   // CV PDFs, built once per CV version
  const readyFiles = new Map();  // cv id -> File, so a drag can start synchronously

  /* ---------- shadow-DOM host: page styles can't leak in, ours can't leak out ---------- */
  const host = document.createElement("cv-tree-widget");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;right:0;bottom:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}${TPL_CSS}</style><div class="wrap" hidden>
      <section class="panel" role="dialog" aria-label="CV Tree" hidden></section>
      <button class="fab" type="button" aria-expanded="false">${ICON}<span class="badge" hidden></span></button>
    </div>`;
  const $ = s => root.querySelector(s);
  const wrap = $(".wrap"), panel = $(".panel"), fab = $(".fab"), badge = $(".badge");
  document.documentElement.append(host);

  fab.addEventListener("click", () => setOpen(!S.open));
  root.addEventListener("keydown", e => { if (e.key === "Escape" && S.open) { setOpen(false); fab.focus(); } });
  panel.addEventListener("click", onPanelClick);
  panel.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".cvcard")) { e.preventDefault(); e.target.click(); }
  });
  // CVs can be dragged onto a site's upload box: build the PDF as soon as the pointer is over a card.
  ["pointerover", "focusin"].forEach(t => panel.addEventListener(t, e => {
    const el = e.target.closest("[draggable=true][data-id]");
    const cv = el && S.data.cvs.find(c => c.id === el.dataset.id);
    if (cv) cvFile(cv).catch(() => {});
  }));
  panel.addEventListener("dragstart", e => {
    const el = e.target.closest("[draggable=true][data-id]"); if (!el) return;
    const cv = S.data.cvs.find(c => c.id === el.dataset.id); if (!cv) return;
    const file = readyFiles.get(cv.id);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", cv.body);
    track("cv_drag", { ready: !!file, host: location.hostname.replace(/^www\./, "") });
    if (file) { try { e.dataTransfer.items.add(file); } catch {} }
    else { S.flash = "Getting the PDF ready. Drag again in a moment."; refresh(); }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== "toggle") return;
    if (S.visible && S.open) { setOpen(false); return; }
    S.forced = true;
    scan(true);
    show(true);
    setOpen(true);
  });

  onChange(async changes => {
    if (!("cvs" in changes || "settings" in changes || "profile" in changes)) return;
    S.data = await load();
    if ("cvs" in changes && S.job && S.rank?.kind !== "claude") S.rank = keywordRank();
    refresh();
  });

  (async () => {
    S.data = await load();
    scan(false);
    // Single-page sites (LinkedIn, Indeed) swap postings without reloading: re-check when the URL changes.
    setInterval(() => {
      if (location.href !== S.lastUrl) { S.tries = 0; scan(false); }
      else if (!S.job && S.tries < 8) { S.tries++; scan(false); }
    }, 1500);
  })();

  /* ---------- detection ---------- */
  function scan(force) {
    const urlChanged = location.href !== S.lastUrl;
    S.lastUrl = location.href;
    const job = detectJob();
    if (urlChanged && S.gen?.running) S.ctl?.abort();
    if (job) {
      const same = S.job && S.job.url === job.url && S.job.title === job.title;
      S.job = job; S.mode = "job";
      if (!same) {
        S.rank = keywordRank(); S.gen = null;
        track("job_detected", { host: job.host, source: job.source, cvs: S.data?.cvs.length || 0, top: S.rank?.list?.[0]?.score || 0 });
      }
    } else if (isLinkedInProfile()) {
      S.job = null; S.mode = "linkedin";
    } else {
      S.job = null; S.mode = force || S.forced ? "idle" : null;
    }
    const hidden = S.data?.settings.hiddenSites.includes(location.hostname.replace(/^www\./, ""));
    const auto = S.data?.settings.showOnJobPages !== false && !hidden;
    if (S.mode === "job" && (auto || S.forced)) show(true);
    else if (S.mode === "linkedin" && (auto || S.forced)) { show(true); maybeAutoImport(); }
    else if (!S.forced) show(false);
    refresh();
  }

  async function maybeAutoImport() {
    const { liImportPending } = await chrome.storage.local.get("liImportPending");
    if (liImportPending && Date.now() - liImportPending < 15 * 60e3) {
      await chrome.storage.local.remove("liImportPending");
      setOpen(true);
    }
  }

  function keywordRank() {
    if (!S.job || !S.data?.cvs.length) return null;
    return { kind: "keyword", list: localRank(S.job.description, S.data.cvs).slice(0, 3) };
  }

  /* ---------- show / open ---------- */
  function show(on) {
    S.visible = on;
    wrap.hidden = !on;
    if (!on) setOpen(false);
  }
  function setOpen(on) {
    S.open = on;
    panel.hidden = !on;
    fab.setAttribute("aria-expanded", String(on));
    fab.classList.toggle("on", on);
    if (on) {
      refresh();
      panel.querySelector("button")?.focus({ preventScroll: true, focusVisible: false });
      track("widget_open", { page: S.mode || "none", host: S.mode === "job" ? S.job?.host || "" : "" });
    }
    else if (S.forced && S.mode !== "job" && S.mode !== "linkedin") { S.forced = false; show(false); }
  }

  function refresh() {
    wrap.classList.toggle("dark", S.data?.settings.theme === "dark");
    const top = S.rank?.list?.[0];
    badge.hidden = !(S.mode === "job" && top);
    if (top) { badge.textContent = top.score; badge.className = "badge " + tier(top.score); }
    fab.setAttribute("aria-label", S.mode === "job" && top ? `CV Tree: best CV matches ${top.score} out of 100` : "CV Tree");
    fab.title = S.mode === "job" ? "CV Tree found a job posting" : S.mode === "linkedin" ? "Import this LinkedIn profile into CV Tree" : "CV Tree";
    if (S.open) renderPanel();
  }

  /* ---------- panel ---------- */
  function renderPanel() {
    const d = S.data, st = d.settings, needsKey = !hasAIKey(st);
    const onPage = S.mode === "job" || S.mode === "linkedin";
    if (!S.tab || (S.tab === "job" && !onPage)) S.tab = onPage ? "job" : "cvs";
    const tabs = [...(onPage ? [["job", S.mode === "linkedin" ? "LinkedIn" : S.job?.source === "pasted" ? "Pasted job" : "This job"]] : []),
      ["match", "Match a job"], ["cvs", `My CVs (${d.cvs.length})`]];
    let body;
    if (S.tab === "job") body = S.mode === "job" ? jobView(d, needsKey) : linkedinView(needsKey);
    else if (S.tab === "match") body = matchView();
    else body = S.preview && d.cvs.some(c => c.id === S.preview) ? previewView(d) : cvsView(d);
    panel.classList.toggle("wide", S.tab === "cvs");

    const scroll = panel.querySelector(".body")?.scrollTop || 0;
    panel.innerHTML = `
      <header><div class="brand">${ICON}<b>CV Tree</b></div>
        <div class="row tight">
          <button class="icon" data-act="app" data-hash="${S.mode === "linkedin" ? "profile" : "match"}" type="button" title="Open the full app">${EXPAND}<span>Full app</span></button>
          <button class="icon" data-act="close" type="button" title="Close (Esc)" aria-label="Close">${CLOSE}</button>
        </div></header>
      <nav class="tabs" role="tablist" aria-label="CV Tree">${tabs.map(([id, label]) => `<button role="tab" data-act="tab" data-tab="${id}" aria-selected="${S.tab === id}" type="button">${esc(label)}</button>`).join("")}</nav>
      <div class="body">
        ${needsKey ? `<div class="notice">Add a free OpenRouter key to rank your CVs with AI and write new ones. <button class="link" data-act="app" data-hash="settings" type="button">Open settings</button></div>` : ""}
        ${body}
        ${S.flash ? `<p class="flash">${esc(S.flash)}</p>` : ""}
      </div>
      <footer>
        ${S.mode ? `<button class="link" data-act="hide" type="button">Don't show on ${esc(location.hostname.replace(/^www\./, ""))}</button>` : "<span></span>"}
        <button class="link" data-act="app" data-hash="dashboard" type="button">Open the full app</button>
      </footer>`;
    const b = panel.querySelector(".body"); if (b) b.scrollTop = scroll;
  }

  function jobView(d, needsKey) {
    const j = S.job, r = S.rank;
    const rows = !d.cvs.length
      ? `<p class="muted">You haven't saved any CVs yet. Add them in the full app, or write one for this job now.</p>
         <div class="row"><button class="btn" data-act="app" data-hash="cvs" type="button">Add my CVs</button></div>`
      : (r?.list || []).map((x, i) => {
          const cv = d.cvs.find(c => c.id === x.id); if (!cv) return "";
          return `<div class="hit${i === 0 ? " top" : ""}">
            <div class="score ${tier(x.score)}">${x.score}</div>
            <div class="grow">
              <div class="t">${esc(cv.title)}</div>
              <div class="why">${esc((x.fits || []).join(" · "))}</div>
              ${x.gaps?.length ? `<div class="chips">${x.gaps.map(g => `<span class="chip gap">${esc(g)}</span>`).join("")}</div>` : ""}
              <div class="row tight"><button class="mini" data-act="copyCv" data-id="${esc(cv.id)}" type="button">Copy</button><button class="mini" data-act="preview" data-id="${esc(cv.id)}" type="button">View</button><button class="mini" data-act="dlCv" data-id="${esc(cv.id)}" type="button">PDF</button><button class="mini" data-act="attach" data-id="${esc(cv.id)}" type="button">Attach</button>${needsKey ? "" : `<button class="mini" data-act="tailor" data-id="${esc(cv.id)}" type="button">Tailor</button>`}</div>
            </div></div>`;
        }).join("");
    const verdict = r?.kind === "claude" && r.advice ? `<div class="verdict"><b>${esc({ send: "Send it as is.", tailor: "Tailor it first.", generate: "Write a new one." }[r.recommendation] || "")}</b> ${esc(r.advice)}</div>` : "";
    const g = S.gen;
    return `
      <div class="block job">
        <div class="eyebrow">${j.source === "pasted" ? "Pasted job description" : `Job on ${esc(j.host)}`}</div>
        <div class="title">${esc(r?.role || j.title)}</div>
        ${(r?.company || j.company) ? `<div class="muted">${esc(r?.company || j.company)}</div>` : ""}
        ${r?.mustHaves?.length ? `<div class="chips">${r.mustHaves.map(m => `<span class="chip">${esc(m)}</span>`).join("")}</div>` : ""}
      </div>
      ${d.cvs.length ? `<div class="block">
        <div class="row between"><div class="eyebrow">Your best CVs</div><span class="tag">${r?.kind === "claude" ? "Ranked by AI" : "Keyword match"}</span></div>
        ${verdict}
        <div class="hits">${rows}</div>
        ${r?.kind !== "claude" && !needsKey ? `<button class="btn wide" data-act="rank" type="button" ${S.ranking ? "disabled" : ""}>${S.ranking ? `<span class="spin"></span> Reading your CVs…` : "Rank with AI for a real score"}</button>` : ""}
      </div>` : `<div class="block">${rows}</div>`}
      ${needsKey ? "" : `<div class="block">
        <div class="eyebrow">Write a CV for this job</div>
        <div class="row">
          ${d.cvs.length ? `<button class="btn primary" data-act="tailor" data-id="${esc(r?.list?.[0]?.id || "")}" type="button" ${g?.running ? "disabled" : ""}>Tailor best CV</button>` : ""}
          <button class="btn ${d.cvs.length ? "" : "primary"}" data-act="generate" type="button" ${g?.running ? "disabled" : ""}>Write a new CV</button>
          <button class="btn" data-act="letter" type="button" title="Opens in the full app">Cover letter</button>
        </div>
        ${g ? genView(g) : ""}
      </div>`}`;
  }

  function genView(g) {
    return `<div class="gen">
      <div class="muted small">${g.running ? `<span class="spin"></span> ${g.text ? "Writing" : "Thinking"}${g.base ? ` from “${esc(g.base.title)}”` : ""}…` : esc(g.note || "")}</div>
      ${g.error ? `<p class="err">${esc(g.error)}</p>` : ""}
      ${g.text ? `<article class="doc">${md(g.text)}</article>` : ""}
      <div class="row">
        ${g.running ? `<button class="btn" data-act="stop" type="button">Stop</button>` : g.text ? `
          <button class="btn primary" data-act="saveGen" type="button" ${g.savedId ? "disabled" : ""}>${g.savedId ? "Saved to My CVs" : "Save to My CVs"}</button>
          <button class="btn" data-act="copyGen" type="button">Copy</button>
          <button class="btn" data-act="dlGen" type="button">Download PDF</button>
          <button class="btn" data-act="editGen" type="button">Edit in full app</button>` : ""}
      </div></div>`;
  }

  function matchView() {
    return `<div class="block">
      <div class="eyebrow">Match a job</div>
      <p class="muted small">Paste any job description to see which of your CVs fits it best.</p>
      <textarea id="mjText" rows="8" placeholder="Paste the job description: responsibilities, requirements…" aria-label="Job description">${esc(S.pasted)}</textarea>
      <div class="row">
        <button class="btn primary" data-act="matchPaste" type="button">Find my best CV</button>
        ${S.mode !== "job" ? `<button class="btn" data-act="useAnyway" type="button">Use this page's text</button>` : ""}
        <button class="btn" data-act="openMatch" type="button">Open in full app</button>
      </div></div>`;
  }

  const tplOf = cv => cv.template || S.data.settings.cvTemplate || "modern";

  function cvsView(d) {
    if (!d.cvs.length) return `<div class="block"><p class="muted">No CVs yet. Add your CVs in the full app (you can upload PDF or Word files), then they'll show up here.</p>
      <div class="row"><button class="btn primary" data-act="app" data-hash="cvs" type="button">Add my CVs</button></div></div>`;
    const cvs = [...d.cvs].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return `<div class="block">
      <div class="row between"><div class="eyebrow">My CVs</div><span class="tag">Click to view · drag onto an upload box</span></div>
      <div class="cvgrid">${cvs.map(cv => `<div class="cvcard" role="button" tabindex="0" draggable="true" data-act="preview" data-id="${esc(cv.id)}" aria-label="View ${esc(cv.title)}">
        <span class="thumb" aria-hidden="true"><span class="paper">${renderHtml(cv.body, tplOf(cv))}</span></span>
        <b>${esc(cv.title)}</b><small>${esc(cv.roles || (cv.file ? cv.file.kind.toUpperCase() + " upload" : "No tags"))}</small>
      </div>`).join("")}</div></div>`;
  }

  function previewView(d) {
    const cv = d.cvs.find(c => c.id === S.preview), tpl = tplOf(cv);
    return `<div class="block">
      <div class="row between"><button class="link" data-act="back" type="button">‹ All CVs</button><span class="tag">${esc(TEMPLATES.find(t => t.id === tpl)?.name || "")} template</span></div>
      <div class="title">${esc(cv.title)}</div>
      <div class="row">
        <button class="btn primary" data-act="attach" data-id="${esc(cv.id)}" type="button">Attach to this page</button>
        <button class="btn" data-act="dlCv" data-id="${esc(cv.id)}" type="button">Download PDF</button>
        <button class="btn" data-act="copyCv" data-id="${esc(cv.id)}" type="button">Copy text</button>
        <button class="btn" data-act="openCv" data-id="${esc(cv.id)}" type="button">Open in app</button>
      </div>
      <div class="big" draggable="true" data-id="${esc(cv.id)}" tabindex="0" aria-label="CV preview. Drag onto an upload box to attach it."><div class="paper">${renderHtml(cv.body, tpl)}</div></div>
      <p class="muted small">${cv.file?.dataUrl ? `Attaching uses your original file, ${esc(cv.file.name)}.` : "Attaching creates a PDF in this template."} You can also drag the CV onto the application's upload box.</p>
    </div>`;
  }

  function linkedinView(needsKey) {
    const li = S.li;
    if (li?.result) {
      const x = li.result, roles = (x.experience.match(/^\S.*\(.*\)\s*$/gm) || []).length;
      return `<div class="block"><div class="eyebrow">Found on this profile</div>
        <div class="title">${esc(x.name || "Your profile")}</div><div class="muted">${esc(x.headline)}</div>
        <p class="small">${roles ? roles + " roles, " : ""}${x.skills.length} skills${x.education ? ", education" : ""}.</p>
        <div class="chips">${x.skills.slice(0, 14).map(s => `<span class="chip">${esc(s)}</span>`).join("")}</div>
        <div class="row"><button class="btn primary" data-act="liSave" type="button" ${li.saved ? "disabled" : ""}>${li.saved ? "Saved to your profile" : "Save to my profile"}</button>
        <button class="btn" data-act="app" data-hash="profile" type="button">Review in full app</button></div></div>`;
    }
    return `<div class="block"><div class="eyebrow">LinkedIn</div>
      <div class="title">Import this profile</div>
      <p class="muted">CV Tree reads the roles, skills and education on this page and adds them to your profile. To get every role, open “Show all experiences” first and import from that page too.</p>
      ${li?.error ? `<p class="err">${esc(li.error)}</p>` : ""}
      ${needsKey ? "" : `<button class="btn primary wide" data-act="liImport" type="button" ${li?.running ? "disabled" : ""}>${li?.running ? `<span class="spin"></span> Reading the profile…` : "Import this profile"}</button>`}
    </div>`;
  }

  /* ---------- actions ---------- */
  async function onPanelClick(e) {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, d = S.data;
    const cv = b.dataset.id ? d.cvs.find(c => c.id === b.dataset.id) : null;
    S.flash = "";
    switch (act) {
      case "close": setOpen(false); fab.focus(); break;
      case "tab": S.tab = b.dataset.tab; if (S.tab !== "cvs") S.preview = null; track("widget_tab", { tab: S.tab }); break;
      case "preview": S.tab = "cvs"; S.preview = cv.id; break;
      case "back": S.preview = null; break;
      case "matchPaste": {
        const text = (panel.querySelector("#mjText")?.value || "").trim();
        S.pasted = text;
        if (text.length < 80) { S.flash = "Paste the full job description first (a few lines at least)."; break; }
        const first = text.split("\n").find(l => l.trim()) || "Pasted job";
        S.job = { title: first.trim().slice(0, 120), company: "", description: text.slice(0, 20000), url: location.href, host: "pasted text", source: "pasted" };
        S.mode = "job"; S.rank = keywordRank(); S.gen = null; S.tab = "job";
        track("match_paste", { cvs: d.cvs.length, top: S.rank?.list?.[0]?.score || 0 });
        break;
      }
      case "openMatch": {
        const text = (panel.querySelector("#mjText")?.value || "").trim();
        const job = text.length >= 80 ? { title: text.split("\n")[0].slice(0, 120), company: "", description: text, url: "", host: "the CV Tree menu" } : S.job;
        if (job) await save({ currentJob: { ...job, at: Date.now() } });
        chrome.runtime.sendMessage({ type: "openApp", hash: "match" });
        break;
      }
      case "attach": await attach(cv); break;
      case "openCv": chrome.runtime.sendMessage({ type: "openApp", hash: "cv-" + cv.id }); break;
      case "app":
        if (S.job) await save({ currentJob: { ...S.job, at: Date.now() } });
        chrome.runtime.sendMessage({ type: "openApp", hash: b.dataset.hash });
        break;
      case "hide": {
        const h = location.hostname.replace(/^www\./, "");
        await save({ settings: { ...d.settings, hiddenSites: [...new Set([...d.settings.hiddenSites, h])] } });
        track("widget_hidden_site", { host: h });
        S.forced = false; show(false);
        break;
      }
      case "useAnyway": {
        const main = document.querySelector("main") || document.body;
        S.job = { title: document.querySelector("h1")?.innerText?.trim() || document.title, company: "", description: (main.innerText || "").slice(0, 20000),
          url: location.href, host: location.hostname.replace(/^www\./, ""), source: "page text" };
        S.mode = "job"; S.rank = keywordRank(); S.gen = null; S.tab = "job";
        break;
      }
      case "rank": return rankWithAI();
      case "tailor": return generate(cv || d.cvs.find(c => c.id === S.rank?.list?.[0]?.id) || null);
      case "generate": return generate(null);
      case "stop": S.ctl?.abort(); break;
      case "copyCv": return copy(cv.body, b);
      case "dlCv": await downloadCv(cv); break;
      case "copyGen": return copy(S.gen.text, b);
      case "dlGen": {
        const id = S.gen.savedId || (await saveGen());
        const saved = id && (await load()).cvs.find(c => c.id === id);
        if (saved) await downloadCv(saved);
        break;
      }
      case "saveGen": return saveGen();
      case "editGen": {
        const id = S.gen.savedId || (await saveGen());
        if (id) chrome.runtime.sendMessage({ type: "openApp", hash: "cv-" + id });
        break;
      }
      case "letter":
        track("letter_start", { from: "widget" });
        await save({ currentJob: { ...S.job, at: Date.now() } });
        chrome.runtime.sendMessage({ type: "openApp", hash: "letter-new" });
        break;
      case "liImport": return importLinkedIn();
      case "liSave": return saveLinkedIn();
    }
    refresh();
  }

  async function rankWithAI() {
    S.ranking = true; refresh();
    try {
      const res = await runAI("rank", { job: S.job });
      S.rank = { kind: "claude", ...res, list: res.ranking.slice(0, 3) };
      const top = S.data.cvs.find(c => c.id === res.ranking[0]?.id);
      if (top) await upsertCv({ ...top, matchedCount: (top.matchedCount || 0) + 1 });
      logActivity(`Matched ${res.role || S.job.title}${res.company ? " at " + res.company : ""}: best CV scored ${res.ranking[0]?.score ?? "–"}`, "match");
    } catch (err) { S.flash = err.message; }
    S.ranking = false; refresh();
  }

  async function generate(base) {
    S.ctl?.abort();
    const ctl = S.ctl = new AbortController();
    S.gen = { text: "", running: true, base };
    refresh();
    try {
      const { text, truncated } = await runAI("generate", { job: S.job, baseId: base?.id }, {
        signal: ctl.signal,
        onText: t => { if (S.ctl === ctl) { S.gen.text = t; refresh(); } },
      });
      if (S.ctl !== ctl) return;
      S.gen = { ...S.gen, text, running: false, note: truncated ? "The CV was cut short. Try again or trim your profile." : "Draft ready. Fill the highlighted [gaps] before you send it." };
    } catch (err) {
      if (S.ctl !== ctl) return;
      S.gen = { ...S.gen, text: err.text || S.gen.text, running: false, note: "", error: err.code === "cancelled" ? "" : err.message };
      if (err.code === "cancelled") S.gen.note = "Stopped.";
    }
    refresh();
  }

  function cvTitle() {
    const role = S.rank?.role || S.job?.title || "CV", co = S.rank?.company || S.job?.company;
    return co ? `${role} – ${co}` : role;
  }

  async function saveGen() {
    if (!S.gen?.text) return null;
    const id = uid("cv");
    await upsertCv({ id, kind: "cv", title: cvTitle(), roles: S.rank?.role || S.job.title, link: "", body: S.gen.text,
      notes: "Made for " + S.job.url, jobLink: S.job.url, updated: Date.now(), matchedCount: 0 });
    S.gen.savedId = id; S.flash = "Saved to My CVs.";
    track("cv_added", { source: "generated", from: "widget" });
    logActivity(`Saved “${cvTitle()}” from ${S.job.host}`, "save");
    refresh();
    return id;
  }

  async function importLinkedIn() {
    S.li = { running: true }; refresh();
    try {
      const result = await runAI("linkedin", { pageText: linkedInPageText() });
      S.li = { result };
    } catch (err) { S.li = { error: err.message }; }
    refresh();
  }

  async function saveLinkedIn() {
    const x = S.li.result, { profile } = await load();
    const skills = [...new Set([...profile.skills.split(",").map(s => s.trim()).filter(Boolean), ...x.skills])].join(", ");
    const isDetails = /\/details\//.test(location.pathname);
    await save({ profile: {
      ...profile,
      name: profile.name || x.name,
      headline: profile.headline || x.headline,
      skills,
      experience: x.experience && (!profile.experience || isDetails || x.experience.length > profile.experience.length) ? x.experience : profile.experience,
      education: profile.education || x.education,
      liUrl: profile.liUrl || location.origin + location.pathname.replace(/\/details\/.*$/, "/"),
      liText: linkedInPageText().slice(0, 20000),
    } });
    S.li.saved = true; S.flash = "Profile updated. Review it in the full app.";
    track("linkedin_saved", { skills: x.skills.length });
    refresh();
  }

  /* ---------- CV files: attach, drag, download ---------- */
  function cvFile(cv) {
    const tpl = tplOf(cv), key = `${cv.id}:${tpl}:${cv.updated || 0}`;
    if (!fileCache.has(key)) fileCache.set(key, (async () => {
      if (cv.file?.dataUrl) return new File([dataUrlToBlob(cv.file.dataUrl)], cv.file.name, { type: cv.file.dataUrl.slice(5, cv.file.dataUrl.indexOf(";")) });
      // The PDF library loads only now, not on every page.
      const { cvPdfBlob } = await import(chrome.runtime.getURL("pdfgen.js"));
      const person = parseCv(cv.body).name;
      return new File([cvPdfBlob(cv.body, tpl)], `${slug(person ? person + " " + cv.title : cv.title)}.pdf`, { type: "application/pdf" });
    })());
    return fileCache.get(key).then(f => { readyFiles.set(cv.id, f); return f; });
  }

  // Fill the page's CV upload field. Prefers a field labelled resume/CV over one for a cover letter.
  async function attach(cv) {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter(i => !i.disabled);
    if (!inputs.length) {
      S.flash = "No upload field on this page yet. Open the application form, or drag the CV onto its upload box.";
      track("cv_attach", { ok: false, reason: "no_field", host: location.hostname.replace(/^www\./, "") });
      return;
    }
    const context = i => `${i.name} ${i.id} ${i.getAttribute("aria-label") || ""} ${(i.closest("label, fieldset, [class*=field], [class*=upload], div")?.innerText || "").slice(0, 300)}`.toLowerCase();
    const score = i => (/resume|résumé|\bcv\b|curriculum/.test(context(i)) ? 3 : 0) - (/cover/.test(context(i)) ? 2 : 0) + (/pdf|\.doc/.test(i.accept || "") ? 1 : 0);
    const input = inputs.sort((a, b) => score(b) - score(a))[0];
    try {
      const file = await cvFile(cv);
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      S.flash = `Attached ${file.name}. Check the form shows it before you submit.`;
      track("cv_attach", { ok: true, original: !!cv.file?.dataUrl, host: location.hostname.replace(/^www\./, "") });
      logActivity(`Attached “${cv.title}” on ${location.hostname.replace(/^www\./, "")}`, "save");
    } catch { S.flash = "Couldn't attach the file here. Download the PDF and upload it instead."; track("cv_attach", { ok: false, host: location.hostname.replace(/^www\./, "") }); }
  }

  async function downloadCv(cv) {
    try {
      const file = await cvFile(cv);
      const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
      const res = await chrome.runtime.sendMessage({ type: "downloadUrl", url, filename: file.name });
      S.flash = res?.ok ? "Saved to your downloads." : "";
      if (res?.ok) track("pdf_download", { kind: "cv", template: tplOf(cv), from: "widget", original: !!cv.file?.dataUrl });
    } catch { S.flash = "Couldn't build the PDF. Open the CV in the full app and download it there."; }
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; root.append(ta); ta.select();
      try { document.execCommand("copy"); } catch {} ta.remove();
    }
    S.flash = "Copied."; refresh();
  }

}

function dataUrlToBlob(url) {
  const [head, data] = url.split(",");
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  return new Blob([bytes], { type: head.slice(5, head.indexOf(";")) });
}

const tier = s => s >= 80 ? "good" : s >= 55 ? "ok" : "low";

const ICON = svg("logo");
const EXPAND = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const CLOSE = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

const CSS = `
:host{all:initial}
.wrap{--bg:#FFFFFF;--sub:#F6F8F7;--ink:#10231C;--muted:#6B7A74;--line:#E4EAE7;--accent:#0E7A55;--accent-ink:#FFFFFF;--soft:#E8F4EE;--mark:#F3D35C;--mark-ink:#3A3000;--good:#2E7D4F;--ok:#A26A00;--low:#B23B3B;color-scheme:light;
  position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;align-items:flex-end;gap:12px;
  font:14px/1.45 "Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
/* Light by default; dark only when chosen in Settings › Appearance. */
.wrap.dark{--bg:#131C19;--sub:#17221E;--ink:#E6EEEA;--muted:#8FA19A;--line:#24322D;--accent:#3DBE8B;--accent-ink:#06140F;--soft:#163027;--mark:#E7C548;--good:#5CC48A;--ok:#E0A63A;--low:#E77272;color-scheme:dark}
[hidden]{display:none!important}
*{box-sizing:border-box}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fab{position:relative;width:56px;height:56px;border-radius:18px;border:none;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;
  box-shadow:0 6px 20px -6px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.06);transition:transform .15s,border-radius .2s}
.fab:hover{transform:translateY(-2px)}
.fab.on{border-radius:50%}
.fab svg{width:30px;height:30px}
.brand svg{width:22px;height:22px}
.badge{position:absolute;top:-6px;left:-8px;min-width:26px;height:22px;padding:0 6px;border-radius:11px;font:700 12px/22px system-ui,sans-serif;text-align:center;
  font-variant-numeric:tabular-nums;color:#fff;box-shadow:0 0 0 2px var(--bg)}
.badge,.badge.good,.badge.ok,.badge.low{background:#D92D20;color:#fff}
.panel{width:min(380px,calc(100vw - 40px));max-height:min(640px,calc(100vh - 110px));display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);
  border-radius:16px;box-shadow:0 18px 50px -12px rgba(0,0,0,.4);overflow:hidden;transform-origin:bottom right}
@media (prefers-reduced-motion:no-preference){.panel{animation:pop .16s ease-out}.wrap{animation:rise .25s ease-out}}
@keyframes pop{from{opacity:0;transform:scale(.96) translateY(6px)}}
@keyframes rise{from{opacity:0;transform:translateY(12px)}}
.panel>header{display:flex;justify-content:space-between;align-items:center;padding:10px 10px 10px 14px}
.brand{display:flex;align-items:center;gap:8px;color:var(--accent)}.brand b{color:var(--ink);font-size:15px}
.body{overflow:auto;padding:4px 14px 10px;display:grid;gap:4px}
.panel>footer{display:flex;justify-content:space-between;gap:8px;padding:8px 14px;border-top:1px solid var(--line);background:var(--sub)}
.panel.wide{width:min(470px,calc(100vw - 40px))}
.tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);overflow-x:auto}
.tabs button{border:none;background:none;padding:8px 10px;font-size:13px;font-weight:700;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs button:hover{color:var(--ink)}
.tabs button[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent)}
textarea{width:100%;font:13px/1.5 inherit;font-family:inherit;color:var(--ink);background:var(--sub);border:1px solid var(--line);border-radius:10px;padding:9px 11px;resize:vertical}
textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.cvgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.cvcard{display:grid;gap:3px;padding:8px;border:1px solid var(--line);border-radius:12px;background:var(--bg);cursor:grab;min-width:0}
.cvcard:hover{border-color:var(--accent)}
.cvcard:active{cursor:grabbing}
.cvcard:focus-visible,.big:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cvcard b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px}
.cvcard small{font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thumb{display:block;height:190px;overflow:hidden;border-radius:6px;border:1px solid var(--line);background:#fff;pointer-events:none}
.paper{display:block;width:794px;background:#fff;zoom:.25}
.big{max-height:min(380px,45vh);overflow:auto;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:grab}
.big .paper{zoom:.55}
.block{padding:10px 0;border-bottom:1px solid var(--line);display:grid;gap:8px}
.block:last-of-type{border-bottom:none}
.eyebrow{font:600 11px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.title{font-weight:700;font-size:16px;line-height:1.25}
.muted{color:var(--muted);margin:0}.small{font-size:12.5px;margin:0}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.row.tight{gap:2px}.between{justify-content:space-between}
.grow{min-width:0;flex:1;display:grid;gap:3px}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.btn{border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:8px 12px;font-weight:700;font-size:13px;display:inline-flex;align-items:center;gap:6px}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.wide{width:100%;justify-content:center}
.btn[disabled]{opacity:.6;cursor:default}
.icon{border:none;background:transparent;border-radius:8px;padding:6px 8px;display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:12.5px;font-weight:600}
.icon:hover{background:var(--sub);color:var(--ink)}
.link{border:none;background:none;padding:0;color:var(--accent);font-size:12.5px;font-weight:600}
.link:hover{text-decoration:underline}
.mini{border:none;background:none;padding:2px 6px 2px 0;font-size:12px;font-weight:600;color:var(--accent)}
.mini:hover{text-decoration:underline}
.hits{display:grid;gap:6px}
.hit{display:flex;gap:10px;padding:9px;border:1px solid var(--line);border-radius:10px}
.hit.top{border-color:var(--accent);background:var(--soft)}
.score{flex:none;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:16px;font-variant-numeric:tabular-nums;background:var(--sub)}
.score.good{color:var(--good)}.score.ok{color:var(--ok)}.score.low{color:var(--low)}
.t{font-weight:600;overflow-wrap:anywhere}.why{font-size:12.5px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{font-size:11.5px;padding:1px 7px;border-radius:999px;background:var(--soft)}
.chip.gap{background:transparent;border:1px dashed var(--ok);color:var(--ok)}
.verdict{background:var(--soft);border-radius:8px;padding:8px 10px;font-size:13px}
.notice{margin-top:8px;background:var(--mark);color:var(--mark-ink);border-radius:8px;padding:8px 10px;font-size:13px}
.notice .link{color:var(--mark-ink);text-decoration:underline}
.gen{display:grid;gap:8px}
.doc{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:10px 12px;background:var(--sub);font-size:12.5px;overflow-wrap:anywhere}
.doc h1{font-size:16px;margin:0 0 2px}.doc h2{font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--accent);margin:10px 0 4px}
.doc h3{font-size:13px;margin:6px 0 2px}.doc p{margin:2px 0}.doc ul{margin:2px 0;padding-left:18px}
.todo{background:var(--mark);color:var(--mark-ink);border-radius:3px;padding:0 2px}
.err{color:var(--low);margin:0;font-size:13px}
.flash{margin:6px 0 0;font-size:12.5px;color:var(--good)}
.spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;display:inline-block;vertical-align:-1px}
@media (prefers-reduced-motion:no-preference){.spin{animation:spin .8s linear infinite}}
@keyframes spin{to{transform:rotate(360deg)}}
`;

// Start last, so the constants above are defined before the widget is built.
if (window.top === window && !window.__cvTreeWidget) {
  window.__cvTreeWidget = true;
  main();
}
