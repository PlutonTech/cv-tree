# CV Tree

A browser extension that keeps one CV per role, notices when you're on a job posting, and shows a button in the bottom-right corner with your best-matching CV. From there it can write a tailored CV with AI (free models through OpenRouter, or Claude), using your experience, your GitHub projects and your LinkedIn profile.

## Install (Chrome, Edge, Brave)

1. Build it once:
   ```
   npm install
   npm run build
   ```
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, and pick the `extension` folder.
3. The welcome page opens and walks you through adding CVs, the AI, and pinning CV Tree. With a CV Tree server configured (see **Going public**), the free AI works straight away; otherwise paste a free key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
4. Pin the CV Tree icon to the toolbar so you can open the widget on any page.

After changing anything in `src/`, run `npm run build` again and click the reload icon on the extension's card.

## How it works

| Where | What happens |
|---|---|
| Any job posting | The CV Tree button appears bottom-right with a score for your best CV. Click it for the quick menu: your top 3 CVs, **Rank with AI** for real scores and gaps, **Tailor best CV** or **Write a new CV**, then save, copy or download. |
| Toolbar icon | Opens the widget on the current page, even if it isn't detected as a job page (**Use this page anyway**). |
| **Full app** button | The full app: CV library, matching, profile, link hub, settings. Jobs you open from the widget come pre-filled. |
| Your LinkedIn profile | The widget offers **Import this profile**. The AI reads the roles, skills and education on the page and adds them to your profile. |

Job pages are recognised from the job data most career sites publish (schema.org `JobPosting`), from known boards (LinkedIn, Indeed, Greenhouse, Lever, Workday, Ashby, Workable, SmartRecruiters, Glassdoor, Wellfound, ZipRecruiter) and from a text check on other `/jobs` and `/careers` pages. Use **Don't show on this site** in the menu to hide it on a site.

## Uploading CVs and exporting PDFs

- **Add CV** takes a PDF or Word (.docx) file. The text is read in your browser (pdf.js and mammoth), headings and bullets are detected, and the original file is kept so you can download it again (files up to 5 MB). Old `.doc` files and scanned PDFs without selectable text can't be read; save them as .docx or a text PDF first.
- Uploaded CVs work everywhere a typed CV does: keyword matching, AI ranking, tailoring.
- On **Match a Job** you can upload the job description as a file too.
- Every CV opens in a preview with three templates: **Classic** (serif, centred, ruled sections), **Modern** (green accents, right-aligned dates) and **Sidebar** (two columns with a dark green sidebar). **Download PDF** builds a real PDF with selectable text, so applicant tracking systems can read it. It warns you first if the CV still has [placeholders] to fill in.
- **Format with AI** tidies a CV that came from a file (splits jobs, dates and bullets) without changing your wording.

## The quick menu

Click the CV Tree button (or the toolbar icon on any page) for three tabs:
- **This job**: the posting on the page, your best CVs for it, and buttons to tailor a CV or write a cover letter.
- **Match a job**: paste any job description to rank your CVs, wherever you are.
- **My CVs**: previews of every CV in its template. Click one to see it larger. **Attach to this page** fills the application's resume upload field, and you can also drag a CV straight onto a site's upload box. Uploaded CVs attach as your original file; others attach as a PDF in their template.

Attaching works on forms in the page itself. Some sites put the application form in a separate frame (Greenhouse embeds, for example); there, download the PDF and upload it.

## Cover letters

- Write one from **Match a Job** (the "Write a cover letter" link, or **Cover letter** on any ranked CV), from a CV you just tailored, or from the **Cover letter** button in the widget on a job posting.
- The AI writes from your profile and the CV you choose, with the same rule as CVs: no invented facts, gaps marked as [placeholders].
- Pick a tone (professional, warm, short and direct) and a length, change the CV it's based on, and click **Rewrite**.
- Letters are saved on the **Cover Letters** page and use the same three templates as CVs, so the letterhead matches the CV you send with it. Download as PDF or plain text.

## Going public

Everything a public release needs is in this repo. In order:

