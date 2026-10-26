// PDF export for CVs and cover letters, with real, selectable text (readable by applicant tracking systems).
// Layout rules mirror the HTML previews in cvhtml.js.
import { jsPDF } from "jspdf";
import { parseCv, contactParts, sideItems, SIDE_SECTIONS, strip, paragraphs } from "./cvhtml.js";

export * from "./cvhtml.js";

/* ---------- PDF ---------- */
const A4 = { w: 595.28, h: 841.89 };
const WIN_ANSI = /[^\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g;
// The built-in PDF fonts only cover Western European characters: map the common extras, drop the rest.
const pdfText = s => strip(s).replace(/[‐‑‒−]/g, "-").replace(/·/g, "·").replace(/[→➔]/g, "->").replace(/≥/g, ">=").replace(WIN_ANSI, "");

class Flow {
  constructor(doc, { x, w, top, bottom, startY, onNewPage }) {
    Object.assign(this, { doc, x, w, top, bottom, onNewPage });
    this.y = startY ?? top;
  }
  need(h) {
    if (this.y + h <= this.bottom) return;
    this.doc.addPage();
    this.onNewPage?.();
    this.y = this.top;
  }
  font({ font = "helvetica", style = "normal", size = 10, color = "#222222", charSpace = 0 }) {
    const d = this.doc;
    d.setFont(font, style); d.setFontSize(size); d.setTextColor(color); d.setCharSpace(charSpace);
  }
  text(str, o = {}) {
    const { size = 10, lh = 1.38, indent = 0, align = "left", bullet = null, upper = false, maxLines = Infinity } = o;
    this.font(o);
    const t = pdfText(str);
    const lines = this.doc.splitTextToSize(upper ? t.toUpperCase() : t, this.w - indent - (bullet ? 11 : 0)).slice(0, maxLines);
    lines.forEach((ln, i) => {
      this.need(size * lh);
      const base = this.y + size * 0.86;
      if (bullet && i === 0) { this.doc.text(bullet, this.x + indent, base); }
      const tx = align === "center" ? this.x + this.w / 2 : align === "right" ? this.x + this.w : this.x + indent + (bullet ? 11 : 0);
      this.doc.text(ln, tx, base, { align });
      this.y += size * lh;
    });
    this.doc.setCharSpace(0);
  }
  rule(color, width = 0.6, len = this.w, x = this.x) {
    this.doc.setDrawColor(color); this.doc.setLineWidth(width); this.doc.line(x, this.y, x + len, this.y);
  }
  gap(h) { this.y += h; }
}

/** Entry heading: title on the left, date on the right (date may push the title to wrap). */
function entryHead(f, e, { font, size, color, dateColor, dateStyle = "normal" }) {
  const d = f.doc;
  f.font({ font, style: dateStyle, size: size - 1 });
  const date = pdfText(e.date), dw = date ? d.getTextWidth(date) + 12 : 0;
  f.font({ font, style: "bold", size, color });
  const lines = d.splitTextToSize(pdfText(e.title), f.w - dw);
  f.need(size * 1.35 * Math.min(lines.length, 2) + 14);   // keep the heading with its first bullet
  lines.forEach((ln, i) => {
    const base = f.y + size * 0.86;
    f.font({ font, style: "bold", size, color });
    d.text(ln, f.x, base);
    if (i === 0 && date) { f.font({ font, style: dateStyle, size: size - 1, color: dateColor }); d.text(date, f.x + f.w, base, { align: "right" }); }
    f.y += size * 1.35;
  });
}

function itemsPdf(f, items, s) {
  for (const it of items) {
    if (it.type === "bullet") f.text(it.text, { ...s.body, bullet: "•", indent: 4 });
    else if (it.type === "p") f.text(it.text, s.body);
    else {
      f.gap(s.entryGap);
      entryHead(f, it, s.entry);
      f.gap(1.5);
      itemsPdf(f, it.lines, s);
    }
  }
}

const STYLES = {
  classic: {
    font: "times", ink: "#1b1b1b", muted: "#555555",
    body: { font: "times", size: 10.5, color: "#1b1b1b" },
    entry: { font: "times", size: 11, color: "#111111", dateColor: "#444444", dateStyle: "italic" },
    entryGap: 6,
  },
  modern: {
    font: "helvetica", ink: "#1F2A27", muted: "#6B7A74", accent: "#0E7A55",
    body: { font: "helvetica", size: 9.8, color: "#2B3532", lh: 1.42 },
    entry: { font: "helvetica", size: 10.6, color: "#13201C", dateColor: "#6B7A74" },
    entryGap: 7,
  },
  sidebar: {
    font: "helvetica", ink: "#1F2A27", muted: "#6B7A74", accent: "#0E7A55", side: "#123B2E",
    body: { font: "helvetica", size: 9.8, color: "#2B3532", lh: 1.42 },
    entry: { font: "helvetica", size: 10.6, color: "#13201C", dateColor: "#6B7A74" },
    entryGap: 7,
  },
};

export function renderPdf(md, tpl = "modern") {
  const cv = parseCv(md);
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setProperties({ title: cv.name ? `${pdfText(cv.name)} - CV` : "CV", creator: "CV Tree" });
  const s = STYLES[tpl] || STYLES.modern;

  if (tpl === "sidebar") {
    const SW = 186;
    const paintSide = () => { doc.setFillColor(s.side); doc.rect(0, 0, SW, A4.h, "F"); };
    paintSide();
    const side = cv.sections.filter(x => SIDE_SECTIONS.test(x.title));
    const main = cv.sections.filter(x => !side.includes(x));
    const sf = new Flow(doc, { x: 24, w: SW - 46, top: 48, bottom: A4.h - 40 });
    sf.need = () => {};                                     // the sidebar never starts a page of its own
    sf.text(cv.name, { font: "helvetica", style: "bold", size: 19, color: "#FFFFFF", lh: 1.15 });
    sf.gap(10);
    for (const c of contactParts(cv)) sf.text(c, { size: 8.6, color: "#D3EADF", lh: 1.4 }), sf.gap(2);
    for (const sec of side) {
      if (sf.y > A4.h - 80) break;
      sf.gap(16);
      sf.text(sec.title, { style: "bold", size: 8.6, color: "#9FE0C2", charSpace: 1.1, upper: true });
      sf.gap(4);
      for (const it of sideItems(sec.items)) {
        if (sf.y > A4.h - 50) break;
        if (it.type === "entry") { sf.text(it.title, { style: "bold", size: 8.8, color: "#FFFFFF" }); for (const l of it.lines) sf.text(l.text, { size: 8.4, color: "#D3EADF" }); }
        else sf.text(it.text, { size: 8.8, color: "#EAF6F0", lh: 1.5 });
      }
    }
    const f = new Flow(doc, { x: SW + 30, w: A4.w - SW - 30 - 40, top: 44, bottom: A4.h - 44, startY: 48, onNewPage: paintSide });
    main.forEach((sec, i) => {
      if (i) f.gap(14);
      if (sec.title) {
        f.need(48);
        f.text(sec.title, { style: "bold", size: 12.5, color: s.side, lh: 1.2 });
        f.gap(3); f.rule(s.accent, 2, 26); f.gap(9);
      }
      itemsPdf(f, sec.items, s);
    });
    return doc;
  }

  const M = tpl === "classic" ? 56 : 52;
  const f = new Flow(doc, { x: M, w: A4.w - 2 * M, top: 50, bottom: A4.h - 50 });
  pdfHeader(f, tpl, s, cv.name, contactParts(cv));
  cv.sections.forEach(sec => {
    f.gap(tpl === "classic" ? 12 : 13);
    if (sec.title) {
      f.need(46);
      if (tpl === "classic") {
        f.text(sec.title, { font: "times", style: "bold", size: 11.5, color: s.ink, charSpace: 1.4, upper: true, lh: 1.2 });
        f.gap(2); f.rule("#1b1b1b", 0.7); f.gap(6);
      } else {
        doc.setFillColor(s.accent); doc.rect(f.x, f.y + 2.4, 5, 5, "F");
        f.text(sec.title, { font: "helvetica", style: "bold", size: 10, color: s.accent, charSpace: 1.2, upper: true, indent: 12, lh: 1.25 });
        f.gap(5);
      }
    }
    itemsPdf(f, sec.items, s);
  });
  return doc;
}

/** Name and contact block shared by CVs and cover letters (Classic and Modern). */
function pdfHeader(f, tpl, s, name, contactList) {
  const contact = contactList.join("  ·  ");
  if (tpl === "classic") {
    f.text(name, { font: "times", style: "bold", size: 24, color: s.ink, align: "center", lh: 1.2 });
    f.gap(2);
    if (contact) f.text(contact, { font: "times", size: 10, color: s.muted, align: "center" });
    f.gap(6);
  } else {
    f.text(name, { font: "helvetica", style: "bold", size: 25, color: s.accent, lh: 1.15 });
    f.gap(3);
    if (contact) f.text(contact, { font: "helvetica", size: 9.3, color: s.muted });
    f.gap(8); f.rule(s.accent, 1.6); f.gap(6);
  }
}

/* ---------- cover letters: same three looks, so a letter matches the CV sent with it ---------- */
export function renderLetterPdf(text, tpl, meta) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setProperties({ title: `${pdfText(meta.name)} - Cover letter`, creator: "CV Tree" });
  const s = STYLES[tpl] || STYLES.modern;
  const contact = meta.contact || [];
  let f;
  if (tpl === "sidebar") {
    const SW = 186;
    const paintSide = () => { doc.setFillColor(s.side); doc.rect(0, 0, SW, A4.h, "F"); };
    paintSide();
    const sf = new Flow(doc, { x: 24, w: SW - 46, top: 48, bottom: A4.h - 40 });
    sf.text(meta.name, { font: "helvetica", style: "bold", size: 19, color: "#FFFFFF", lh: 1.15 });
    sf.gap(10);
    for (const c of contact) { sf.text(c, { size: 8.6, color: "#D3EADF", lh: 1.4 }); sf.gap(2); }
    f = new Flow(doc, { x: SW + 36, w: A4.w - SW - 36 - 48, top: 56, bottom: A4.h - 56, startY: 64, onNewPage: paintSide });
  } else {
    const M = tpl === "classic" ? 64 : 60;
    f = new Flow(doc, { x: M, w: A4.w - 2 * M, top: 56, bottom: A4.h - 56 });
    pdfHeader(f, tpl, s, meta.name, contact);
    f.gap(22);
  }
  const body = { font: s.font, size: tpl === "classic" ? 11.5 : 10.6, color: s.ink, lh: 1.55 };
  f.text(meta.date, { ...body, color: s.muted }); f.gap(12);
  if (meta.company) { f.text("Hiring Team", body); f.text(meta.company, body); f.gap(12); }
  if (meta.role) { f.text(`Re: ${meta.role}`, { ...body, style: "bold" }); f.gap(12); }
  for (const p of paragraphs(text)) { for (const line of p) f.text(line, body); f.gap(9); }
  return doc;
}
