import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { pkceChallenge } from '../../src/index.js';

const ORIGIN = 'https://kennjanja.github.io';
const SPA = 'https://kennjanja.github.io/mambafx/';
const SECRET_TOKEN = 'ory_at_SECRET_TOKEN_VALUE';

function kv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
const mkEnv = (over = {}) => ({
  CLIENT_ID: 'cid123',
  REDIRECT_URI: 'https://mambafx-backend.kenkin1122.workers.dev/auth/callback',
  SPA_URL: SPA,
  ALLOWED_ORIGIN: ORIGIN,
  SESSION: kv(),
  ...over,
});
const call = (env, path, init = {}) => worker.fetch(new Request('https://w.test' + path, init), env);

async function startFlow(env) {
  const r = await call(env, '/auth/start');
  const loc = new URL(r.headers.get('Location'));
  return { r, loc, state: loc.searchParams.get('state') };
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return calls;
}
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

async function login(env) {
  const { state } = await startFlow(env);
  mockFetch(() => new Response(JSON.stringify({ access_token: SECRET_TOKEN, expires_in: 3600, token_type: 'bearer' })));
  const r = await call(env, `/auth/callback?code=abc&state=${state}`);
  const cookie = r.headers.get('Set-Cookie').split(';')[0];
  return { r, cookie };
}
const loginError = (r) => new URL(r.headers.get('Location')).searchParams.get('login_error');

test('GET / and /health respond', async () => {
  const env = mkEnv();
  assert.equal((await call(env, '/')).status, 200);
  assert.equal((await call(env, '/health')).status, 200);
});

test('/health reports missing config names without values', async () => {
  const r = await call(mkEnv({ CLIENT_ID: undefined }), '/health');
  assert.equal(r.status, 503);
  assert.deepEqual((await r.json()).missing_config, ['CLIENT_ID']);
});

test('unknown routes 404; old placeholder /signal and /auth are gone', async () => {
  const env = mkEnv();
  assert.equal((await call(env, '/signal')).status, 404);
  assert.equal((await call(env, '/auth', { method: 'POST', body: '{"token":"x"}' })).status, 404);
});

test('/auth/start redirects with PKCE S256, state, scope, redirect_uri', async () => {
  const env = mkEnv();
  const { r, loc, state } = await startFlow(env);
  assert.equal(r.status, 302);
  assert.equal(loc.origin + loc.pathname, 'https://auth.deriv.com/oauth2/auth');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('client_id'), 'cid123');
  assert.equal(loc.searchParams.get('redirect_uri'), env.REDIRECT_URI);
  assert.equal(loc.searchParams.get('scope'), 'trade');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const stored = JSON.parse(env.SESSION.m.get('oauth:' + state));
  assert.equal(await pkceChallenge(stored.verifier), loc.searchParams.get('code_challenge'));
  assert.ok(!r.headers.get('Location').includes(stored.verifier));
});

test('state is unique per login', async () => {
  const env = mkEnv();
  assert.notEqual((await startFlow(env)).state, (await startFlow(env)).state);
});

test('callback: denial, missing params, invalid state redirect safely', async () => {
  const env = mkEnv();
  const { state } = await startFlow(env);
  assert.equal(loginError(await call(env, `/auth/callback?error=access_denied&state=${state}`)), 'access_denied');
  assert.equal(loginError(await call(env, '/auth/callback')), 'missing_params');
  assert.equal(loginError(await call(env, '/auth/callback?code=x&state=doesnotexist1234')), 'invalid_state');
});

