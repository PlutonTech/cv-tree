// CV structure and HTML previews (CVs and cover letters). No PDF library here, so the
// floating widget can show previews without loading it on every page.
import { esc, inline } from "./match.js";

export const TEMPLATES = [
  { id: "classic", name: "Classic", blurb: "Serif, centred header, ruled sections. Safe for any industry." },
  { id: "modern", name: "Modern", blurb: "Clean sans-serif with green accents and right-aligned dates." },
  { id: "sidebar", name: "Sidebar", blurb: "Two columns: contact and skills in a dark green sidebar." },
];

export const SIDE_SECTIONS = /skill|language|certif|tool|interest|award|contact|link/i;

/* ---------- parsing ---------- */
export const strip = s => String(s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2").trim();

export function parseCv(md) {
  const cv = { name: "", contact: [], sections: [] };
  let sec = null, entry = null;
  const lines = String(md || "").split(/\r?\n/);
  const hasHeadings = lines.some(l => /^#{1,3}\s/.test(l));
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l.trim()) continue;
    let m;
    if ((m = l.match(/^#\s+(.*)/)) && !cv.name) { cv.name = m[1].trim(); continue; }
    if (!hasHeadings && !cv.name) { cv.name = l.trim(); continue; }
    if ((m = l.match(/^#{1,2}\s+(.*)/))) { sec = { title: m[1].trim(), items: [] }; cv.sections.push(sec); entry = null; continue; }
    if (!sec && /^###\s|^\s*[-*•]\s/.test(l)) { sec = { title: "", items: [] }; cv.sections.push(sec); }
    if ((m = l.match(/^###\s+(.*)/))) {
      const t = m[1].trim(), d = t.match(/\s*\(([^()]*\d[^()]*)\)\s*$/);
      entry = { type: "entry", title: d ? t.slice(0, d.index).trim() : t, date: d ? d[1].trim() : "", lines: [] };
      sec.items.push(entry);
      continue;
    }
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) {
      (entry ? entry.lines : sec.items).push({ type: "bullet", text: m[1].trim() });
      continue;
    }
    if (!sec && hasHeadings) { cv.contact.push(l.trim()); continue; }
    if (!sec) { sec = { title: "", items: [] }; cv.sections.push(sec); }
    (entry ? entry.lines : sec.items).push({ type: "p", text: l.trim() });
  }
  return cv;
}

/** Does this text look like a structured CV (so templates can lay it out)? */
export const isStructured = md => /^##\s/m.test(md || "");

/* ---------- HTML preview ---------- */
function itemsHtml(items) {
  let out = "", list = false;
  for (const it of items) {
    if (it.type !== "bullet" && list) { out += "</ul>"; list = false; }
    if (it.type === "bullet") { if (!list) { out += "<ul>"; list = true; } out += `<li>${inline(it.text)}</li>`; }
    else if (it.type === "p") out += `<p>${inline(it.text)}</p>`;
    else out += `<div class="entry"><div class="eh"><b>${inline(it.title)}</b>${it.date ? `<span>${esc(it.date)}</span>` : ""}</div>${itemsHtml(it.lines)}</div>`;
  }
  return out + (list ? "</ul>" : "");
}
const sectionHtml = s => `<section>${s.title ? `<h2>${inline(s.title)}</h2>` : ""}${itemsHtml(s.items)}</section>`;
export const contactParts = cv => cv.contact.flatMap(c => c.split(/\s+[·|•]\s+/)).map(s => s.trim()).filter(Boolean);

export function renderHtml(md, tpl) {
  const cv = parseCv(md);
  if (tpl === "sidebar") {
    const side = cv.sections.filter(s => SIDE_SECTIONS.test(s.title));
    const main = cv.sections.filter(s => !side.includes(s));
    return `<div class="cvt cvt-sidebar"><aside><h1>${inline(cv.name)}</h1>
      ${contactParts(cv).length ? `<ul class="contact">${contactParts(cv).map(c => `<li>${inline(c)}</li>`).join("")}</ul>` : ""}
      ${side.map(s => `<section><h2>${inline(s.title)}</h2>${sideItemsHtml(s.items)}</section>`).join("")}</aside>
      <main>${main.map(sectionHtml).join("")}</main></div>`;
  }
  return `<div class="cvt cvt-${tpl === "modern" ? "modern" : "classic"}"><header><h1>${inline(cv.name)}</h1>
    ${cv.contact.length ? `<p class="contact">${contactParts(cv).map(inline).join(' <span class="sep">·</span> ')}</p>` : ""}</header>
    ${cv.sections.map(sectionHtml).join("")}</div>`;
}
// In the sidebar, a comma list of skills reads better as one item per line.
export function sideItems(items) {
  return items.flatMap(it => it.type === "p" && it.text.includes(",") ? it.text.split(",").map(t => ({ type: "bullet", text: t.trim() })).filter(t => t.text) : [it]);
}
const sideItemsHtml = items => itemsHtml(sideItems(items));

/* ---------- cover letters ---------- */
export const paragraphs = text => String(text || "").replace(/^#+\s.*$/gm, "").trim().split(/\n\s*\n/)
  .map(p => p.split("\n").map(l => l.trim()).filter(Boolean)).filter(p => p.length);

/** meta: {name, contact: string[], date, company, role} */
export function renderLetterHtml(text, tpl, meta) {
  const contact = meta.contact || [];
  const head = `<div class="lt-meta"><p class="lt-date">${esc(meta.date)}</p>${meta.company ? `<p>Hiring Team<br>${esc(meta.company)}</p>` : ""}${meta.role ? `<p><b>Re: ${esc(meta.role)}</b></p>` : ""}</div>`;
  const body = `<div class="lt-body">${paragraphs(text).map(p => `<p>${p.map(inline).join("<br>")}</p>`).join("")}</div>`;
  if (tpl === "sidebar") {
    return `<div class="cvt cvt-sidebar letter"><aside><h1>${inline(meta.name)}</h1>
      ${contact.length ? `<ul class="contact">${contact.map(c => `<li>${inline(c)}</li>`).join("")}</ul>` : ""}</aside><main>${head}${body}</main></div>`;
  }
  return `<div class="cvt cvt-${tpl === "modern" ? "modern" : "classic"} letter"><header><h1>${inline(meta.name)}</h1>
    ${contact.length ? `<p class="contact">${contact.map(inline).join(' <span class="sep">·</span> ')}</p>` : ""}</header>${head}${body}</div>`;
}

/** Count [placeholders] the AI left for the user to fill in. */
export const placeholders = md => (String(md || "").match(/\[[^\]\n]{2,80}\](?!\()/g) || []).length;
