// Build-time settings from cvtree.config.json (see README › Configuration).
/* global __CVTREE__ */
export const CONFIG = typeof __CVTREE__ === "object" ? __CVTREE__
  : { serverUrl: "", analytics: false, hostedAI: false, ingestKey: "", githubClientId: "" };

/** Your CV Tree server: usage stats, the free hosted AI and the privacy policy all live there. */
export const SERVER = String(CONFIG.serverUrl || "").replace(/\/$/, "");
export const analyticsConfigured = !!(SERVER && CONFIG.analytics);
export const hostedAIConfigured = !!(SERVER && CONFIG.hostedAI);
export const privacyUrl = SERVER ? SERVER + "/privacy" : "";
