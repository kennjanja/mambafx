// MambaFX backend: Deriv OAuth2 (PKCE) + session + Options account/OTP proxy.
// Access tokens live only in KV (binding SESSION); the browser only holds an opaque session cookie.

const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com";
const SCOPE = "trade";
const COOKIE = "mfx_session";
const STATE_TTL = 600;
const DEFAULT_SESSION_TTL = 3600;
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkceChallenge(verifier) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && origin === env.ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Credentials"] = "true";
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

function json(env, request, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(env, request), ...extra },
  });
}

function redirect(url, extra = {}) {
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", ...extra } });
}

function spaRedirect(env, params) {
  const u = new URL(env.SPA_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const sessionCookie = (id, maxAge) => `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;

function configError(env) {
  const missing = ["CLIENT_ID", "REDIRECT_URI", "SPA_URL", "ALLOWED_ORIGIN"].filter((k) => !env[k]);
  if (!env.SESSION) missing.push("SESSION");
  return missing.length ? missing : null;
}

// Browsers that partition third-party cookies (Firefox, Safari) drop the cookie on
// cross-site fetches, so the SPA also sends the opaque session id as a Bearer token.
function sessionIdFrom(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(auth);
  return m ? m[1] : getCookie(request, COOKIE);
}

async function loadSession(env, request) {
  const id = sessionIdFrom(request);
  if (!id || !/^[A-Za-z0-9_-]{20,100}$/.test(id)) return null;
  const raw = await env.SESSION.get("sess:" + id);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && s.access_token ? { id, ...s } : null;
  } catch {
    return null;
  }
}

function derivHeaders(env, token) {
  return { Authorization: `Bearer ${token}`, "Deriv-App-ID": env.CLIENT_ID, Accept: "application/json" };
}

async function authStart(env) {
  const state = randomId(24);
  const verifier = randomId(48);
  const challenge = await pkceChallenge(verifier);
  await env.SESSION.put("oauth:" + state, JSON.stringify({ verifier, t: Date.now() }), { expirationTtl: STATE_TTL });
  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.CLIENT_ID);
  u.searchParams.set("redirect_uri", env.REDIRECT_URI);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return redirect(u.toString());
}

async function authCallback(env, url) {
  const fail = (code) => redirect(spaRedirect(env, { login_error: code }));
  const q = url.searchParams;
  const state = q.get("state");
  // Consume state first so it cannot be replayed, whatever the outcome.
  let pending = null;
  if (state && /^[A-Za-z0-9_-]{10,100}$/.test(state)) {
    const raw = await env.SESSION.get("oauth:" + state);
    if (raw) {
      await env.SESSION.delete("oauth:" + state);
      try { pending = JSON.parse(raw); } catch { pending = null; }
    }
  }
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "access_denied" : "provider_error");
  const code = q.get("code");
  if (!code || !state) return fail("missing_params");
  if (!pending || !pending.verifier) return fail("invalid_state");

  let tok;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.CLIENT_ID,
        code,
        code_verifier: pending.verifier,
        redirect_uri: env.REDIRECT_URI,
      }).toString(),
    });
    if (!res.ok) return fail("token_exchange_failed");
    tok = await res.json();
  } catch {
    return fail("token_exchange_failed");
  }
  if (!tok || typeof tok.access_token !== "string" || !tok.access_token) return fail("token_exchange_failed");

  const ttl = Math.max(60, Math.min(Number(tok.expires_in) || DEFAULT_SESSION_TTL, 86400));
  const sid = randomId(32);
  await env.SESSION.put("sess:" + sid, JSON.stringify({ access_token: tok.access_token, created: Date.now() }), {
    expirationTtl: ttl,
  });
  const handoff = randomId(24);
  await env.SESSION.put("hand:" + handoff, sid, { expirationTtl: 60 });
  return redirect(spaRedirect(env, { login_code: handoff }), { "Set-Cookie": sessionCookie(sid, ttl) });
}

async function authExchange(env, request) {
  let body = null;
  try { body = await request.json(); } catch { /* handled below */ }
  const code = body && typeof body.code === "string" ? body.code : "";
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(code)) return json(env, request, { error: "bad_request", message: "Invalid code" }, 400);
  const sid = await env.SESSION.get("hand:" + code);
  if (!sid) return json(env, request, { error: "invalid_code", message: "Login code expired or already used" }, 400);
  await env.SESSION.delete("hand:" + code);
  return json(env, request, { session_token: sid });
}

async function meAccounts(env, request) {
  const s = await loadSession(env, request);
  if (!s) return json(env, request, { error: "not_logged_in", message: "Not logged in" }, 401);
  let res;
  try {
    res = await fetch(`${API_BASE}/trading/v1/options/accounts`, { headers: derivHeaders(env, s.access_token) });
  } catch {
    return json(env, request, { error: "upstream_unreachable", message: "Deriv is unreachable" }, 502);
  }
  if (res.status === 401 || res.status === 403) {
    await env.SESSION.delete("sess:" + s.id);
    return json(env, request, { error: "session_expired", message: "Session expired, log in again" }, 401);
  }
  if (!res.ok) return json(env, request, { error: "upstream_error", message: "Could not load accounts" }, 502);
  let body;
  try { body = await res.json(); } catch { body = null; }
  const list = body && Array.isArray(body.data) ? body.data : null;
  if (!list) return json(env, request, { error: "upstream_error", message: "Unexpected Deriv response" }, 502);
  const data = list.map((a) => ({
    account_id: a.account_id,
    loginid: a.account_id,
    account_type: a.account_type,
    is_virtual: a.account_type === "demo",
    currency: a.currency,
    balance: a.balance,
  }));
  return json(env, request, { data });
}

async function wsOtp(env, request) {
  const s = await loadSession(env, request);
  if (!s) return json(env, request, { error: "not_logged_in", message: "Not logged in" }, 401);
  let body = null;
  try { body = await request.json(); } catch { /* handled below */ }
  const accountId = body && typeof body.account_id === "string" ? body.account_id : "";
  if (!ACCOUNT_ID_RE.test(accountId)) return json(env, request, { error: "bad_request", message: "Invalid account_id" }, 400);
  let res;
  try {
    res = await fetch(`${API_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, {
      method: "POST",
      headers: derivHeaders(env, s.access_token),
    });
  } catch {
    return json(env, request, { error: "upstream_unreachable", message: "Deriv is unreachable" }, 502);
  }
  if (res.status === 401 || res.status === 403) return json(env, request, { error: "session_expired", message: "Session expired, log in again" }, 401);
  if (!res.ok) return json(env, request, { error: "upstream_error", message: "Could not get connection OTP" }, 502);
  let out;
  try { out = await res.json(); } catch { out = null; }
  const url = out && out.data && out.data.url;
  if (typeof url !== "string" || !url.startsWith("wss://")) return json(env, request, { error: "upstream_error", message: "Unexpected Deriv response" }, 502);
  // The OTP URL is already authorized, so no token is returned to the browser.
  return json(env, request, { url, token: null });
}

