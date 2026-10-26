# Chrome Web Store listing: copy and paste

Fill these into the Chrome Web Store Developer Dashboard (and Edge Add-ons, which asks for the same things).

## Store listing tab

**Name:** CV Tree

**Summary** (132 characters max):
> Find your best CV for any job, tailor it with AI, write the cover letter, and attach it to the application, right on the job page.

**Category:** Workflow & Planning (or Productivity)

**Description:**

> Applying for different kinds of roles means juggling different CVs. CV Tree keeps them in one place and picks the right one for every job.
>
> **On any job posting** (LinkedIn, Indeed, Greenhouse, Lever, Workday, Ashby, Glassdoor and more), a small CV Tree button appears in the corner with a match score for your best CV. Click it to:
> • See which of your CVs fits best, with what fits and what's missing
> • Tailor your best CV to the job, or write a new one, with AI
> • Write a matching cover letter
> • Attach your CV to the application form in one click, or drag it onto the upload box
>
> **In the full app:**
> • Upload your CVs as PDF or Word files, one per role
> • Download polished PDFs in three templates (Classic, Modern, Sidebar), with real text that applicant tracking systems can read
> • Keep cover letters for every job, in the same templates as your CVs
> • Connect GitHub and LinkedIn so tailored CVs mention your real projects and roles
> • Share all your CVs as a Linktree-style page
>
> **Free AI included.** Matching, tailoring and cover letters work straight away with a daily free allowance. For unlimited use, add your own free OpenRouter key.
>
> **Private by design.** Your CVs, letters and profile stay in your browser. Text is sent to the AI only when you click an AI button, and the AI never invents facts about you: anything it doesn't know is left as a highlighted [placeholder] for you to fill in.

**Screenshots** (1280×800, in this order): `screenshot-1-widget.png`, `screenshot-2-match.png`, `screenshot-3-templates.png`, `screenshot-4-cover-letter.png`, `screenshot-6-attach.png`, `screenshot-5-dashboard.png`

**Small promo tile** (440×280): `promo-tile-440x280.png`

**Icon:** `extension/icons/icon128.png`

## Privacy tab

**Single purpose:**
> CV Tree helps job seekers choose, tailor and send the right CV and cover letter for each job posting.

**Permission justifications:**

| Permission | Justification |
|---|---|
| Host access to all websites (content script) | To detect job postings on any careers site and show the CV Tree button there, and to attach a CV to the application form when the user asks. Job pages are recognised on the user's device; nothing is sent unless the user clicks an AI action. |
| storage, unlimitedStorage | CVs (including uploaded PDF/Word files), cover letters and the profile are stored locally in the browser. Uploaded files can exceed the default storage quota. |
| downloads | To save CVs and cover letters the user exports as PDF or text. |
| alarms | To send anonymous usage statistics in small batches every few minutes instead of on every action. |
| Host access to openrouter.ai, api.anthropic.com | To run AI requests when the user has added their own OpenRouter or Anthropic key. |
| Host access to github.com, api.github.com | To sign in with GitHub and read the user's repositories and READMEs when they choose to connect GitHub. |

**Remote code:** No. All code is included in the package.

**Data usage** (tick these):
- **Personally identifiable information:** yes. CV content includes name and contact details. It's stored locally; it's sent to the AI provider only when the user runs an AI action.
- **Website content:** yes. The text of job postings, and the LinkedIn profile page when the user imports it, is sent to the AI provider only when the user runs an AI action.
- **User activity:** yes. Anonymous usage statistics (feature use, under a random ID); the user can turn them off.
- **Authentication information:** yes. API keys and the GitHub token are stored locally and sent only to their own service.

Certify all three statements: not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

**Privacy policy URL:** `https://<your server>/privacy`