**1. Put the server online** (it serves the admin dashboard, the free AI and the privacy policy).
- **Render:** push this repo to GitHub, then on render.com choose **New › Blueprint** and pick the repo. `render.yaml` sets everything up, including a 1 GB disk for the database (disks need the Starter plan, about $7/month). Render asks you for `ADMIN_TOKEN`, `OPENROUTER_API_KEY`, `PUBLISHER_NAME` and `CONTACT_EMAIL`.
- **Anywhere else with Docker** (Fly.io, Railway, a VPS): `docker build -t cvtree-server server`, then run it with a volume at `/data` and the same environment variables (see `server/Dockerfile`).
- Check `https://your-server/health` returns `{"ok":true}`.

**2. Register a GitHub OAuth app once, for everyone** (makes Connect GitHub one click): [new OAuth app](https://github.com/settings/applications/new) › name "CV Tree", homepage and callback `https://github.com` › tick **Enable Device Flow** › Register › copy the **Client ID**. No secret is needed, and the Client ID isn't secret.

**3. Fill in `cvtree.config.json`:**
```json
{
  "serverUrl": "https://your-server.onrender.com",
  "analytics": true,
  "hostedAI": true,
  "ingestKey": "cvtree-ingest",
  "githubClientId": "Ov23li…",
  "publisherName": "Your name or company",
  "contactEmail": "you@example.com"
}
```
`analytics` and `hostedAI` switch those features off without removing the server. `ingestKey` must match the server's `INGEST_KEY`.

**4. Package:** bump `"version"` in `extension/manifest.json` for every release, then `npm run package`. It builds, lists anything still missing, and writes `dist/cv-tree-<version>.zip`.

**5. Publish:** on the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (US$5 one-time) upload the zip, then copy the listing, permission justifications and data-use answers from `store/LISTING.md`, and the screenshots and promo tile from `store/`. The privacy policy URL is `https://your-server/privacy`. Edge Add-ons (free) takes the same zip. Review usually takes a few days.

## The admin dashboard

Open **https://your-server/admin** and sign in with your `ADMIN_TOKEN` (locally: `$env:ADMIN_TOKEN="…"; npm run server` in PowerShell, then http://localhost:8787/admin).

It shows, for the last 7 / 30 / 90 days: active users today / 7 / 30 days, new installs, AI requests with success rate and speed, CVs sent out; the **free AI**: requests, people, money spent, today's spend against your cap, how often people hit their daily limit, heaviest users; active users and installs per day; feature use; how far new users get (installed › added a CV › matched › wrote › sent); AI usage by model and task; AI errors by code; job sites; where CVs come from; PDF templates; weekly retention; pages opened; versions and browsers; every client with a per-install timeline; recent activity; and a CSV export.

**Preview it with made-up data:** `npm run demo-data`, then run the server with `DB_PATH=server/demo.db`.

### Usage statistics

Anonymous events: event names (matched a job, downloaded a PDF, attached a CV…), counts and scores, AI task, model, response time and error code, job-site domains, template names, version, browser and language, under a random install ID. **Never sent:** CV or letter text, names, contact details, profile, job descriptions, API keys. The server doesn't store IP addresses, and it deletes usage events after 24 months and free-AI records after 12. Users choose on the welcome page and can change it in **Settings › Usage statistics** (turning it off deletes anything not yet sent). Builds without a `serverUrl` send nothing.

### Free hosted AI

With `OPENROUTER_API_KEY` set on the server (a normal OpenRouter API key with credits, not a management key), new users get AI with no setup: requests go through your server to OpenRouter on your key. You control the cost:

| Server env var | Default | What it does |
|---|---|---|
| `HOSTED_MODEL` | `anthropic/claude-haiku-5.5` | The model everyone gets (about $0.001 per CV). Users can't change it. |
| `HOSTED_DAILY_LIMIT` | 30 | Free requests per person per day. |
| `HOSTED_IP_DAILY_LIMIT` | 100 | Requests per network per day, against abuse. |
| `HOSTED_DAILY_BUDGET_USD` | 3 | Once today's total cost reaches this, the free AI pauses for everyone until midnight UTC. |

At the defaults, the worst case is about $90 a month. Users who add their own OpenRouter key use it instead, with no limits from you. The server streams answers straight through and stores only token counts and cost.

### Server environment variables

`ADMIN_TOKEN` (required, 12+ characters) · `PORT` (8787) · `DB_PATH` (server/cvtree-analytics.db) · `INGEST_KEY` (cvtree-ingest) · `PUBLISHER_NAME` and `CONTACT_EMAIL` (shown on the privacy policy) · `OPENROUTER_API_KEY` and the `HOSTED_*` limits above.

## Connecting GitHub

**Connect GitHub** uses GitHub's device sign-in: you get a short code, approve it on github.com, and CV Tree imports your repositories and their READMEs. Public releases have a Client ID built in (step 2 of **Going public**), so it's one click. Builds without one ask the user to register their own app:

1. [Register a new OAuth app](https://github.com/settings/applications/new). Use `https://github.com` for the homepage and callback URL.
2. Tick **Enable Device Flow**, register, and copy the **Client ID** (no secret needed).
3. Paste it when CV Tree asks. Tick **Include private repositories** if you want those too.

If you don't want to sign in, **Or import public repos without signing in** works with just a username (GitHub limits this to 60 requests an hour).

## Connecting LinkedIn

LinkedIn's sign-in for outside apps only shares your name, email and photo, not your experience. So **Connect LinkedIn** opens your own profile instead, and the widget there reads what's on the page. For every role, click "Show all experiences" on LinkedIn and import from that page too.

## Privacy and cost

- Everything (CVs, profile, settings, API key, GitHub sign-in) is stored in this browser only, in the extension's local storage.
- AI requests are sent only when you click an AI action. The job description, your CVs and your profile are sent to the AI you use.
- **CV Tree free AI (default when the build has a server):** requests go through the CV Tree server to OpenRouter (Claude Haiku), with a daily allowance. The server doesn't store the text.
- **Your own OpenRouter key:** `openrouter/free` routes each request to whichever free model is available, so it costs nothing. Free models have a daily request limit, and their providers may log prompts. If you see a privacy error, allow free model providers at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy). You can pick a specific free model, or type any paid model ID if you add credits.
- **Anthropic:** uses the Claude API with your own key (Opus 5.5 by default). Requests on Opus and Sonnet set `fallbacks: "default"`, so a request Claude's safety filters wrongly decline is re-run on a fallback model.
- To show the button on job sites, the extension asks for permission to read pages you visit. It only reads the page to check for a job posting, and it sends nothing anywhere unless you click an AI action.

## Project layout

```
src/background.js     AI calls (OpenRouter, or Anthropic via its SDK), downloads, toolbar button
src/content.js        the floating widget (shadow DOM, so sites can't restyle it)
src/app.js            the full app
src/lib/jobs.js       job-posting detection and extraction
src/lib/match.js      keyword scoring, prompts, JSON schemas, Markdown renderer
src/lib/github.js     GitHub device sign-in, repos, READMEs
src/lib/store.js      chrome.storage helpers and the activity log
src/lib/icons.js      line icons and the CV Tree logo
src/lib/files.js      reads PDF / Word / text uploads into CV text
src/lib/cvhtml.js     CV and letter parsing and HTML previews (also used by the widget)
src/lib/templates.js  PDF export for the three templates
src/lib/analytics.js  anonymous usage events
src/lib/config.js     build-time settings from cvtree.config.json
src/pdfgen.js         PDF builder the widget loads only when needed
test/                 npm test: AI calls (your key and the free AI) against fake servers, and PDF export
server/               server.mjs (stats, dashboard, privacy page), hosted-ai.mjs (free AI), db.mjs, dashboard.html,
                      privacy.html, seed-demo.mjs, Dockerfile
scripts/package.mjs   npm run package: build, check and zip for the store
store/                Web Store screenshots, promo tile and LISTING.md (copy-paste listing text)
render.yaml           one-click Render deployment of the server
cvtree.config.json    server address, GitHub Client ID, publisher details
extension/            what you load in the browser (manifest, app.html, app.css, built JS, icons)
```