test('callback: exchange sends verifier, sets secure cookie, token stays server-side', async () => {
  const env = mkEnv();
  const { state } = await startFlow(env);
  const verifier = JSON.parse(env.SESSION.m.get('oauth:' + state)).verifier;
  const calls = mockFetch(() => new Response(JSON.stringify({ access_token: SECRET_TOKEN, expires_in: 3600 })));
  const r = await call(env, `/auth/callback?code=abc&state=${state}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), SPA);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, 'https://auth.deriv.com/oauth2/token');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'abc');
  assert.equal(body.get('code_verifier'), verifier);
  const sc = r.headers.get('Set-Cookie');
  for (const f of ['HttpOnly', 'Secure', 'Path=/', 'SameSite=None']) assert.ok(sc.includes(f), f);
  assert.ok(!sc.includes(SECRET_TOKEN));
  assert.ok(!r.headers.get('Location').includes(SECRET_TOKEN));
  assert.ok([...env.SESSION.m.values()].some((v) => v.includes(SECRET_TOKEN)));
});

test('callback: state is single-use (replay rejected)', async () => {
  const env = mkEnv();
  const { state } = await startFlow(env);
  mockFetch(() => new Response(JSON.stringify({ access_token: SECRET_TOKEN, expires_in: 3600 })));
  await call(env, `/auth/callback?code=abc&state=${state}`);
  assert.equal(loginError(await call(env, `/auth/callback?code=abc&state=${state}`)), 'invalid_state');
});

test('callback: exchange failure and malformed response are safe', async () => {
  const env = mkEnv();
  let { state } = await startFlow(env);
  mockFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
  let r = await call(env, `/auth/callback?code=abc&state=${state}`);
  assert.equal(loginError(r), 'token_exchange_failed');
  assert.ok(!r.headers.get('Set-Cookie'));
  ({ state } = await startFlow(env));
  mockFetch(() => new Response('{}'));
  assert.equal(loginError(await call(env, `/auth/callback?code=abc&state=${state}`)), 'token_exchange_failed');
});

test('/me/session reflects login state and never leaks the token', async () => {
  const env = mkEnv();
  assert.deepEqual(await (await call(env, '/me/session')).json(), { logged_in: false });
  const { cookie } = await login(env);
  const text = await (await call(env, '/me/session', { headers: { Cookie: cookie } })).text();
  assert.deepEqual(JSON.parse(text), { logged_in: true });
  assert.ok(!text.includes(SECRET_TOKEN));
});

test('/me/accounts maps accounts, uses bearer token, 401 when logged out', async () => {
  const env = mkEnv();
  assert.equal((await call(env, '/me/accounts')).status, 401);
  const { cookie } = await login(env);
  const calls = mockFetch(() => new Response(JSON.stringify({
    data: [{ account_id: 'DOT1', balance: 10000, currency: 'USD', account_type: 'demo', status: 'active', group: 'x' },
           { account_id: 'ROT2', balance: 5, currency: 'USD', account_type: 'real', status: 'active', group: 'x' }],
  })));
  const text = await (await call(env, '/me/accounts', { headers: { Cookie: cookie } })).text();
  const j = JSON.parse(text);
  assert.equal(calls[0].url, 'https://api.derivws.com/trading/v1/options/accounts');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + SECRET_TOKEN);
  assert.equal(j.data[0].is_virtual, true);
  assert.equal(j.data[1].is_virtual, false);
  assert.equal(j.data[0].loginid, 'DOT1');
  assert.ok(!text.includes(SECRET_TOKEN));
});

test('/me/accounts: upstream 401 invalidates session; upstream failure is 502', async () => {
  const env = mkEnv();
  const { cookie } = await login(env);
  mockFetch(() => new Response('{}', { status: 500 }));
  assert.equal((await call(env, '/me/accounts', { headers: { Cookie: cookie } })).status, 502);
  mockFetch(() => new Response('{}', { status: 401 }));
  assert.equal((await call(env, '/me/accounts', { headers: { Cookie: cookie } })).status, 401);
  assert.deepEqual(await (await call(env, '/me/session', { headers: { Cookie: cookie } })).json(), { logged_in: false });
});

test('/ws/otp validates input and returns url with null token', async () => {
  const env = mkEnv();
  const post = (cookie, body) => call(env, '/ws/otp', { method: 'POST', headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('', { account_id: 'DOT1' })).status, 401);
  const { cookie } = await login(env);
  assert.equal((await post(cookie, { account_id: '../x?y' })).status, 400);
  assert.equal((await post(cookie, {})).status, 400);
  const calls = mockFetch(() => new Response(JSON.stringify({ data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc' } })));
  const r = await post(cookie, { account_id: 'DOT1' });
  assert.deepEqual(await r.json(), { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc', token: null });
  assert.equal(calls[0].url, 'https://api.derivws.com/trading/v1/options/accounts/DOT1/otp');
  assert.equal(calls[0].init.method, 'POST');
});

test('/logout deletes the session and clears the cookie', async () => {
  const env = mkEnv();
  const { cookie } = await login(env);
  const r = await call(env, '/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('Set-Cookie').includes('Max-Age=0'));
  assert.deepEqual(await (await call(env, '/me/session', { headers: { Cookie: cookie } })).json(), { logged_in: false });
});

test('CORS: exact origin with credentials, no wildcard, preflight, foreign origin gets none', async () => {
  const env = mkEnv();
  let r = await call(env, '/me/session', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(r.headers.get('Vary'), 'Origin');
  r = await call(env, '/me/session', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('missing config fails safely on auth routes', async () => {
  const r = await call(mkEnv({ REDIRECT_URI: undefined }), '/auth/start');
  assert.equal(r.status, 500);
  assert.deepEqual((await r.json()).missing_config, ['REDIRECT_URI']);
});
