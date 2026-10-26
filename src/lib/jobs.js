// Decides whether the current page is a job posting and pulls out title, company and description.
// Order: schema.org JobPosting data (most career sites publish it) → known job boards → a text heuristic.

const SITES = [
  { host: /(^|\.)linkedin\.com$/, path: /^\/jobs\//,
    title: [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", ".t-24.t-bold", "h1"],
    company: [".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name"],
    desc: [".jobs-description__content", ".jobs-box__html-content", "#job-details", ".jobs-description"] },
  { host: /(^|\.)indeed\.[a-z.]+$/,
    title: ["[data-testid=jobsearch-JobInfoHeader-title]", "h1.jobsearch-JobInfoHeader-title", "h1"],
    company: ["[data-testid=inlineHeader-companyName]", "[data-company-name]"],
    desc: ["#jobDescriptionText"] },
  { host: /greenhouse\.io$/, title: [".job__title h1", ".app-title", "h1"], company: [".company-name"], desc: [".job__description", "#content", ".job-post"] },
  { host: /lever\.co$/, title: [".posting-headline h2", "h2"], desc: ["[data-qa=job-description]", ".posting-page .section-wrapper", ".content"] },
  { host: /(myworkdayjobs|workday)\.com$/, title: ["[data-automation-id=jobPostingHeader]", "h2", "h1"], desc: ["[data-automation-id=jobPostingDescription]"] },
  { host: /ashbyhq\.com$/, title: ["h1"], desc: ["[class*=_descriptionText]", "[class*=description]"] },
  { host: /workable\.com$/, title: ["h1"], desc: ["[data-ui=job-description]", "main"] },
  { host: /smartrecruiters\.com$/, title: ["h1"], company: [".company-name"], desc: [".job-sections", "[itemprop=description]"] },
  { host: /glassdoor\.[a-z.]+$/, title: ["h1"], desc: ["[class*=JobDetails_jobDescription]", "#JobDescriptionContainer"] },
  { host: /wellfound\.com$/, title: ["h1"], desc: ["[class*=description]"] },
  { host: /ziprecruiter\.com$/, title: ["h1"], desc: [".job_description", "[class*=job_description]"] },
  { host: /(^|\.)(jobs|careers)\.|recruitee\.com$|bamboohr\.com$|teamtailor\.com$|personio\.[a-z]+$|breezy\.hr$|jobvite\.com$|icims\.com$|remoteok\.com$|weworkremotely\.com$/ },
];

const CUES = ["responsibilities", "requirements", "qualifications", "what you'll do", "what you will do", "about the role",
  "you will", "we're looking for", "we are looking for", "nice to have", "benefits", "apply now", "job description", "experience with"];

const clean = s => String(s || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const textOf = el => clean(el?.innerText || el?.textContent || "");
const first = sels => { for (const s of sels || []) { const el = document.querySelector(s); if (el && textOf(el)) return el; } return null; };
const htmlToText = html => { const d = document.createElement("div"); d.innerHTML = String(html || "").replace(/<(br|\/p|\/li|\/h\d)>/gi, "\n$&"); return clean(d.textContent); };

function fromJsonLd() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data; try { data = JSON.parse(s.textContent); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n)) { stack.push(...n); continue; }
      const t = [].concat(n["@type"] || []);
      if (t.includes("JobPosting")) {
        const org = n.hiringOrganization;
        return { title: clean(n.title), company: clean(typeof org === "string" ? org : org?.name), description: htmlToText(n.description), source: "structured data" };
      }
      if (n["@graph"]) stack.push(n["@graph"]);
    }
  }
  return null;
}

function cueCount(text) { const t = text.toLowerCase(); return CUES.filter(c => t.includes(c)).length; }

function bestBlock() {
  let best = null;
  for (const el of document.querySelectorAll("main, article, section, [class*=description], [id*=description], [class*=job], [id*=job]")) {
    const t = textOf(el);
    if (t.length < 500 || t.length > 25000) continue;
    const cues = cueCount(t);
    if (cues < 2) continue;
    // prefer the tightest block that still carries the cues
    const score = cues * 1000 - t.length / 20;
    if (!best || score > best.score) best = { el, score };
  }
  return best?.el || null;
}

export function detectJob() {
  const host = location.hostname, url = location.href;
  const site = SITES.find(s => s.host.test(host) && (!s.path || s.path.test(location.pathname)));
  const ld = fromJsonLd();
  let job = null;

  if (ld && ld.description.length > 200) job = ld;
  if (!job && site?.desc) {
    const d = first(site.desc);
    if (d && textOf(d).length > 200) job = { title: textOf(first(site.title)), company: textOf(first(site.company)), description: textOf(d), source: "job board" };
  }
  const looksLikeJobUrl = /job|career|position|vacanc|opening|posting|apply|recruit/i.test(host + location.pathname);
  if (!job && (site || looksLikeJobUrl)) {
    const d = bestBlock();
    if (d) job = { title: textOf(document.querySelector("h1")) || document.title, company: "", description: textOf(d), source: "page text" };
  }
  if (!job) return null;
  // LinkedIn and Indeed show a search list beside the posting: make sure the title isn't the page's generic h1.
  job.title = (job.title || document.title).split("\n")[0].slice(0, 140);
  job.company = (job.company || "").split("\n")[0].slice(0, 100);
  job.description = job.description.slice(0, 20000);
  job.url = url;
  job.host = host.replace(/^www\./, "");
  return job;
}

export function isLinkedInProfile() {
  return /(^|\.)linkedin\.com$/.test(location.hostname) && /^\/in\/[^/]+/.test(location.pathname);
}

export function linkedInPageText() {
  return textOf(document.querySelector("main") || document.body).slice(0, 60000);
}
