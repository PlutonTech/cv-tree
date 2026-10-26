// The full app: dashboard, CV library, matching, profile (GitHub + LinkedIn), link hub and settings.
import { load, save, saveSettings, upsertCv, deleteCv, upsertLetter, deleteLetter, onChange, uid, logActivity, hasAIKey, aiProvider } from "./lib/store.js";
import { CONFIG, hostedAIConfigured, privacyUrl } from "./lib/config.js";
import { localRank, splitList, md, esc, slug } from "./lib/match.js";
import { runAI } from "./lib/ai-port.js";
import { track, analyticsConfigured } from "./lib/analytics.js";
import { startDeviceFlow, pollForToken, getUser, listRepos, withReadmes } from "./lib/github.js";
import { icon, hydrateIcons } from "./lib/icons.js";
import { TEMPLATES, renderHtml, renderPdf, isStructured, placeholders, parseCv, contactParts, renderLetterHtml, renderLetterPdf } from "./lib/templates.js";
import { extractText, readAsDataUrl, ACCEPT } from "./lib/files.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const VIEWS = ["welcome", "dashboard", "cvs", "letters", "match", "doc", "profile", "hub", "settings"];
const SUBS = ["about", "skills", "work", "education", "github", "linkedin"];
const COLORS = ["green", "blue", "purple", "amber"];
const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : "";
const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
const fmtTime = t => t ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : fmtDate(t); };
const firstLine = body => String(body || "").replace(/[#*_>`-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
const initials = name => (String(name || "").trim().split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2) || "CV").toUpperCase();
const colorOf = cv => COLORS[Math.max(0, D.cvs.findIndex(c => c.id === cv.id)) % COLORS.length];
const tier = s => s >= 75 ? "var(--accent)" : s >= 50 ? "var(--amber)" : "var(--red)";

let D = null;              // {cvs, profile, settings, currentJob, activity, activitySeen}
let lastMatch = null, job = null, ctl = null, expanded = null;
let doc = { text: "", cvId: null, editing: false, generating: false, title: "", eyebrow: "", note: "", from: "match" };
let gh = { phase: "idle", flow: null, ctl: null, progress: "", error: "" };
let sub = "about";

/* ---------- boot ---------- */
(async () => {
  hydrateIcons(document);
  D = await load();
  applyTheme();
  fillProfile(); fillSettings(); pickUpJob();
  renderAll();
  route();
  window.addEventListener("hashchange", route);
  onChange(async changes => {
    D = await load();
    if ("settings" in changes) applyTheme();
    if ("profile" in changes && !document.activeElement?.closest?.("[data-pf]")) fillProfile();
    renderAll();
  });
})();

function route() {
  const h = location.hash.slice(1);
  closeMenus();
  $("#side").classList.remove("open"); $("#scrim").hidden = true;
  if (h.startsWith("cv-")) {
    const [cvId, action] = h.slice(3).split("/");
    const cv = D.cvs.find(c => c.id === cvId);
    if (cv) { openSavedDoc(cv); if (action === "pdf") downloadPdf(); return; }
  }
  if (h === "letter-new") { startLetterFromPage(); return; }
  if (h.startsWith("letter-")) {
    const [lId, action] = h.slice(7).split("/");
    const l = D.letters.find(x => x.id === lId);
    if (l) { openLetter(l); if (action === "pdf") downloadPdf(); return; }
  }
  const [view, part] = h.split("/");
  if (view === "profile" && SUBS.includes(part)) sub = part;
  show(VIEWS.includes(view) ? view : "dashboard");
  if (view === "match") pickUpJob();
}
function show(v) {
  track("view", { view: v === "doc" ? (doc.kind === "letter" ? "letter" : "cv") : v });
  for (const x of VIEWS) $("#v-" + x).hidden = x !== v;
  const navKey = v === "doc" ? (["cvs", "letters"].includes(doc.from) ? doc.from : "match") : v;
  $$(".nav a").forEach(a => { if (a.dataset.nav === navKey) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (v === "profile") renderSub();
  if (v === "settings") { loadFreeModels(); loadQuota(); }
  if (v === "welcome") { renderWelcome(); loadWelcomeQuota(); }
  window.scrollTo({ top: 0 });
}

function renderAll() {
  $("#keyBanner").hidden = hasAIKey(D.settings);
  const name = D.profile.name.trim();
  $("#avatarTop").textContent = initials(name);
  $("#acctName").textContent = name || "Your profile";
  renderDashboard(); renderTable(); renderLetters(); renderHub(); renderGitHub(); renderProjects(); renderRecent(); renderSkills(); renderHidden(); renderBell();
  $("#liState").textContent = D.profile.liText ? "Imported" : "Not imported";
  $("#liState").className = "pill" + (D.profile.liText ? " green" : "");
  if (lastMatch) renderMatch();
  if (!$("#v-welcome").hidden) renderWelcome();
}

/* ---------- theme ---------- */
function applyTheme() {
  const t = D.settings.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#btnTheme").innerHTML = icon(dark ? "sun" : "moon");
  $("#btnTheme").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  $$('input[name="theme"]').forEach(r => { r.checked = r.value === t; });
}
$("#btnTheme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  saveSettings({ theme: dark ? "light" : "dark" });
});
$$('input[name="theme"]').forEach(r => r.addEventListener("change", () => saveSettings({ theme: r.value })));

/* ---------- top bar menus ---------- */
function togglePop(btn, pop) {
  const open = pop.hidden;
  closeMenus();
  pop.hidden = !open; btn.setAttribute("aria-expanded", String(open));
}
function closeMenus() {
  ["#bellPop", "#acctPop"].forEach(s => { $(s).hidden = true; });
  $("#btnBell").setAttribute("aria-expanded", "false"); $("#btnAccount").setAttribute("aria-expanded", "false");
  $("#rowMenu").hidden = true;
}
$("#btnBell").addEventListener("click", e => {
  e.stopPropagation(); togglePop(e.currentTarget, $("#bellPop"));
  if (!$("#bellPop").hidden) save({ activitySeen: Date.now() });
});
$("#btnAccount").addEventListener("click", e => { e.stopPropagation(); togglePop(e.currentTarget, $("#acctPop")); });
document.addEventListener("click", e => { if (!e.target.closest(".pop, .menu.floating")) closeMenus(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });
$("#btnMenu").addEventListener("click", () => { $("#side").classList.add("open"); $("#scrim").hidden = false; });
$("#scrim").addEventListener("click", () => { $("#side").classList.remove("open"); $("#scrim").hidden = true; });

function renderBell() {
  const a = D.activity;
  $("#bellDot").hidden = !a.some(x => x.at > D.activitySeen);
  $("#bellPop").innerHTML = `<h4>Recent activity</h4>` + (a.length
    ? a.slice(0, 8).map(x => `<div class="act">${icon(x.kind === "match" ? "search" : x.kind === "import" ? "download" : "check")}<div>${esc(x.text)}<time>${esc(ago(x.at))}</time></div></div>`).join("")
    : `<p class="empty-pop">Nothing yet. Saved CVs, job matches and imports show up here.</p>`);
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  const h = new Date().getHours();
  const first = D.profile.name.trim().split(/\s+/)[0];
  $("#greet").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}${first ? ", " + first : ""}`;
  const cvs = sortedCvs().slice(0, 4);
  const hasExamples = D.cvs.some(c => c.example);
  $("#setupBanner").hidden = !!D.settings.welcomeDone;
  $("#dashCvs").innerHTML = (cvs.length ? cvs.map(cvRow).join("") : `<div class="empty">${icon("file")}<p>No CVs yet. Add the CVs you already have, one per role.</p><button class="btn primary" data-act="new" type="button">${icon("plus")}Add your first CV</button></div>`)
    + (hasExamples ? "" : examplesBanner("Need examples?", "Add 3 example CVs to see how CV Tree works.", "Add 3 example CVs"));
  const links = D.cvs.filter(c => safeUrl(c.link)).length;
  const projects = D.profile.projects.filter(p => p.include !== false).length;
  $("#stats").innerHTML = [["file", D.cvs.length, "Saved CVs"], ["mail", D.letters.length, "Cover letters"], ["link", links, "Public links"], ["briefcase", projects, "Projects"]]
    .map(([i, n, l]) => `<div class="card stat"><span class="ic green">${icon(i)}</span><div><b>${n}</b><span>${l}</span></div></div>`).join("");
}
function examplesBanner(title, text, label) {
  return `<div class="examples">${icon("sparkle")}<div><b>${title}</b><span>${text}</span></div><button class="btn primary" data-act="examples" type="button">${label}</button></div>`;
}
function cvRow(cv) {
  const pub = safeUrl(cv.link);
  return `<div class="cv-row" data-id="${esc(cv.id)}">
    <span class="ic ${colorOf(cv)}">${icon("file")}</span>
    <div class="name"><b>${esc(cv.title)}</b><div class="chips">${splitList(cv.roles).slice(0, 4).map(r => `<span class="chip">${esc(r)}</span>`).join("")}${cv.example ? '<span class="chip ex">Example</span>' : ""}</div></div>
    <span class="vis">${pub ? `<span class="pill green">${icon("link")}Public link</span>` : `<span class="vis">${icon("unlink")}No public link</span>`}</span>
    <span class="when">Updated ${esc(fmtDate(cv.updated))}</span>
    <span class="acts"><button class="iconbtn" data-act="view" type="button" aria-label="View ${esc(cv.title)}">${icon("eye")}</button><button class="iconbtn" data-act="edit" type="button" aria-label="Edit ${esc(cv.title)}">${icon("pencil")}</button><button class="iconbtn" data-act="menu" type="button" aria-label="More actions for ${esc(cv.title)}">${icon("dots")}</button></span>
  </div>`;
}

/* ---------- my cvs ---------- */
const sortedCvs = () => [...D.cvs].sort((a, b) => (b.updated || 0) - (a.updated || 0));
function renderTable() {
  $("#cvExamples").innerHTML = D.cvs.some(c => c.example) ? "" : examplesBanner("Try the examples", "Add 3 example CVs to see how it works, or create your own from scratch.", "Add 3 examples");
  if (!D.cvs.length) {
    $("#cvTable").innerHTML = `<div class="empty">${icon("file")}<p>No CVs yet. Add the CVs you already have, one per role, or open a job posting and let the AI write one.</p><button class="btn primary" data-act="new" type="button">${icon("plus")}Add your first CV</button></div>`;
    return;
  }
  $("#cvTable").innerHTML = `<table><thead><tr><th>Name</th><th>Role / Tags</th><th>Last Updated</th><th>Visibility</th><th><span hidden>Actions</span></th></tr></thead><tbody>
    ${sortedCvs().map(cv => `<tr data-id="${esc(cv.id)}">
      <td><div class="cell-name"><span class="ic solid ${colorOf(cv)}">${icon("file")}</span><div><b>${esc(cv.title)}</b>${cv.example ? '<span class="chip ex">Example</span>' : ""}${cv.file ? `<span class="chip">${esc(cv.file.kind.toUpperCase())}</span>` : ""}</div></div></td>
      <td><div class="chips">${splitList(cv.roles).slice(0, 4).map(r => `<span class="chip">${esc(r)}</span>`).join("") || '<span class="tiny">No tags</span>'}</div></td>
      <td class="when">${esc(fmtDate(cv.updated))}<small>${esc(fmtTime(cv.updated))}</small></td>
      <td>${safeUrl(cv.link) ? `<span class="vis public">${icon("link")}Public</span>` : `<span class="vis">${icon("lock")}Private</span>`}</td>
      <td><button class="iconbtn" data-act="menu" type="button" aria-label="Actions for ${esc(cv.title)}">${icon("dots")}</button></td>
    </tr>`).join("")}</tbody></table>`;
}

// One handler for CV actions anywhere (dashboard rows, table, menus, empty states).
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act;
  const id = b.closest("[data-id]")?.dataset.id || b.dataset.id;
  const cv = D.cvs.find(c => c.id === id);
  if (act === "new") openCv();
  else if (act === "examples") { b.disabled = true; await addExamples(); toast("Added 3 example CVs."); track("cv_added", { source: "example", count: 3 }); }
  else if (act === "view" && cv) { closeMenus(); location.hash = "cv-" + cv.id; }
  else if (act === "edit" && cv) { closeMenus(); openCv(cv); }
  else if (act === "menu" && cv) { e.stopPropagation(); openRowMenu(b, cv); }
  else if (act === "copyLink" && cv) { closeMenus(); safeUrl(cv.link) ? copyText(cv.link, "Link copied.") : openCv(cv); }
  else if (act === "copyText" && cv) { closeMenus(); copyText(cv.body, "CV text copied."); }
  else if (act === "pdf" && cv) { closeMenus(); location.hash = "cv-" + cv.id + "/pdf"; }
  else if (act === "orig" && cv?.file?.dataUrl) { closeMenus(); const a = Object.assign(document.createElement("a"), { href: cv.file.dataUrl, download: cv.file.name }); document.body.append(a); a.click(); a.remove(); }
  else if (act === "del" && cv) { e.stopPropagation(); confirmDelete(cv); }
  else if (act === "delYes" && cv) { closeMenus(); await deleteCv(cv.id); toast(`Deleted “${cv.title}”.`); track("cv_deleted"); }
  else if (act === "delNo") closeMenus();
});

function openRowMenu(btn, cv) {
  const m = $("#rowMenu");
  const wasOpen = !m.hidden && m.dataset.id === cv.id;
  closeMenus();
  if (wasOpen) return;
  m.dataset.id = cv.id;
  m.innerHTML = `<button data-act="view" data-id="${esc(cv.id)}" type="button">${icon("eye")}View</button>
    <button data-act="edit" data-id="${esc(cv.id)}" type="button">${icon("pencil")}Edit</button>
    <button data-act="copyLink" data-id="${esc(cv.id)}" type="button">${icon("link")}${safeUrl(cv.link) ? "Copy link" : "Add a public link"}</button>
    <button data-act="pdf" data-id="${esc(cv.id)}" type="button">${icon("download")}Download PDF</button>
    ${cv.file?.dataUrl ? `<button data-act="orig" data-id="${esc(cv.id)}" type="button">${icon("file")}Download original ${esc(cv.file.kind.toUpperCase())}</button>` : ""}
    <button data-act="copyText" data-id="${esc(cv.id)}" type="button">${icon("copy")}Copy CV text</button>
    <button class="danger" data-act="del" data-id="${esc(cv.id)}" type="button">${icon("trash")}Delete</button>`;
  m.hidden = false;
  const r = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  m.style.top = (r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6) + "px";
}
function confirmDelete(cv) {
  $("#rowMenu").innerHTML = `<div class="confirm-row">Delete “${esc(cv.title)}”? This can't be undone.
    <div class="row"><button class="btn sm" data-act="delNo" type="button">Keep</button><button class="btn sm primary" style="background:var(--red);border-color:var(--red)" data-act="delYes" data-id="${esc(cv.id)}" type="button">Delete</button></div></div>`;
}

let editingId = null, pendingJobLink = "", pendingFile = null;
function openCv(cv, preset) {
  editingId = cv?.id || null;
  pendingFile = null;
  const v = cv || preset || {};
  $("#cvFileNote").className = "note";
  $("#cvFileNote").textContent = v.file ? `Uploaded from ${v.file.name}. Upload a new file to replace the text.` : "";
  $("#dlgTitle").textContent = cv ? "Edit CV" : "Add a CV";
  $("#fTitle").value = v.title || ""; $("#fRoles").value = v.roles || ""; $("#fLink").value = v.link || "";
  $("#fBody").value = v.body || ""; $("#fNotes").value = v.notes || "";
  $("#dlg").showModal();
}
$("#btnNew").addEventListener("click", () => openCv());
$("#cvForm").addEventListener("submit", async e => {
  if (e.submitter?.value !== "save") return;
  const prev = D.cvs.find(c => c.id === editingId) || {};
  const id = editingId || uid("cv");
  const title = $("#fTitle").value.trim();
  await upsertCv({ ...prev, id, kind: "cv", example: false, title, roles: $("#fRoles").value.trim(),
    link: $("#fLink").value.trim(), body: $("#fBody").value, notes: $("#fNotes").value.trim(), updated: Date.now(),
    matchedCount: prev.matchedCount || 0, jobLink: prev.jobLink || pendingJobLink,
    file: pendingFile || prev.file || null, template: prev.template || doc.template || D.settings.cvTemplate || "modern" });
  if (!editingId) logActivity(`Saved “${title}” to My CVs`, "save");
  track(editingId ? "cv_edited" : "cv_added", { source: pendingFile ? pendingFile.kind : !editingId && doc.text && !doc.cvId ? "generated" : "manual", from: "app" });
  if (!editingId && doc.text && !doc.cvId && !pendingFile) { doc.cvId = id; doc.title = title; renderDoc(); }
  pendingJobLink = ""; pendingFile = null;
  toast(`Saved “${title}”.`);
});

/* ---------- document view (generated or saved CV) ---------- */
function openSavedDoc(cv) {
  doc = { kind: "cv", text: cv.body, cvId: cv.id, editing: false, generating: false, title: cv.title, eyebrow: "Saved CV", note: "", from: "cvs",
    template: cv.template || D.settings.cvTemplate || "modern" };
  renderDoc(); show("doc");
}
function renderDoc() {
  $("#docTitle").textContent = doc.title || "CV";
  $("#docEyebrow").textContent = doc.eyebrow;
  const isLetter = doc.kind === "letter";
  $("#docBack").href = "#" + (["cvs", "letters"].includes(doc.from) ? doc.from : "match");
  $("#docBack span").textContent = { cvs: "Back to My CVs", letters: "Back to Cover Letters" }[doc.from] || "Back to Match a Job";
  $("#btnSaveGen").hidden = isLetter || !!doc.cvId || doc.generating || !doc.text;
  $("#btnLetterFromCv").hidden = isLetter || doc.from !== "match" || doc.generating || !doc.text;
  $("#btnDl span").textContent = isLetter ? "Download .txt" : "Download .md";
  renderLetterOpts();
  $("#btnEditDoc span").textContent = doc.editing ? "Done editing" : "Edit";
  ["#btnCopy", "#btnDl", "#btnPdf", "#btnEditDoc"].forEach(s => { $(s).disabled = doc.generating || !doc.text; });
  renderPicker();
  // Files often lose the split between jobs: offer AI formatting until the CV has entries.
  const fromFile = doc.cvId && D.cvs.find(c => c.id === doc.cvId)?.file;
  $("#fmtNotice").hidden = isLetter || doc.generating || doc.editing || !doc.text || (isStructured(doc.text) && (!fromFile || /^###\s/m.test(doc.text)));
  $("#docStatus").innerHTML = doc.generating
    ? `<span class="spin"></span><span>${doc.text ? "Writing" : "Thinking"}…</span><button class="btn sm" id="btnStopDoc" type="button">Stop</button>`
    : doc.note ? `<span>${doc.note}</span>` : "";
  if (doc.editing) {
    if (!$("#docEdit")) {
      $("#docBody").classList.remove("tpl");
      $("#docBody").innerHTML = `<textarea id="docEdit" aria-label="${isLetter ? "Letter" : "CV"} text"></textarea>`;
      $("#docEdit").value = doc.text;
      $("#docEdit").addEventListener("input", e => { doc.text = e.target.value; });
    }
  } else {
    $("#docBody").classList.toggle("tpl", !!doc.text);
    $("#docBody").innerHTML = !doc.text ? `<p class="tiny">Your ${isLetter ? "letter" : "CV"} will appear here.</p>`
      : isLetter ? renderLetterHtml(doc.text, doc.template, letterMeta(doc)) : renderHtml(doc.text, doc.template);
  }
}
$("#docStatus").addEventListener("click", e => { if (e.target.closest("#btnStopDoc")) ctl?.abort(); });
$("#btnEditDoc").addEventListener("click", async () => {
  doc.editing = !doc.editing;
  if (!doc.editing && doc.cvId) {
    const cv = D.cvs.find(c => c.id === doc.cvId);
    if (cv) { await upsertCv({ ...cv, body: doc.text, updated: Date.now() }); toast("Saved your changes."); }
  }
  if (!doc.editing && doc.letterId) {
    const l = D.letters.find(x => x.id === doc.letterId);
    if (l) { await upsertLetter({ ...l, body: doc.text, updated: Date.now() }); toast("Saved your changes."); }
  }
  renderDoc();
});
$("#btnCopy").addEventListener("click", () => copyText(doc.text, doc.kind === "letter" ? "Letter copied." : "CV copied."));
$("#btnDl").addEventListener("click", () => {
  if (doc.kind === "letter") downloadText(slug(doc.title) + ".txt", doc.text, "text/plain");
  else downloadText(slug(doc.title) + ".md", doc.text, "text/markdown");
  track("text_download", { kind: doc.kind || "cv" });
});
$("#btnPdf").addEventListener("click", () => downloadPdf());
$("#btnSaveGen").addEventListener("click", () => {
  const role = lastMatch?.role || job?.title || "";
  const co = lastMatch?.company || job?.company || "";
  pendingJobLink = job?.url || "";
  openCv(null, { title: role ? role + (co ? " – " + co : "") : doc.title, roles: role, body: doc.text, notes: job?.url ? "Made for " + job.url : "Written " + fmtDate(Date.now()) });
});

/* ---------- templates and PDF export ---------- */
// Little drawings of each layout for the picker (positions in % of a page).
const THUMBS = {
  classic: [["38%", "10%", "24%", "#2a2a2a", 4], ["30%", "17%", "40%", "#b9c2be", 2], ...[28, 46, 64, 82].flatMap(t => [["10%", t + "%", "80%", "#2a2a2a", 1.5], ["10%", t + 4 + "%", "70%", "#cfd6d3", 2], ["10%", t + 8 + "%", "60%", "#cfd6d3", 2]])],
  modern: [["10%", "9%", "40%", "#0E7A55", 5], ["10%", "16%", "50%", "#b9c2be", 2], ["10%", "21%", "80%", "#0E7A55", 1.5], ...[28, 46, 64, 82].flatMap(t => [["10%", t + "%", "26%", "#0E7A55", 2.5], ["10%", t + 5 + "%", "78%", "#cfd6d3", 2], ["10%", t + 9 + "%", "64%", "#cfd6d3", 2]])],
  sidebar: [["0", "0", "34%", "#123B2E", "100%"], ["7%", "8%", "20%", "#ffffff", 4], ["7%", "15%", "18%", "#7fa898", 2], ["7%", "20%", "16%", "#7fa898", 2], ...[30, 50, 70].map(t => ["42%", t + "%", "22%", "#123B2E", 3]), ...[30, 50, 70].flatMap(t => [["42%", t + 5 + "%", "48%", "#cfd6d3", 2], ["42%", t + 9 + "%", "40%", "#cfd6d3", 2]])],
};
const thumb = id => `<span class="thumb" aria-hidden="true">${THUMBS[id].map(([l, t, w, c, h]) => `<i style="left:${l};top:${t};width:${w};height:${typeof h === "number" ? h + "px" : h};background:${c}"></i>`).join("")}</span>`;

function renderPicker() {
  $("#tplPicker").hidden = !doc.text || doc.editing;
  $("#tplPicker").innerHTML = TEMPLATES.map(t => `<button class="tpl-opt" type="button" data-tpl="${t.id}" aria-pressed="${doc.template === t.id}">${thumb(t.id)}<span><b>${t.name}</b><small>${t.blurb}</small></span></button>`).join("");
}
$("#tplPicker").addEventListener("click", async e => {
  const b = e.target.closest("[data-tpl]"); if (!b || b.dataset.tpl === doc.template) return;
  doc.template = b.dataset.tpl;
  renderDoc();
  saveSettings({ cvTemplate: doc.template });
  track("template_change", { template: doc.template, kind: doc.kind || "cv" });
  const cv = doc.cvId && D.cvs.find(c => c.id === doc.cvId);
  if (cv) await upsertCv({ ...cv, template: doc.template });
  const l = doc.letterId && D.letters.find(x => x.id === doc.letterId);
  if (l) await upsertLetter({ ...l, template: doc.template });
});

function downloadPdf(force = false) {
  if (doc.editing) { doc.editing = false; renderDoc(); }
  if (!doc.text) return;
  const n = placeholders(doc.text);
  if (n && !force) {
    $("#docStatus").innerHTML = `<span>Your ${doc.kind === "letter" ? "letter" : "CV"} still has ${n} highlighted <span class="todo">[placeholder${n > 1 ? "s" : ""}]</span>. Fill ${n > 1 ? "them" : "it"} in first, or download anyway.</span>
      <button class="btn sm" id="btnFixFirst" type="button">${icon("pencil")}Fill in</button><button class="btn sm primary" id="btnPdfAnyway" type="button">Download anyway</button>`;
    return;
  }
  if (doc.kind === "letter") renderLetterPdf(doc.text, doc.template, letterMeta(doc)).save(`${slug(doc.title)}.pdf`);
  else renderPdf(doc.text, doc.template).save(`${slug(doc.title)}-${doc.template}.pdf`);
  track("pdf_download", { kind: doc.kind || "cv", template: doc.template, from: "app", placeholders: n });
  toast("PDF downloaded.");
  doc.note = ""; renderDoc();
}
$("#docStatus").addEventListener("click", e => {
  if (e.target.closest("#btnPdfAnyway")) downloadPdf(true);
  else if (e.target.closest("#btnFixFirst")) { doc.editing = true; renderDoc(); $("#docEdit")?.focus(); }
});

$("#btnFormat").addEventListener("click", async () => {
  if (!hasAIKey(D.settings)) { toast("Formatting needs an AI key. Add a free OpenRouter key in Settings."); return; }
  const original = doc.text;
  ctl = new AbortController();
  doc.generating = true; doc.note = ""; renderDoc();
  try {
    const { text } = await runAI("format", { text: original }, { signal: ctl.signal, onText: t => { doc.text = t; renderDoc(); } });
    doc.text = text;
    const cv = doc.cvId && D.cvs.find(c => c.id === doc.cvId);
    if (cv) await upsertCv({ ...cv, body: text, updated: Date.now() });
    doc.note = cv ? "Formatted and saved. Your original file is still kept with this CV." : "Formatted.";
  } catch (err) {
    doc.text = original;
    doc.note = err.code === "cancelled" ? "Stopped. Nothing was changed." : esc(err.message);
  }
  doc.generating = false; renderDoc();
});

/* ---------- uploading a CV file ---------- */
$("#cvFile").accept = ACCEPT;
$("#cvFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) useCvFile(f); });
["dragenter", "dragover"].forEach(t => $("#cvDrop").addEventListener(t, e => { e.preventDefault(); $("#cvDrop").classList.add("over"); }));
["dragleave", "drop"].forEach(t => $("#cvDrop").addEventListener(t, e => { e.preventDefault(); $("#cvDrop").classList.remove("over"); }));
$("#cvDrop").addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) useCvFile(f); });

async function useCvFile(file) {
  const n = $("#cvFileNote");
  n.className = "note"; n.innerHTML = `<span class="spin"></span> Reading ${esc(file.name)}…`;
  try {
    const { text, kind, pages } = await extractText(file);
    // Keep the original so you can download it again (small files only, to keep storage light).
    const dataUrl = file.size <= 5 * 1024 * 1024 ? await readAsDataUrl(file) : null;
    pendingFile = { name: file.name, kind, size: file.size, dataUrl };
    $("#fBody").value = text;
    if (!$("#fTitle").value.trim()) $("#fTitle").value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\bcv\b|\bresume\b/gi, "").trim().replace(/\b[a-z]/g, c => c.toUpperCase()) || "My CV";
    n.className = "note ok";
    n.textContent = `Read ${kind.toUpperCase()}${pages ? `, ${pages} page${pages > 1 ? "s" : ""}` : ""}: ${file.name}. Check the text below, then save.`;
  } catch (err) { n.className = "note err"; n.textContent = err.message; }
}

/* ---------- cover letters ---------- */
const sortedLetters = () => [...D.letters].sort((a, b) => (b.updated || 0) - (a.updated || 0));
const fmtLong = t => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

// Letterhead: your profile first, falling back to the name and contact line on the CV it's based on.
function letterMeta(l) {
  const p = D.profile;
  let name = p.name.trim();
  let contact = p.contact.split(/\s+[·|•]\s+/).map(s => s.trim()).filter(Boolean);
  if (!name || !contact.length) {
    const base = D.cvs.find(c => c.id === l.baseId) || sortedCvs()[0];
    if (base) {
      const cv = parseCv(base.body);
      name = name || cv.name;
      if (!contact.length) contact = contactParts(cv);
    }
  }
  return { name: name || "Your Name", contact, date: l.date || fmtLong(Date.now()), company: l.job?.company || "", role: l.job?.title || "" };
}

function renderLetters() {
  const el = $("#letterTable");
  if (!D.letters.length) {
    el.innerHTML = `<div class="empty">${icon("mail")}<p>No cover letters yet. Paste a job on Match a Job and click <b>Write a cover letter</b>, or use the CV Tree button on any job posting.</p><a class="btn primary" href="#match">${icon("plus")}Write a cover letter</a></div>`;
    return;
  }
  el.innerHTML = `<table><thead><tr><th>Letter</th><th>Job</th><th>Based on</th><th>Last Updated</th><th><span hidden>Actions</span></th></tr></thead><tbody>
    ${sortedLetters().map(l => {
      const base = D.cvs.find(c => c.id === l.baseId);
      return `<tr data-lid="${esc(l.id)}">
        <td><div class="cell-name"><span class="ic solid green">${icon("mail")}</span><div><b>${esc(l.job?.title || l.title)}</b><span class="chip">${esc({ professional: "Professional", warm: "Warm", concise: "Concise" }[l.tone] || "Professional")}</span></div></div></td>
        <td>${esc(l.job?.company || "–")}${safeUrl(l.job?.url) ? ` <a href="${esc(l.job.url)}" target="_blank" rel="noopener" aria-label="Open the job posting">${icon("external")}</a>` : ""}</td>
        <td>${base ? esc(base.title) : '<span class="tiny">Your profile</span>'}</td>
        <td class="when">${esc(fmtDate(l.updated))}<small>${esc(fmtTime(l.updated))}</small></td>
        <td class="acts-cell"><button class="iconbtn" data-lact="view" type="button" aria-label="Open">${icon("eye")}</button><button class="iconbtn" data-lact="pdf" type="button" aria-label="Download PDF">${icon("download")}</button><button class="iconbtn" data-lact="del" type="button" aria-label="Delete">${icon("trash")}</button></td>
      </tr>`;
    }).join("")}</tbody></table>`;
}
$("#letterTable").addEventListener("click", async e => {
  const b = e.target.closest("[data-lact]"); if (!b) return;
  const id = b.closest("[data-lid]").dataset.lid, l = D.letters.find(x => x.id === id);
  const act = b.dataset.lact;
  if (act === "view") location.hash = "letter-" + id;
  else if (act === "pdf") location.hash = "letter-" + id + "/pdf";
  else if (act === "del") b.parentElement.innerHTML = `<span class="confirm">Delete? <button class="btn sm" data-lact="no" type="button">Keep</button><button class="btn sm primary" style="background:var(--red);border-color:var(--red)" data-lact="yes" type="button">Delete</button></span>`;
  else if (act === "yes") { await deleteLetter(id); toast("Deleted the cover letter."); track("letter_deleted"); }
  else if (act === "no") renderLetters();
  void l;
});

function openLetter(l) {
  doc = { kind: "letter", text: l.body, letterId: l.id, cvId: null, editing: false, generating: false, title: l.title, eyebrow: "Cover letter", note: "", from: "letters",
    template: l.template || D.settings.cvTemplate || "modern", job: l.job, baseId: l.baseId || "", tone: l.tone || "professional", length: l.length || "standard", date: l.date };
  renderDoc(); show("doc");
}

/** Write (or rewrite) a cover letter for a job. j needs title, company, url, description. */
async function writeLetter(j, base, opts = {}) {
  if (!hasAIKey(D.settings)) { toast("Cover letters need an AI key. Add a free OpenRouter key in Settings."); location.hash = "settings"; return; }
  if (!j?.description) { toast("Paste the job description first."); return; }
  ctl = new AbortController();
  const tone = opts.tone || "professional", length = opts.length || "standard";
  const template = opts.template || D.settings.cvTemplate || "modern";
  const role = [j.title, j.company].filter(Boolean).join(", ");
  doc = { kind: "letter", text: "", letterId: opts.letterId || null, cvId: null, editing: false, generating: true, note: "", from: opts.from || "match", template,
    title: `Cover letter – ${role || "this job"}`, eyebrow: base ? `Cover letter · based on “${base.title}”` : "Cover letter",
    job: { title: j.title || "", company: j.company || "", url: j.url || "", description: j.description.slice(0, 20000) },
    baseId: base?.id || "", baseText: opts.baseText || "", tone, length, date: opts.date || fmtLong(Date.now()) };
  renderDoc(); show("doc");
  try {
    const { text, truncated } = await runAI("letter", { job: doc.job, baseId: doc.baseId, baseText: doc.baseText, tone, length },
      { signal: ctl.signal, onText: t => { doc.text = t; renderDoc(); } });
    doc.text = text;
    const id = doc.letterId || uid("cl");
    await upsertLetter({ id, title: doc.title, body: text, job: doc.job, baseId: doc.baseId, tone, length, template: doc.template, date: doc.date, updated: Date.now() });
    if (!doc.letterId) logActivity(`Wrote a cover letter for ${role || "a job"}`, "save");
    doc.letterId = id;
    doc.note = truncated ? "The letter was cut short. Try Rewrite."
      : 'Saved to Cover Letters. Fill in any highlighted <span class="todo">[brackets]</span> before sending.';
  } catch (err) {
    doc.text = err.text || doc.text;
    doc.note = err.code === "cancelled" ? "Stopped." : esc(err.message);
  }
  doc.generating = false; renderDoc();
}

function renderLetterOpts() {
  const visible = doc.kind === "letter" && !doc.editing;
  $("#letterOpts").hidden = !visible;
  if (!visible) return;
  $("#ltTone").value = doc.tone; $("#ltLength").value = doc.length;
  $("#ltBase").innerHTML = `<option value="">No CV, just my profile</option>` + sortedCvs().map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join("");
  $("#ltBase").value = D.cvs.some(c => c.id === doc.baseId) ? doc.baseId : "";
  $("#btnRewrite").disabled = doc.generating;
}
$("#btnRewrite").addEventListener("click", () => {
  const base = D.cvs.find(c => c.id === $("#ltBase").value) || null;
  writeLetter(doc.job, base, { tone: $("#ltTone").value, length: $("#ltLength").value, letterId: doc.letterId, from: doc.from, template: doc.template, date: doc.date });
});

// A CV you just tailored (saved or not) can get a matching letter in one click.
$("#btnLetterFromCv").addEventListener("click", () => {
  const j = { ...(doc.job || job || {}), description: (doc.job?.description || $("#jd").value).trim() };
  const base = doc.cvId ? D.cvs.find(c => c.id === doc.cvId) : null;
  writeLetter(j, base, { baseText: base ? "" : doc.text, from: "match", template: doc.template });
});

// From the widget: write a letter for the job on the page, based on the best keyword match.
function startLetterFromPage() {
  const j = D.currentJob;
  history.replaceState(null, "", "#letters");
  if (!j?.description) { show("letters"); toast("Open a job posting first, then click Cover letter in the CV Tree menu."); return; }
  const top = D.cvs.length ? localRank(j.description, D.cvs)[0] : null;
  writeLetter({ title: j.title, company: j.company, url: j.url, description: j.description }, top && D.cvs.find(c => c.id === top.id), { from: "letters" });
}

/* ---------- welcome / setup ---------- */
// First thing people see after installing: four short steps, each showing whether it's done.
function renderWelcome() {
  const st = D.settings, hosted = aiProvider(st) === "cvtree";
  const cvsDone = D.cvs.length > 0, aiDone = hasAIKey(st), profileDone = !!(D.profile.experience.trim() || D.profile.liText || D.profile.projects.length);
  const step = (n, done, title, body, optional) => `<li class="setup-step${done ? " done" : ""}">
      <span class="setup-num" aria-hidden="true">${done ? icon("check") : n}</span>
      <div><div class="row between"><h3>${title}</h3>${done ? '<span class="pill green">Done</span>' : optional ? '<span class="pill">Optional</span>' : ""}</div>${body}</div></li>`;
  $("#welcomeSteps").innerHTML = [
    step(1, cvsDone, "Add your CVs",
      `<p class="tiny">Upload your CVs as PDF or Word files, one per kind of role. They're read in your browser and stay on this device.</p>
       <div class="row"><button class="btn primary" data-act="new" type="button">${icon("upload")}Upload a CV</button>${cvsDone ? `<a class="btn" href="#cvs">See my ${D.cvs.length} CV${D.cvs.length > 1 ? "s" : ""}</a>` : `<button class="btn" data-act="examples" type="button">Try 3 example CVs</button>`}</div>`),
    step(2, aiDone, hosted ? "Free AI is ready" : "Turn on the AI",
      hosted ? `<p class="tiny">Matching jobs, tailoring CVs and writing cover letters work right away with CV Tree's free AI${welcomeQuota ? `: <b>${welcomeQuota.remaining} of ${welcomeQuota.limit}</b> requests left today` : ""}. Want unlimited use? Add your own free OpenRouter key any time.</p>
        <div class="row"><a class="btn" href="#settings">Use my own key</a></div>`
      : `<p class="tiny">CV Tree uses AI to score your CVs against a job and write tailored versions. Get a free key at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai</a> (sign in, then <b>Create API Key</b>) and paste it here.</p>
        <form class="row nowrap" id="wKeyForm"><input id="wKey" type="password" placeholder="sk-or-v1-…" autocomplete="off" aria-label="OpenRouter API key"><button class="btn primary" type="submit">Save key</button></form>
        <p class="note" id="wKeyNote"></p>`),
    step(3, !!st.welcomeDone, "Use it on job sites",
      `<p class="tiny"><b>Pin CV Tree:</b> click the puzzle-piece icon in Chrome's toolbar, then the pin next to CV Tree. Then open any job posting (LinkedIn, Indeed, Greenhouse, Lever, Workday and more) and click the green <b>CV Tree</b> button in the bottom-right corner to see your best CV, tailor it, write a cover letter, or attach it to the application.</p>
       <div class="row"><a class="btn" href="https://www.linkedin.com/jobs/" target="_blank" rel="noopener">${icon("external")}Open LinkedIn Jobs</a></div>`),
    step(4, profileDone, "Tell the AI about your work",
      `<p class="tiny">Connect GitHub and LinkedIn so tailored CVs can mention your real projects and roles.</p>
       <div class="row"><a class="btn" href="#profile/github">${icon("github")}Connect GitHub</a><a class="btn" href="#profile/linkedin">${icon("linkedin")}Connect LinkedIn</a></div>`, true),
  ].join("");
  $("#welcomeUsage").hidden = !analyticsConfigured;
  $("#wUsage").checked = st.shareUsage !== false;
  $("#welcomePrivacy").hidden = !privacyUrl;
  $("#welcomePrivacy").href = privacyUrl || "#";
}
let welcomeQuota = null;
async function loadWelcomeQuota() {
  if (aiProvider(D.settings) !== "cvtree") return;
  try { welcomeQuota = await runAI("ping"); renderWelcome(); } catch { /* shown when an AI action runs */ }
}
$("#welcomeSteps").addEventListener("submit", async e => {
  if (e.target.id !== "wKeyForm") return;
  e.preventDefault();
  const key = $("#wKey").value.trim();
  if (!key) return;
  await saveSettings({ orKey: key, provider: "openrouter" });
  $("#wKeyNote").className = "note"; $("#wKeyNote").textContent = "Checking…";
  try { const r = await runAI("ping"); $("#wKeyNote").className = "note ok"; $("#wKeyNote").textContent = `Key works. Using ${r.name}.`; }
  catch (err) { $("#wKeyNote").className = "note err"; $("#wKeyNote").textContent = err.message; }
});
$("#wUsage").addEventListener("change", async e => {
  if (!e.target.checked) await chrome.storage.local.set({ analyticsQueue: [] });
  await saveSettings({ shareUsage: e.target.checked });
});
$("#btnWelcomeDone").addEventListener("click", async () => {
  await saveSettings({ welcomeDone: true });
  track("welcome_done", { cvs: D.cvs.length, ai: aiProvider(D.settings) });
  location.hash = "dashboard";
});

/* ---------- match ---------- */
function pickUpJob() {
  const j = D.currentJob;
  if (!j || Date.now() - (j.at || 0) > 6 * 3600e3 || $("#jd").dataset.from === String(j.at)) return;
  $("#jd").dataset.from = String(j.at);
  $("#jd").value = [j.title, j.company].filter(Boolean).join(" – ") + "\n\n" + (j.description || "");
  $("#jdLink").value = j.url || "";
  job = { title: j.title, company: j.company, url: j.url };
  $("#fromPage").hidden = false;
  $("#fromPage").innerHTML = `${icon("check")}<span>Filled in from <b>${esc(j.host || "the job page")}</b>. Check the description looks complete.</span>`;
  countJd();
}
function countJd() { $("#jdCount").textContent = `${$("#jd").value.length}/20000`; }
$("#jd").addEventListener("input", countJd);
$("#jdFile").accept = ACCEPT;
$("#jdFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  note(`<span class="thinking">Reading ${esc(f.name)}…</span>`);
  try {
    const { text } = await extractText(f);
    $("#jd").value = text.slice(0, 20000); countJd();
    job = null; $("#fromPage").hidden = true;
    note(`Loaded ${esc(f.name)}. Check the text, then analyze.`, "ok");
    track("job_upload", { kind: f.name.split(".").pop().toLowerCase() });
  } catch (err) { note(esc(err.message), "err"); }
});
function readJob() {
  const description = $("#jd").value.trim();
  if (description.length < 80) { note("Paste the job description first, a few lines at least.", "err"); return null; }
  note("");
  const url = $("#jdLink").value.trim();
  const fromPage = job && job.url === url ? job : {};
  return { title: fromPage.title || description.split("\n")[0].slice(0, 120), company: fromPage.company || "", url, description };
}
function note(msg, cls = "") { $("#matchNote").className = "note " + cls; $("#matchNote").innerHTML = msg; }
function busy(on, label) {
  $("#btnMatch").disabled = on; $("#btnGen").disabled = on; $("#btnStop").hidden = !on;
  $("#btnMatch").innerHTML = on ? `<span class="spin"></span>${esc(label)}` : `${icon("sparkle")}Analyze job match`;
}
$("#btnStop").addEventListener("click", () => ctl?.abort());

$("#btnMatch").addEventListener("click", async () => {
  const j = readJob(); if (!j) return;
  job = j;
  if (!D.cvs.length) { lastMatch = null; $("#matchOut").innerHTML = `<div class="empty">${icon("file")}<p>You haven't saved any CVs yet, so there's nothing to rank. Write one for this job, or add your CVs first.</p><button class="btn primary" data-act="new" type="button">${icon("plus")}Add a CV</button></div>`; return; }
  if (!hasAIKey(D.settings)) { lastMatch = { ranking: localRank(j.description, D.cvs), keyword: true }; expanded = lastMatch.ranking[0]?.id; renderMatch(); track("match_keyword", { cvs: D.cvs.length, top: lastMatch.ranking[0]?.score || 0 }); return; }
  ctl = new AbortController(); busy(true, "Reading your CVs…");
  try {
    lastMatch = await runAI("rank", { job: j }, { signal: ctl.signal });
    if (lastMatch.role) job.title = lastMatch.role;
    if (lastMatch.company) job.company = lastMatch.company;
    expanded = lastMatch.ranking[0]?.id;
    renderMatch();
    const top = D.cvs.find(c => c.id === expanded);
    if (top) await upsertCv({ ...top, matchedCount: (top.matchedCount || 0) + 1 });
    logActivity(`Matched ${lastMatch.role || "a job"}${lastMatch.company ? " at " + lastMatch.company : ""}: best CV scored ${lastMatch.ranking[0]?.score ?? "–"}`, "match");
  } catch (err) { note(esc(err.message), err.code === "cancelled" ? "" : "err"); }
  finally { busy(false); }
});
$("#sortRes").addEventListener("change", () => lastMatch && renderMatch());

const ACTIONS = { send: ["Use this CV", "Send it as is"], tailor: ["Tailor CV", "Tailor first"], generate: ["Write new", "Write new"] };
function renderMatch() {
  const res = lastMatch, out = $("#matchOut");
  let list = res.ranking.filter(r => D.cvs.some(c => c.id === r.id));
  if ($("#sortRes").value === "recent") list = [...list].sort((a, b) => (D.cvs.find(c => c.id === b.id).updated || 0) - (D.cvs.find(c => c.id === a.id).updated || 0));
  const bestId = res.ranking[0]?.id;
  $("#resultsMeta").textContent = `${list.length} CV${list.length === 1 ? "" : "s"} analyzed${res.keyword ? " · keyword match" : ""}`;
  const reco = { send: "Send your best CV as it is.", tailor: "Tailor your best CV first.", generate: "Write a new CV for this job." }[res.recommendation];
  out.innerHTML = `
    ${res.keyword ? `<p class="res-keyword">Add a free OpenRouter key in <a href="#settings">Settings</a> for real scores. This ranking only counts shared keywords.</p>` : ""}
    ${res.role ? `<p class="eyebrow">${esc(res.company || "This job")}</p><h2 style="margin-bottom:10px">${esc(res.role)}</h2>` : ""}
    ${reco ? `<div class="verdict">${icon("sparkle")}<div><b>${esc(reco)}</b> ${esc(res.advice || "")}</div></div>` : ""}
    ${list.map(r => {
      const cv = D.cvs.find(c => c.id === r.id), open = expanded === r.id, act = r.action || "tailor";
      const C = 2 * Math.PI * 24, off = C * (1 - r.score / 100);
      return `<div class="res${r.id === bestId ? " top" : ""}">
        <div class="res-head" data-toggle="${esc(r.id)}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="ring"><svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="24" fill="none" stroke="var(--line)" stroke-width="5"/><circle cx="29" cy="29" r="24" fill="none" stroke="${tier(r.score)}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg><b>${r.score}%</b></div>
          <div style="min-width:0;display:grid;gap:6px"><h3>${icon("file")}${esc(cv.title)}</h3><div class="chips">${splitList(cv.roles).slice(0, 4).map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div></div>
          ${r.id === bestId ? `<span class="pill green">${icon("sparkle")}Best match</span>` : `<button class="btn sm soft" data-run="${act}" data-id="${esc(r.id)}" type="button">${ACTIONS[act][1]}</button>`}
        </div>
        ${open ? `<div class="res-body">
          ${r.fits?.length ? `<div><h4>Why it fits</h4><ul>${r.fits.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
          ${r.gaps?.length ? `<div><h4>What's missing</h4><ul>${r.gaps.map(g => `<li>${esc(g)}</li>`).join("")}</ul></div>` : ""}
          <div class="reco"><div><small>${icon("sparkle")}Recommendation</small><b>${{ send: "Send this CV as it is", tailor: "Tailor this CV", generate: "Write a new CV instead" }[act]}</b></div>
            <div class="row"><button class="btn sm" data-act="view" data-id="${esc(r.id)}" type="button">${icon("eye")}View</button><button class="btn sm" data-letter="${esc(r.id)}" type="button">${icon("mail")}Cover letter</button><button class="btn sm primary" data-run="${act}" data-id="${esc(r.id)}" type="button">${ACTIONS[act][0]}${icon("arrow")}</button></div></div>
        </div>` : ""}
      </div>`;
    }).join("")}`;
}
$("#matchOut").addEventListener("click", e => {
  const lt = e.target.closest("[data-letter]");
  if (lt) { e.stopPropagation(); letterForJob(D.cvs.find(c => c.id === lt.dataset.letter)); return; }
  const run = e.target.closest("[data-run]");
  if (run) {
    e.stopPropagation();
    const cv = D.cvs.find(c => c.id === run.dataset.id);
    if (run.dataset.run === "send") location.hash = "cv-" + cv.id;
    else generate(run.dataset.run === "tailor" ? cv : null);
    return;
  }
  const t = e.target.closest("[data-toggle]");
  if (t && !e.target.closest("[data-act]")) { expanded = expanded === t.dataset.toggle ? null : t.dataset.toggle; renderMatch(); }
});
$("#matchOut").addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-toggle]")) { e.preventDefault(); e.target.click(); } });
$("#btnGen").addEventListener("click", () => generate(null));
$("#btnLetter").addEventListener("click", () => {
  const best = lastMatch?.ranking?.[0]?.id || (D.cvs.length && readJob() ? localRank($("#jd").value, D.cvs)[0].id : null);
  letterForJob(D.cvs.find(c => c.id === best) || null);
});
function letterForJob(base) {
  const j = readJob(); if (!j) return;
  writeLetter({ ...j, title: lastMatch?.role || j.title, company: lastMatch?.company || j.company }, base, { from: "match" });
}

async function generate(base) {
  const j = readJob(); if (!j) return;
  job = { ...j, title: lastMatch?.role || j.title, company: lastMatch?.company || j.company };
  if (!hasAIKey(D.settings)) { note('Writing CVs needs an AI key. Add a free OpenRouter key in <a href="#settings">Settings</a>.', "err"); return; }
  const p = D.profile;
  if (!(p.experience.trim() || p.liText.trim() || p.projects.length || base)) { note('Add your work history or a project on <a href="#profile/work">Experience &amp; Projects</a> first, so the AI has something real to write from.', "err"); return; }
  ctl = new AbortController();
  doc = { text: "", cvId: null, editing: false, generating: true, from: "match", note: "", template: D.settings.cvTemplate || "modern",
    kind: "cv", job: { title: job.title || "", company: job.company || "", url: job.url || "", description: job.description },
    title: [job.title, job.company].filter(Boolean).join(" – ") || "CV for this job",
    eyebrow: base ? `Tailored from “${base.title}”` : "New draft" };
  renderDoc(); show("doc");
  try {
    const { text, truncated } = await runAI("generate", { job, baseId: base?.id }, { signal: ctl.signal, onText: t => { doc.text = t; renderDoc(); } });
    doc.text = text;
    doc.note = truncated ? "The CV was cut short. Try again." : 'Draft ready. Highlighted <span class="todo">[brackets]</span> mark details the AI didn\'t have; fill them in before sending.';
  } catch (err) {
    doc.text = err.text || doc.text;
    doc.note = err.code === "cancelled" ? "Stopped." : esc(err.message);
  }
  doc.generating = false; renderDoc();
}

/* ---------- profile ---------- */
$$(".subtabs button").forEach(b => b.addEventListener("click", () => { location.hash = "profile/" + b.dataset.sub; }));
function renderSub() {
  $$(".subtabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.sub === sub)));
  $$(".sub-pane").forEach(p => { p.hidden = p.dataset.pane !== sub; });
}
function fillProfile() { $$("[data-pf]").forEach(el => { el.value = D.profile[el.dataset.pf] || ""; }); }
let saveT;
$$("[data-pf]").forEach(el => el.addEventListener("input", () => {
  $("#profNote").textContent = "Saving…";
  clearTimeout(saveT);
  saveT = setTimeout(() => persistProfile(), 600);
}));
async function persistProfile(patch = {}) {
  const p = { ...D.profile, ...patch };
  $$("[data-pf]").forEach(el => { p[el.dataset.pf] = el.value; });
  D.profile = p;
  await save({ profile: p });
  $("#profNote").textContent = "All changes saved";
}

function renderSkills() {
  const skills = splitList(D.profile.skills);
  $("#skillChips").innerHTML = skills.length
    ? skills.map(s => `<span class="chip">${esc(s)}<button type="button" data-skill="${esc(s)}" aria-label="Remove ${esc(s)}">${icon("x")}</button></span>`).join("")
    : `<p class="tiny">No skills yet. Add them above, or import them from LinkedIn.</p>`;
}
$("#skillForm").addEventListener("submit", async e => {
  e.preventDefault();
  const add = splitList($("#skillInput").value); if (!add.length) return;
  const have = splitList(D.profile.skills);
  const lower = new Set(have.map(s => s.toLowerCase()));
  const merged = [...have, ...add.filter(s => !lower.has(s.toLowerCase()))];
  $("#skillInput").value = "";
  await persistProfile({ skills: merged.join(", ") });
});
$("#skillChips").addEventListener("click", async e => {
  const b = e.target.closest("[data-skill]"); if (!b) return;
  await persistProfile({ skills: splitList(D.profile.skills).filter(s => s !== b.dataset.skill).join(", ") });
});

function renderRecent() {
  const ps = D.profile.projects.filter(p => p.include !== false).slice(0, 4);
  $("#recentProj").innerHTML = ps.length ? ps.map(p => `<div class="rp">
      <span class="ic">${icon(p.source === "github" ? "github" : "briefcase")}</span>
      <div style="min-width:0"><b>${esc(p.name)}</b><p>${esc((p.description || firstLine(p.readme)).slice(0, 90))}</p>
        <div class="chips">${[p.language, ...(p.topics || [])].filter(Boolean).slice(0, 3).map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div></div>
      ${safeUrl(p.url) ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(p.name)}">${icon("external")}</a>` : "<span></span>"}
    </div>`).join("")
    : `<div class="empty">${icon("github")}<p>No projects yet. Connect GitHub to pull in your repos and READMEs.</p><a class="btn sm primary" href="#profile/github">Connect GitHub</a></div>`;
}
function renderProjects() {
  const ps = D.profile.projects;
  $("#projList").innerHTML = ps.length ? ps.map((p, i) => `
    <div class="proj" data-i="${i}">
      <input type="checkbox" id="inc${i}" data-pact="toggle" ${p.include !== false ? "checked" : ""} aria-label="Use ${esc(p.name)} in CVs">
      <div style="min-width:0;display:grid;gap:3px">
        <div class="t"><label for="inc${i}"><b>${esc(p.name)}</b></label>${safeUrl(p.url) ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : ""}</div>
        <div class="meta">${[p.source === "github" ? "GitHub" : "Added by hand", p.language, p.stars ? "★ " + p.stars : "", p.private ? "private" : "", p.readme ? "README ✓" : "no README"].filter(Boolean).map(esc).join(" · ")}</div>
        <p>${esc(p.description || firstLine(p.readme).slice(0, 160))}</p>
        <div class="row"><button class="btn link" data-pact="edit" type="button">Edit</button><button class="btn link" style="color:var(--red)" data-pact="del" type="button">Remove</button></div>
      </div>
    </div>`).join("")
    : `<p class="tiny">No projects yet. Connect GitHub above, or add one by hand.</p>`;
}
let projIdx = -1;
function openProj(i) {
  projIdx = i; const p = D.profile.projects[i] || {};
  $("#pdlgTitle").textContent = i >= 0 ? "Edit project" : "Add a project";
  $("#gName").value = p.name || ""; $("#gUrl").value = p.url || ""; $("#gReadme").value = p.readme || p.description || "";
  $("#pdlg").showModal();
}
$("#btnAddProj").addEventListener("click", () => openProj(-1));
$("#projList").addEventListener("click", async e => {
  const b = e.target.closest("[data-pact]"); if (!b) return;
  const i = +b.closest("[data-i]").dataset.i, ps = [...D.profile.projects];
  if (b.dataset.pact === "toggle") { ps[i] = { ...ps[i], include: b.checked }; await persistProfile({ projects: ps }); }
  else if (b.dataset.pact === "edit") openProj(i);
  else if (b.dataset.pact === "del") { const [gone] = ps.splice(i, 1); await persistProfile({ projects: ps }); toast("Removed " + gone.name + "."); }
});
$("#projForm").addEventListener("submit", async e => {
  if (e.submitter?.value !== "save") return;
  const ps = [...D.profile.projects];
  const p = { ...(ps[projIdx] || { source: "manual", include: true }), name: $("#gName").value.trim(), url: $("#gUrl").value.trim(), readme: $("#gReadme").value };
  if (projIdx >= 0) ps[projIdx] = p; else ps.push(p);
  await persistProfile({ projects: ps });
  toast("Saved " + p.name + ".");
});

/* ---------- GitHub ---------- */
function renderGitHub() {
  const s = D.settings, el = $("#ghCard");
  const count = D.profile.projects.filter(p => p.source === "github").length;
  const status = s.ghToken ? `<span class="pill green">${icon("check")}Connected</span>` : count ? `<span class="pill">${count} repos imported</span>` : `<span class="pill">Not connected</span>`;
  let body = "";
  if (gh.phase === "code") {
    body = `<p class="tiny">Enter this code on GitHub to let CV Tree read your repositories:</p>
      <div class="code-box">${esc(gh.flow.user_code)}</div>
      <div class="row"><button class="btn primary" data-gh="open" type="button">${icon("copy")}Copy code and open GitHub</button><button class="btn ghost" data-gh="cancel" type="button">Cancel</button></div>
      <p class="note"><span class="spin"></span> Waiting for you to approve on GitHub…</p>`;
  } else if (gh.phase === "importing") {
    body = `<p class="note"><span class="spin"></span> ${esc(gh.progress || "Fetching your repositories…")}</p>`;
  } else if (gh.phase === "setup") {
    body = `<p class="tiny">GitHub needs to know which app is asking. This is a one-time, two-minute setup:</p>
      <ol class="steps">
        <li><a href="https://github.com/settings/applications/new" target="_blank" rel="noopener">Register a new OAuth app</a>. Name it “CV Tree” and use <code>https://github.com</code> for both URLs.</li>
        <li>Tick <b>Enable Device Flow</b> and click Register.</li>
        <li>Copy the <b>Client ID</b> and paste it below. No client secret is needed.</li>
      </ol>
      <div class="fields"><label for="ghClientId" class="field-label">Client ID</label><input id="ghClientId" type="text" autocomplete="off" placeholder="Ov23li…" value="${esc(s.ghClientId)}">
      <label class="switch" for="ghPrivate" style="margin:8px 0"><input id="ghPrivate" type="checkbox"><span></span>Include private repositories</label></div>
      <div class="row"><button class="btn primary" data-gh="saveConnect" type="button">Save and connect</button><button class="btn ghost" data-gh="cancel" type="button">Cancel</button></div>`;
  } else if (s.ghToken) {
    body = `<p class="tiny">Signed in as <b>@${esc(s.ghLogin)}</b>, ${/\brepo\b/.test(s.ghScope) ? "public and private repositories" : "public repositories"}. ${count} repos in your projects.</p>
      <div class="row"><button class="btn primary" data-gh="refresh" type="button">Refresh repositories</button><button class="btn ghost" style="color:var(--red)" data-gh="disconnect" type="button">Disconnect</button></div>`;
  } else {
    body = `<p class="tiny">Pull in your repositories and their READMEs so the AI can describe your projects.</p>
      <div class="row"><button class="btn primary" data-gh="connect" type="button">${icon("github")}Connect GitHub</button>
      ${CONFIG.githubClientId || s.ghClientId ? `<label class="switch" for="ghPrivateQuick"><input id="ghPrivateQuick" type="checkbox"><span></span>Include private repos</label>` : ""}</div>
      <details><summary>Or import public repos without signing in</summary>
        <form class="row nowrap" style="margin-top:10px" data-gh-form><input id="ghUser" type="text" placeholder="GitHub username" autocomplete="off" aria-label="GitHub username"><button class="btn" data-gh="public" type="submit">Import</button></form>
      </details>`;
  }
  el.innerHTML = `<div class="gh-head"><span class="ic">${icon("github")}</span><div><h3>GitHub</h3></div>${status}</div>` + body + (gh.error ? `<p class="note err">${esc(gh.error)}</p>` : "");
}
$("#ghCard").addEventListener("submit", e => e.preventDefault());
$("#ghCard").addEventListener("click", async e => {
  const b = e.target.closest("button[data-gh]"); if (!b) return;
  gh.error = "";
  const act = b.dataset.gh;
  if (act === "connect") {
    const clientId = D.settings.ghClientId || CONFIG.githubClientId;
    if (!clientId) { gh.phase = "setup"; return renderGitHub(); }
    return connectGitHub(clientId, $("#ghPrivateQuick")?.checked || /\brepo\b/.test(D.settings.ghScope));
  }
  if (act === "saveConnect") {
    const id = $("#ghClientId").value.trim();
    if (!id) { gh.error = "Paste the Client ID first."; return renderGitHub(); }
    const priv = $("#ghPrivate").checked;
    await saveSettings({ ghClientId: id });
    return connectGitHub(id, priv);
  }
  if (act === "open") {
    try { await navigator.clipboard.writeText(gh.flow.user_code); } catch {}
    window.open(gh.flow.verification_uri, "_blank", "noopener");
    return;
  }
  if (act === "cancel") { gh.ctl?.abort(); gh.phase = "idle"; return renderGitHub(); }
  if (act === "disconnect") { await saveSettings({ ghToken: "", ghLogin: "", ghScope: "" }); toast("Disconnected GitHub."); return; }
  if (act === "refresh") return importRepos({ token: D.settings.ghToken });
  if (act === "public") {
    const login = $("#ghUser").value.trim().replace(/^@/, "");
    if (!login) { gh.error = "Type a GitHub username."; return renderGitHub(); }
    return importRepos({ login });
  }
});

async function connectGitHub(clientId, includePrivate) {
  gh.ctl = new AbortController();
  try {
    gh.flow = await startDeviceFlow(clientId, includePrivate);
    gh.phase = "code"; renderGitHub();
    const { token, scope } = await pollForToken(clientId, gh.flow, gh.ctl.signal);
    const user = await getUser(token);
    await saveSettings({ ghToken: token, ghLogin: user.login, ghScope: scope });
    D = await load();
    await importRepos({ token });
  } catch (err) {
    if (gh.ctl.signal.aborted) return;
    gh.phase = "setup"; gh.error = err.message; renderGitHub();
  }
}

async function importRepos({ token, login }) {
  gh.phase = "importing"; gh.progress = "Fetching your repositories…"; renderGitHub();
  try {
    const repos = await listRepos({ token, login });
    const withText = await withReadmes(repos, token, (n, total) => { gh.progress = `Reading READMEs: ${n} of ${total}…`; renderGitHub(); });
    const { profile } = await load();
    const existing = new Map(profile.projects.filter(p => p.source === "github").map(p => [p.repoId, p]));
    const manual = profile.projects.filter(p => p.source !== "github");
    // New repos: tick the 12 most recently pushed that have a README or description; you can change it after.
    let fresh = 0;
    const imported = withText.map(r => {
      const old = existing.get(r.repoId);
      const include = old ? old.include : (fresh < 12 && (r.readme.length > 200 || r.description) ? (fresh++, true) : false);
      return { ...r, source: "github", include };
    });
    await save({ profile: { ...profile, projects: [...manual, ...imported] } });
    gh.phase = "idle";
    const msg = `Imported ${imported.length} GitHub repositories, ${imported.filter(p => p.include).length} ticked for CVs`;
    logActivity(msg, "import"); toast(msg + ".");
    track("github_import", { method: token ? "signin" : "public", repos: imported.length });
  } catch (err) { gh.phase = "idle"; gh.error = err.message; }
  D = await load(); renderAll();
}

/* ---------- LinkedIn ---------- */
$("#btnLi").addEventListener("click", async () => {
  await chrome.storage.local.set({ liImportPending: Date.now() });
  window.open("https://www.linkedin.com/in/me/", "_blank", "noopener");
  track("linkedin_connect");
  toast("Opened LinkedIn. Click “Import this profile” in the CV Tree menu there.");
});

/* ---------- link hub ---------- */
function renderHub() {
  const cvs = sortedCvs(), p = D.profile;
  $("#hubList").innerHTML = cvs.length ? cvs.map(cv => {
    const url = safeUrl(cv.link);
    return `<div class="hub-row" data-id="${esc(cv.id)}"><span class="ic ${colorOf(cv)}">${icon("file")}</span>
      <div style="min-width:0"><b>${esc(cv.title)}</b><small>${url ? esc(url.replace(/^https?:\/\/(www\.)?/, "")) : "No public link yet"}</small></div>
      ${url ? `<button class="btn sm" data-act="copyLink" type="button">${icon("copy")}Copy</button>` : `<button class="btn sm soft" data-act="edit" type="button">${icon("plus")}Add link</button>`}</div>`;
  }).join("") : `<div class="empty">${icon("link")}<p>Add CVs first. Each one becomes a button here.</p></div>`;
  $("#hubPreview").innerHTML = `<span class="avatar">${esc(initials(p.name))}</span><h5>${esc(p.name || "Your name")}</h5>
    <span class="tagline">${esc(p.headline || "Your headline")}</span>
    ${cvs.map(cv => safeUrl(cv.link) ? `<a class="lk" href="${esc(cv.link)}" target="_blank" rel="noopener">${esc(cv.title)}${icon("arrow")}</a>` : `<span class="lk off">${esc(cv.title)}</span>`).join("")}
    ${safeUrl(p.liUrl) ? `<a class="lk" href="${esc(p.liUrl)}" target="_blank" rel="noopener">LinkedIn${icon("arrow")}</a>` : ""}
    ${D.settings.ghLogin ? `<a class="lk" href="https://github.com/${esc(D.settings.ghLogin)}" target="_blank" rel="noopener">GitHub${icon("arrow")}</a>` : ""}`;
}
$("#btnCopyLinks").addEventListener("click", () => {
  const lines = sortedCvs().filter(c => safeUrl(c.link)).map(c => `${c.title}\n${c.link}`);
  if (!lines.length) { toast("Add a public link to a CV first."); return; }
  copyText(lines.join("\n\n"), `Copied ${lines.length} link${lines.length > 1 ? "s" : ""}. Paste them into Linktree.`);
});

/* ---------- settings ---------- */
function fillSettings() {
  const st = D.settings;
  $("#cvtreeOpt").hidden = !hostedAIConfigured;
  $$('input[name="provider"]').forEach(r => { r.checked = r.value === aiProvider(st); });
  $("#orKey").value = st.orKey; $("#sKey").value = st.apiKey; $("#sModel").value = st.model;
  setOrModel(st.orModel || "openrouter/free");
  $("#sShow").checked = st.showOnJobPages !== false;
  $("#sUsage").checked = st.shareUsage !== false;
  showProviderFields();
}
function setOrModel(id) {
  const inList = [...$("#orModel").options].some(o => o.value === id);
  $("#orModel").value = inList ? id : "openrouter/free";
  $("#orCustom").value = inList ? "" : id;
}
function showProviderFields() {
  const p = $('input[name="provider"]:checked')?.value || "openrouter";
  $("#cvFields").hidden = p !== "cvtree"; $("#orFields").hidden = p !== "openrouter"; $("#anFields").hidden = p !== "anthropic";
}
$$('input[name="provider"]').forEach(r => r.addEventListener("change", showProviderFields));

// Fill the model picker with OpenRouter's current free text models (the list changes often).
let modelsLoaded = false;
async function loadFreeModels() {
  if (modelsLoaded) return;
  modelsLoaded = true;
  try {
    const { data } = await (await fetch("https://openrouter.ai/api/v1/models")).json();
    const free = data.filter(m => (m.id.endsWith(":free") || (m.pricing?.prompt === "0" && m.pricing?.completion === "0"))
      && m.id !== "openrouter/free"
      && (m.architecture?.output_modalities || ["text"]).includes("text")
      && (m.architecture?.input_modalities || ["text"]).includes("text")
      && !/safety|guard/i.test(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Claude on OpenRouter: paid from your OpenRouter credits. Newest Haiku, Sonnet and Opus, with a rough cost per CV
    // (about 6k tokens in, 1.5k out).
    const claude = ["haiku", "sonnet", "opus"].map(f => data.filter(m => new RegExp(`^anthropic/claude-${f}-[0-9.]+$`).test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0]).filter(Boolean);
    const perCv = m => 6000 * Number(m.pricing?.prompt || 0) + 1500 * Number(m.pricing?.completion || 0);
    $("#orModel").insertAdjacentHTML("beforeend",
      (claude.length ? `<optgroup label="Claude (paid from your OpenRouter credits)">${claude.map(m =>
        `<option value="${esc(m.id)}">${esc(m.name.replace(/^Anthropic:\s*/, ""))} · about $${perCv(m) < 0.01 ? perCv(m).toFixed(3) : perCv(m).toFixed(2)} per CV</option>`).join("")}</optgroup>` : "")
      + `<optgroup label="Free models">${free.map(m =>
        `<option value="${esc(m.id)}">${esc(m.name)}${(m.supported_parameters || []).includes("structured_outputs") ? "" : " (no JSON mode)"}</option>`).join("")}</optgroup>`);
    $("#orModelsNote").textContent = `${free.length} free models, plus Claude with credits`;
    setOrModel(D.settings.orModel || "openrouter/free");
  } catch { modelsLoaded = false; $("#orModelsNote").textContent = "couldn't load the model list; type a model ID below"; }
}

function renderHidden() {
  const hs = D.settings.hiddenSites;
  $("#hiddenSites").innerHTML = hs.length ? hs.map(h => `<span class="chip">${esc(h)}<button type="button" data-host="${esc(h)}" aria-label="Show on ${esc(h)} again">${icon("x")}</button></span>`).join("") : `<span class="tiny">None. Use “Don't show on this site” in the widget to hide it somewhere.</span>`;
}
$("#hiddenSites").addEventListener("click", e => {
  const h = e.target.closest("button[data-host]")?.dataset.host; if (!h) return;
  saveSettings({ hiddenSites: D.settings.hiddenSites.filter(x => x !== h) });
});
$$("[data-show]").forEach(b => b.addEventListener("click", () => {
  const i = $("#" + b.dataset.show); i.type = i.type === "password" ? "text" : "password"; b.textContent = i.type === "password" ? "Show" : "Hide";
}));
function readAISettings() {
  return {
    provider: $('input[name="provider"]:checked')?.value || "",
    orKey: $("#orKey").value.trim(),
    orModel: $("#orCustom").value.trim() || $("#orModel").value,
    apiKey: $("#sKey").value.trim(),
    model: $("#sModel").value,
  };
}
$("#btnSaveKey").addEventListener("click", async () => {
  await saveSettings(readAISettings());
  $("#keyNote").className = "note ok"; $("#keyNote").textContent = "Saved.";
  const st = readAISettings(); track("ai_settings", { provider: st.provider, model: st.provider === "openrouter" ? st.orModel : st.model });
});
$("#btnTestKey").addEventListener("click", async () => {
  await saveSettings(readAISettings());
  $("#keyNote").className = "note"; $("#keyNote").textContent = "Checking…";
  try { const r = await runAI("ping"); $("#keyNote").className = "note ok"; $("#keyNote").textContent = `Key works. Using ${r.name}.`; }
  catch (err) { $("#keyNote").className = "note err"; $("#keyNote").textContent = err.message; }
});
$("#sShow").addEventListener("change", e => saveSettings({ showOnJobPages: e.target.checked }));
// Usage statistics: the card only shows when this build sends them somewhere.
$("#usageCard").hidden = !analyticsConfigured;
$("#privacyLink").href = privacyUrl || "#";
$("#privacyLink").parentElement.hidden = !privacyUrl;
// How many free AI requests are left today, shown under the free AI option.
async function loadQuota() {
  if (aiProvider(D.settings) !== "cvtree") { $("#cvQuota").textContent = ""; return; }
  try { const q = await runAI("ping"); $("#cvQuota").textContent = `${q.remaining} of ${q.limit} requests left today.`; }
  catch (err) { $("#cvQuota").textContent = err.message; }
}
$("#sUsage").checked = D?.settings?.shareUsage !== false;
$("#sUsage").addEventListener("change", async e => {
  if (!e.target.checked) await chrome.storage.local.set({ analyticsQueue: [] });
  await saveSettings({ shareUsage: e.target.checked });
  toast(e.target.checked ? "Thanks. Anonymous usage stats are on." : "Usage stats are off. Nothing more will be sent.");
});
$("#btnExport").addEventListener("click", () => {
  downloadText(`cv-tree-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, cvs: D.cvs, profile: D.profile }, null, 2), "application/json");
  $("#backupNote").textContent = "Backup saved to your downloads.";
});
$("#importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const x = JSON.parse(await f.text());
    if (!Array.isArray(x.cvs) || typeof x.profile !== "object") throw new Error();
    const ids = new Set(D.cvs.map(c => c.id));
    await save({ cvs: [...D.cvs, ...x.cvs.filter(c => !ids.has(c.id))], profile: { ...D.profile, ...x.profile } });
    D = await load(); fillProfile();
    $("#backupNote").textContent = `Imported ${x.cvs.length} CVs and your profile.`;
  } catch { $("#backupNote").textContent = "That file isn't a CV Tree backup."; }
});

/* ---------- helpers ---------- */
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg || "Copied."); } catch { toast("Couldn't copy. Select the text and copy it instead."); }
}
function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200);
}

async function addExamples() {
  const now = Date.now();
  const ex = [
    { title: "Frontend Engineer", roles: "React, TypeScript, Web",
      body: "# Ada Example\nada@example.com · Remote\n## Summary\nFrontend engineer focused on React and TypeScript, building fast, accessible product UI.\n## Skills\nReact, TypeScript, Next.js, CSS, Jest, Playwright, Figma\n## Experience\n### Frontend Engineer, Example Co (2022 – present)\n- Built a component library used across 4 product teams\n- Cut page load time from 3.1s to 1.4s\n## Projects\n### ShopKit\n- Open-source React checkout components" },
    { title: "GIS Developer", roles: "GIS, React, Python",
      body: "# Ada Example\nada@example.com · Remote\n## Summary\nGIS developer who builds web maps and spatial data pipelines.\n## Skills\nQGIS, ArcGIS, PostGIS, Python, Leaflet, React\n## Experience\n### GIS Analyst, Example Maps (2021 – 2023)\n- Built a web GIS reporting tool used by 3 regional offices\n- Automated land-use classification with Python, saving 10 hours a week" },
    { title: "Software Engineer", roles: "Node.js, TypeScript, APIs",
      body: "# Ada Example\nada@example.com · Remote\n## Summary\nBackend-leaning engineer who designs reliable APIs.\n## Skills\nNode.js, TypeScript, PostgreSQL, Docker, AWS, REST\n## Experience\n### Software Engineer, Example Co (2023 – present)\n- Designed a public API adopted by 120 partners\n- Cut p95 latency from 800ms to 220ms" },
  ];
  const cvs = ex.map((e, i) => ({ ...e, id: uid("cv"), kind: "cv", example: true, link: "", notes: "Example. Replace with your own.", updated: now - i * 6e5, matchedCount: 0 }));
  await save({ cvs: [...D.cvs, ...cvs] });
}
