// Matching helpers shared by the widget, the full app and the background worker.

export const splitList = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

const STOP = new Set(("the and for with you your our are will have has this that from about into who what all can job role work team " +
  "years experience we to of in a an on or as is be at by it us they their them more other such well also using use including").split(" "));

function tokens(s) {
  return new Set((String(s).toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) || []).map(w => w.replace(/\.$/, "")).filter(w => !STOP.has(w)));
}

/** Free, instant keyword overlap. Good enough for a badge; Claude does the real ranking. */
export function localRank(jd, cvs) {
  const j = tokens(jd);
  return cvs.map(cv => {
    const c = tokens(`${cv.title} ${cv.roles} ${cv.body}`);
    const hit = [...j].filter(w => c.has(w));
    const score = Math.round(Math.min(100, (hit.length / Math.max(8, Math.min(j.size, 60))) * 140));
    return { id: cv.id, score, fits: [hit.length ? "Shares: " + hit.slice(0, 8).join(", ") : "Few shared terms."], gaps: [],
      action: score >= 80 ? "send" : score >= 55 ? "tailor" : "generate" };
  }).sort((a, b) => b.score - a.score);
}

export const RANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["role", "company", "mustHaves", "ranking", "recommendation", "advice"],
  properties: {
    role: { type: "string" },
    company: { type: "string" },
    mustHaves: { type: "array", items: { type: "string" } },
    ranking: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "score", "fits", "gaps", "action"],
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          fits: { type: "array", items: { type: "string" } },
          gaps: { type: "array", items: { type: "string" } },
          action: { type: "string", enum: ["send", "tailor", "generate"] },
        },
      },
    },
    recommendation: { type: "string", enum: ["send", "tailor", "generate"] },
    advice: { type: "string" },
  },
};

export function rankPrompt(job, cvs) {
  const block = cvs.map(cv => `<cv id="${cv.id}">\nName: ${cv.title}\nTargets: ${cv.roles}\n${cv.body}\n</cv>`).join("\n\n");
  return `You help a job seeker decide which of their saved CVs to send for a job.
Score every CV from 0 to 100 for fit with the job as written: skills, seniority, domain, and the evidence the CV actually shows. Be strict: 85+ means ready to send as is.
Give "role" as the short job title and "company" as the employer ("" if unknown). List up to 6 "mustHaves" from the posting.
For each CV give up to 3 short "fits" (why it fits, a few words each, e.g. "Strong React and TypeScript experience"), up to 4 short "gaps" (requirements the CV doesn't show), and an "action": "send" if it scores 80+, "tailor" for 55-79, otherwise "generate".
"recommendation" is the action for the best CV. "advice" is one or two plain sentences on what to do next.

<job title="${job.title || ""}" company="${job.company || ""}">
${job.description}
</job>

<cvs>
${block}
</cvs>`;
}

export function profileBlock(p) {
  const projects = (p.projects || []).filter(x => x.include !== false).map(x =>
    `<project name="${x.name}" link="${x.url || ""}"${x.language ? ` language="${x.language}"` : ""}>\n${x.description ? x.description + "\n" : ""}${String(x.readme || "").slice(0, 5000)}\n</project>`).join("\n");
  return `Name: ${p.name}
Headline: ${p.headline}
Contact: ${p.contact}
Skills: ${p.skills}

Experience:
${p.experience}

Education:
${p.education}

LinkedIn profile text:
${p.liText}

Projects:
${projects}`;
}

