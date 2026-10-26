// Everything lives in chrome.storage.local on this device. Nothing is sent anywhere
// except the job + profile text that goes to Claude when you ask for a match or a CV.

import { hostedAIConfigured } from "./config.js";

export const EMPTY_PROFILE = {
  name: "", headline: "", contact: "", skills: "", experience: "", education: "",
  liUrl: "", liText: "", projects: [],
};

export const DEFAULT_SETTINGS = {
  provider: "",                    // "cvtree" (free hosted AI), "openrouter" (your key) or "anthropic"; "" = automatic
  orKey: "",
  orModel: "openrouter/free",      // OpenRouter's router that picks an available free model
  apiKey: "",                      // Anthropic key
  model: "claude-opus-5-5",        // Anthropic model
  ghClientId: "",
  ghToken: "",
  ghLogin: "",
  ghScope: "",
  hiddenSites: [],
  showOnJobPages: true,
  theme: "system",
};

export async function load() {
  const r = await chrome.storage.local.get(["cvs", "letters", "profile", "settings", "currentJob", "activity", "activitySeen"]);
  return {
    cvs: r.cvs || [],
    letters: r.letters || [],
    profile: { ...EMPTY_PROFILE, ...(r.profile || {}) },
    settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}) },
    currentJob: r.currentJob || null,
    activity: r.activity || [],
    activitySeen: r.activitySeen || 0,
  };
}

/** The AI actually used: your own key when you've added one, otherwise CV Tree's free AI when this build has it. */
export function aiProvider(s) {
  const p = s.provider || (s.orKey || !hostedAIConfigured ? "openrouter" : "cvtree");
  if (p === "cvtree" && !hostedAIConfigured) return "openrouter";
  if (p === "openrouter" && !s.orKey && hostedAIConfigured) return "cvtree";
  return p;
}

/** True when AI features can run (free AI needs no key). */
export const hasAIKey = s => { const p = aiProvider(s); return p === "cvtree" || (p === "openrouter" ? !!s.orKey : !!s.apiKey); };

export const save = patch => chrome.storage.local.set(patch);

export async function saveSettings(patch) {
  const { settings } = await load();
  await save({ settings: { ...settings, ...patch } });
}

export async function upsertCv(cv) {
  const { cvs } = await load();
  const i = cvs.findIndex(c => c.id === cv.id);
  if (i >= 0) cvs[i] = cv; else cvs.push(cv);
  await save({ cvs });
  return cv;
}

export async function deleteCv(id) {
  const { cvs } = await load();
  await save({ cvs: cvs.filter(c => c.id !== id) });
}

export async function upsertLetter(letter) {
  const { letters = [] } = await chrome.storage.local.get("letters");
  const i = letters.findIndex(l => l.id === letter.id);
  if (i >= 0) letters[i] = letter; else letters.push(letter);
  await chrome.storage.local.set({ letters });
  return letter;
}

export async function deleteLetter(id) {
  const { letters = [] } = await chrome.storage.local.get("letters");
  await chrome.storage.local.set({ letters: letters.filter(l => l.id !== id) });
}

/** A short log of what happened (CVs saved, jobs matched, imports) for the notifications menu. */
export async function logActivity(text, kind = "info") {
  const { activity = [] } = await chrome.storage.local.get("activity");
  activity.unshift({ text, kind, at: Date.now() });
  await chrome.storage.local.set({ activity: activity.slice(0, 20) });
}

export function onChange(cb) {
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") cb(changes); });
}

export const uid = p => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
