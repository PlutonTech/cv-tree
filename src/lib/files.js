// Turns an uploaded CV or job description (PDF, Word .docx, text) into plain text, in the browser.
import * as pdfjs from "pdfjs-dist";
import mammoth from "mammoth/mammoth.browser.js";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");

export const ACCEPT = ".pdf,.docx,.doc,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";
const MAX_BYTES = 15 * 1024 * 1024;

export function kindOf(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".doc")) return "doc";
  if (/\.(txt|md|markdown)$/.test(n) || file.type.startsWith("text/")) return "text";
  return "unknown";
}

/** @returns {Promise<{text: string, kind: string, pages?: number}>} */
export async function extractText(file) {
  if (file.size > MAX_BYTES) throw new Error("That file is over 15 MB. Try a smaller export of your CV.");
  const kind = kindOf(file);
  if (kind === "doc") throw new Error("Old Word .doc files can't be read in the browser. In Word, use File › Save As › .docx or PDF, then upload that.");
  if (kind === "unknown") throw new Error("Upload a PDF, a Word .docx file, or a text file.");
  if (kind === "text") return { text: structureText(tidy(await file.text())), kind };
  const buf = await file.arrayBuffer();
  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    const text = structureText(tidy(value));
    if (!text) throw new Error("That Word file has no text in it.");
    return { text, kind };
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let out = "", lastY = null;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2 && !out.endsWith("\n")) out += "\n";
      out += item.str;
      if (item.hasEOL) out += "\n";
      lastY = y;
    }
    pages.push(out);
  }
  await task.destroy();
  const text = structureText(tidy(pages.join("\n\n")));
  if (text.length < 40) throw new Error("This PDF has no selectable text (it's probably a scanned image). Upload the original Word file, or paste the text.");
  return { text, kind, pages: pages.length };
}

function tidy(s) {
  return String(s || "")
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\b(?:[A-Za-z] ){3,}[A-Za-z]\b/g, m => m.replace(/ /g, ""))   // "S U M M A R Y" from letter-spaced headings
    .trim();
}

const SECTION = /^(professional |career |personal |technical |core |key )?(summary|profile|about me|about|objective|experience|work experience|work history|employment|employment history|projects?|skills|education|certifications?|licen[cs]es|languages|awards|achievements|interests|volunteering|publications|references|tools|training)$/i;

/** Mark headings and bullets in plain CV text so templates can lay it out. Leaves Markdown alone. */
export function structureText(text) {
  if (/^#{1,3}\s/m.test(text)) return text;
  const out = [];
  let named = false, headings = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) { out.push(""); continue; }
    if (!named) { out.push("# " + t); named = true; continue; }
    const bare = t.replace(/:$/, "");
    const letters = bare.replace(/[^A-Za-z]/g, "");
    const caps = letters.length >= 4 && bare === bare.toUpperCase() && !/[.@,|]/.test(bare) && bare.split(/\s+/).length <= 4;
    if (bare.length <= 40 && (SECTION.test(bare) || caps)) {
      out.push("", "## " + bare.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()));
      headings++;
      continue;
    }
    const b = t.match(/^[•▪●◦‣·*\-–]\s*(.+)/);
    out.push(b ? "- " + b[1] : t);
  }
  return headings ? out.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
}

export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