export function generatePrompt(job, profile, base) {
  return `Write a one-to-two page CV in Markdown for the candidate below, tailored to the job posting.
Rules:
- Use only facts found in the candidate material. Never invent employers, dates, titles, degrees, numbers or tools.
- Where a strong CV would want a detail the material lacks (a metric, a date), write a placeholder in square brackets, like [add % improvement].
- Lead with the experience and projects most relevant to this job, and use the posting's key terms where the candidate really has them.
- Pick the 2-4 most relevant projects and say what was built, with what, and the result.
- Format: "# Name" on the first line, then the contact line, then "## " sections: Summary, Skills, Experience, Projects, Education. Use "### Role, Company (dates)" for each job and "- " bullets. No tables. No commentary before or after the CV.
${base ? `\nStart from this existing CV and adapt it:\n<base_cv>\n${base.body}\n</base_cv>\n` : ""}
<candidate>
${profileBlock(profile)}
</candidate>

<job title="${job.title || ""}" company="${job.company || ""}">
${job.description}
</job>`;
}

export function formatPrompt(text) {
  return `This CV text was extracted from a PDF or Word file, so its layout is lost. Rewrite it as Markdown with this exact structure, keeping every fact and the person's own wording:
- "# Full Name" on the first line, then one line of contact details separated by " · ".
- "## " section headings (e.g. Summary, Skills, Experience, Projects, Education, Certifications, Languages).
- "### Role, Company (dates)" for each job or project, followed by "- " bullets.
- Skills as one comma-separated line.
Do not add, remove, invent or reword content. Only fix broken line wraps, stray symbols and page numbers. Output the Markdown only.

<cv>
${text}
</cv>`;
}

const TONES = {
  professional: "confident and professional",
  warm: "warm and enthusiastic, while staying professional",
  concise: "direct and to the point, with no filler",
};
const LENGTHS = { short: "about 180 words", standard: "about 280 words", long: "about 380 words" };

export function letterPrompt(job, profile, cv, { tone = "professional", length = "standard" } = {}) {
  return `Write a cover letter for the candidate below, applying for this job. Tone: ${TONES[tone] || TONES.professional}. Length: ${LENGTHS[length] || LENGTHS.standard}.
Rules:
- Use only facts from the candidate material${cv ? " and CV" : ""}. Never invent employers, numbers, tools, degrees or reasons. Where a strong letter needs a detail you don't have, write a placeholder in square brackets, like [why this company appeals to you].
- Open with a specific hook about this role, not "I am writing to apply". Connect 2-3 of the candidate's most relevant achievements to the job's key requirements, using the posting's own terms where the candidate truly has them. Close with a short, polite call to action.
- Begin with "Dear Hiring Manager," (or the hiring manager's name if the posting gives one) and end with "Sincerely," and the candidate's name on the next line.
- Plain text paragraphs separated by blank lines. No address block, no date, no subject line, no Markdown, no notes before or after the letter.
${cv ? `\n<cv title="${cv.title}">\n${cv.body}\n</cv>\n` : ""}
<candidate>
${profileBlock(profile)}
</candidate>

<job title="${job.title || ""}" company="${job.company || ""}">
${job.description}
</job>`;
}

export const LINKEDIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "headline", "skills", "experience", "education"],
  properties: {
    name: { type: "string" },
    headline: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    experience: { type: "string" },
    education: { type: "string" },
  },
};

export function linkedinPrompt(pageText) {
  return `This is the visible text of a LinkedIn profile page, copied from the browser. Pull out the person's details.
- "experience": every role as plain text, one block per role: "Title, Company (start – end)" then "- " bullets of what they did, copied faithfully. Skip roles you can't see.
- "skills": individual skills and tools, deduplicated.
- "education": one line per degree or certification.
Ignore navigation, ads, "People also viewed" and other people's names. Use "" or [] for anything not on the page.

<page>
${pageText}
</page>`;
}

/* ---------- small, safe Markdown renderer for CV previews ---------- */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]{2,80})\](?!\()/g, '<span class="todo">[$1]</span>');
}

export function md(src) {
  const out = []; let list = false;
  for (const raw of String(src || "").split(/\r?\n/)) {
    const l = raw.trimEnd(); let m;
    if (!/^\s*[-*•]\s+/.test(l) && list) { out.push("</ul>"); list = false; }
    if (!l.trim()) continue;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(m[1])}</li>`); }
    else out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

export const slug = s => String(s || "cv").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "cv";