async function logout(env, request) {
  const id = sessionIdFrom(request);
  if (id && /^[A-Za-z0-9_-]{20,100}$/.test(id)) await env.SESSION.delete("sess:" + id);
  return json(env, request, { ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, request) });

    if (path === "/" && method === "GET") {
      return json(env, request, { name: "mambafx-backend", status: "ok" });
    }
    if (path === "/health" && method === "GET") {
      const missing = configError(env);
      return json(env, request, { ok: !missing, ...(missing ? { missing_config: missing } : {}) }, missing ? 503 : 200);
    }

    const known = ["/auth/start", "/auth/callback", "/me/session", "/me/accounts", "/ws/otp", "/logout", "/auth/exchange"];
    if (!known.includes(path)) return json(env, request, { error: "not_found" }, 404);

    const missing = configError(env);
    if (missing) return json(env, request, { error: "server_misconfigured", missing_config: missing }, 500);

    try {
      if (path === "/auth/start" && method === "GET") return await authStart(env);
      if (path === "/auth/callback" && method === "GET") return await authCallback(env, url);
      if (path === "/auth/exchange" && method === "POST") return await authExchange(env, request);
      if (path === "/me/session" && method === "GET") return json(env, request, { logged_in: !!(await loadSession(env, request)) });
      if (path === "/me/accounts" && method === "GET") return await meAccounts(env, request);
      if (path === "/ws/otp" && method === "POST") return await wsOtp(env, request);
      if (path === "/logout" && method === "POST") return await logout(env, request);
    } catch {
      return json(env, request, { error: "internal_error", message: "Internal error" }, 500);
    }
    return json(env, request, { error: "method_not_allowed" }, 405);
  },
};
