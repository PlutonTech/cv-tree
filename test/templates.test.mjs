// Builds each template as a PDF in Node and reads the text back with pdf.js.
// Usage: node test/templates.test.mjs [outDir]  (writes the PDFs to outDir if given)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { renderPdf, parseCv, TEMPLATES, placeholders, renderLetterPdf } from "../src/lib/templates.js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const md = `# Ogemdi Ereama
ogemdi@example.com · Lagos, Nigeria · github.com/ogemdi
## Summary
Software engineer and **GIS specialist** who builds web mapping tools – fast, accessible, and “well tested”.
## Skills
React, TypeScript, Node.js, Python, QGIS, PostGIS, Docker
## Experience
### Frontend Engineer, Example Co (Jan 2023 – present)
- Built a component library used across 4 product teams
- Cut page load time from 3.1s to 1.4s [add % improvement]
### GIS Analyst, Example Maps (2021 – 2022)
- Built a web GIS reporting tool used by 3 regional offices
## Projects
### GeoReport
- Web GIS reporting tool for spatial analysis (React, Leaflet)
## Education
BSc Geography, University of Lagos, 2021
## Languages
English, Igbo`;

const cv = parseCv(md);
assert.equal(cv.name, "Ogemdi Ereama");
assert.equal(cv.sections.length, 6);
assert.equal(cv.sections[2].items[0].date, "Jan 2023 – present");
assert.equal(placeholders(md), 1);

for (const t of TEMPLATES) {
  const buf = renderPdf(md, t.id).output("arraybuffer");
  if (process.argv[2]) writeFileSync(`${process.argv[2]}/cv-${t.id}.pdf`, Buffer.from(buf));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items.map(i => i.str).join(" ");
  for (const s of ["Ogemdi Ereama", "Jan 2023 – present", "GIS specialist", "“well tested”", "Lagos, Nigeria", "Igbo"])
    assert.ok(text.includes(s), `${t.id}: missing ${s} in ${text.slice(0, 300)}`);
  console.log(t.id, "ok,", pdf.numPages, "page(s)");
}

const letter = `Dear Hiring Manager,

Acme's design system work caught my eye – I've spent two years building exactly that.

At Example Co I built a component library used across 4 product teams [add adoption figure].

I'd love to talk about how I can help.

Sincerely,
Ogemdi Ereama`;
const meta = { name: "Ogemdi Ereama", contact: ["ogemdi@example.com", "Lagos, Nigeria"], date: "24 October 2026", company: "Acme", role: "Senior Frontend Engineer" };
for (const t of TEMPLATES) {
  const buf = renderLetterPdf(letter, t.id, meta).output("arraybuffer");
  if (process.argv[2]) writeFileSync(`${process.argv[2]}/letter-${t.id}.pdf`, Buffer.from(buf));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items.map(i => i.str).join(" ");
  for (const s of ["Ogemdi Ereama", "24 October 2026", "Re: Senior Frontend Engineer", "Dear Hiring Manager,", "Sincerely,", "Acme's design system"])
    assert.ok(text.includes(s), `letter ${t.id}: missing ${s}`);
  console.log("letter", t.id, "ok");
}
