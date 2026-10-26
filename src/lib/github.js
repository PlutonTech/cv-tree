// GitHub sign-in uses the OAuth device flow: no client secret and no server needed.
// The user approves on github.com with a short code; we poll until GitHub hands back a token.

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

export async function startDeviceFlow(clientId, includePrivate) {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: JSON_HEADERS,
    body: new URLSearchParams({ client_id: clientId, scope: includePrivate ? "repo read:user" : "read:user" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.device_code) {
    throw new Error(data.error === "device_flow_disabled"
      ? "Device flow is off for this OAuth app. Tick “Enable Device Flow” in its GitHub settings."
      : data.error_description || "GitHub didn't accept that client ID.");
  }
  return data; // { device_code, user_code, verification_uri, interval, expires_in }
}

export async function pollForToken(clientId, flow, signal) {
  let wait = (flow.interval || 5) * 1000;
  const deadline = Date.now() + (flow.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(wait, signal);
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: JSON_HEADERS,
      body: new URLSearchParams({ client_id: clientId, device_code: flow.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (data.access_token) return { token: data.access_token, scope: data.scope || "" };
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { wait += 5000; continue; }
    if (data.error === "access_denied") throw new Error("You cancelled the sign-in on GitHub.");
    if (data.error === "expired_token") break;
    throw new Error(data.error_description || "GitHub sign-in failed.");
  }
  throw new Error("The code expired. Click Connect GitHub to get a new one.");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Cancelled.")); }, { once: true });
  });
}

async function api(path, token, accept = "application/vnd.github+json") {
  const res = await fetch("https://api.github.com" + path, {
    headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: "Bearer " + token } : {}) },
  });
  if (res.status === 401) throw new Error("GitHub sign-in expired. Connect again.");
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") throw new Error("GitHub's hourly limit for signed-out requests is used up. Connect GitHub to raise it, or try later.");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
  return accept.includes("raw") ? res.text() : res.json();
}

export const getUser = token => api("/user", token);

/** Your own repos (public + private if allowed) when signed in, else a user's public repos. Forks and archives skipped. */
export async function listRepos({ token, login }) {
  const path = token ? "/user/repos?per_page=100&sort=pushed&affiliation=owner" : `/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&type=owner`;
  const repos = await api(path, token);
  if (!repos) throw new Error(`No GitHub user called “${login}”.`);
  return repos.filter(r => !r.fork && !r.archived).map(r => ({
    repoId: r.id, name: r.name, fullName: r.full_name, url: r.html_url, description: r.description || "",
    language: r.language || "", stars: r.stargazers_count, topics: r.topics || [], private: r.private, pushedAt: r.pushed_at,
  }));
}

export async function getReadme(fullName, token) {
  const text = await api(`/repos/${fullName}/readme`, token, "application/vnd.github.raw+json");
  return text ? text.slice(0, 20000) : "";
}

/** Fetch READMEs a few at a time, reporting progress. */
export async function withReadmes(repos, token, onProgress) {
  let done = 0;
  const out = new Array(repos.length);
  const queue = repos.map((r, i) => [r, i]);
  async function worker() {
    while (queue.length) {
      const [r, i] = queue.shift();
      out[i] = { ...r, readme: await getReadme(r.fullName, token).catch(() => "") };
      onProgress?.(++done, repos.length);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}
