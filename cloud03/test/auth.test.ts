import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StudioOAuth } from '../src/auth.js';
import { RecordService } from '../src/records.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from './memory.js';

const origin = 'https://studio-bridge.example';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'https://chatgpt.com/test-callback'; // Test fixture only, not a deployment callback.
async function fixture(t: any) {
  const store = new MemoryStore(); let now = 1800000000; let active = true;
  const oauth = new StudioOAuth(store, origin, async token => {
    if (token !== 'mock-firebase-id-token') throw Error('Invalid Firebase token');
    return { uid: 'user-a', email_verified: true };
  }, async () => active, () => now);
  const records = new RecordService(store);
  const server = createApp(oauth, records).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init?: RequestInit) => fetch(base + path, { redirect: 'manual', ...init });
  const register = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Cloud03 Test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(register.status, 201); const client = await register.json();
  async function pending() {
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'studio.read studio.write', state: 'state-123', resource: origin + '/mcp' });
    const response = await request('/authorize?' + query);
    assert.equal(response.status, 302);
    return { requestId: new URL(response.headers.get('location')!).searchParams.get('request')!, cookie: response.headers.get('set-cookie')!.split(';')[0] };
  }
  async function approve(allowWrite = true) {
    const p = await pending();
    const response = await request('/consent/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: p.cookie },
      body: JSON.stringify({ requestId: p.requestId, idToken: 'mock-firebase-id-token', allowWrite }) });
    assert.equal(response.status, 200); const value = await response.json();
    const url = new URL(value.redirect); assert.equal(url.searchParams.get('state'), 'state-123');
    return { ...p, code: url.searchParams.get('code')! };
  }
  const exchange = (code: string, changes: Record<string, string> = {}) => request('/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirectUri, resource: origin + '/mcp', ...changes }) });
  return { request, client, oauth, pending, approve, exchange, setNow: (value: number) => now = value, disable: () => active = false };
}
test('OAuth discovery and unauthorized MCP advertise protected-resource metadata', async t => {
  const f = await fixture(t);
  const meta = await (await f.request('/.well-known/oauth-authorization-server')).json();
  assert.equal(meta.issuer, origin + '/');
  const response = await f.request('/mcp', { method: 'POST' });
  assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate')!, /oauth-protected-resource/);
});
test('registration rejects off-platform redirect hosts and OAuth requires S256', async t => {
  const f = await fixture(t);
  const bad = await f.request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(bad.status, 400);
  const params = new URLSearchParams({ client_id: f.client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'plain' });
  const response = await f.request('/authorize?' + params);
  assert.match(response.headers.get('location')!, /error=invalid_request/);
});
test('consent requires same origin, bound cookie, valid Firebase ID and one-time request', async t => {
  const f = await fixture(t), p = await f.pending();
  const body = JSON.stringify({ requestId: p.requestId, idToken: 'mock-firebase-id-token', allowWrite: true });
  assert.equal((await f.request('/consent/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: p.cookie }, body })).status, 403);
  assert.equal((await f.request('/consent/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body })).status, 400);
  const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: p.cookie };
  assert.equal((await f.request('/consent/approve', { method: 'POST', headers, body: body.replace('mock-firebase-id-token', 'invalid-token') })).status, 400);
  assert.equal((await f.request('/consent/approve', { method: 'POST', headers, body })).status, 200);
  assert.equal((await f.request('/consent/approve', { method: 'POST', headers, body })).status, 400);
});
test('token exchange enforces PKCE, callback, audience and single-use codes', async t => {
  const f = await fixture(t), { code } = await f.approve();
  assert.equal((await f.exchange(code, { code_verifier: 'b'.repeat(43) })).status, 400);
  assert.equal((await f.exchange(code, { redirect_uri: redirectUri + '/different' })).status, 400);
  assert.equal((await f.exchange(code, { resource: 'https://other.example/mcp' })).status, 400);
  const response = await f.exchange(code); assert.equal(response.status, 200);
  const tokens = await response.json(); assert.equal((await f.oauth.verifyAccessToken(tokens.access_token)).extra?.uid, 'user-a');
  assert.equal((await f.exchange(code)).status, 400);
});
test('refresh rotates tokens, cannot escalate consent, and revocation disables all grant tokens', async t => {
  const f = await fixture(t), { code } = await f.approve(false);
  const tokens = await (await f.exchange(code)).json();
  const refresh = (scope = 'studio.read') => f.request('/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: tokens.refresh_token, scope, resource: origin + '/mcp' }) });
  assert.equal((await refresh('studio.read studio.write')).status, 400);
  const rotated = await (await refresh()).json(); assert.ok(rotated.access_token);
  assert.equal((await refresh()).status, 400);
  assert.deepEqual((await f.oauth.verifyAccessToken(rotated.access_token)).scopes, ['studio.read']);
  await f.oauth.revokeToken(f.client, { token: rotated.refresh_token });
  await assert.rejects(f.oauth.verifyAccessToken(tokens.access_token));
  await assert.rejects(f.oauth.verifyAccessToken(rotated.access_token));
});
test('disabled accounts and expired tokens cannot use the bridge', async t => {
  const f = await fixture(t), { code } = await f.approve();
  const tokens = await (await f.exchange(code)).json();
  f.disable(); await assert.rejects(f.oauth.verifyAccessToken(tokens.access_token));
  f.setNow(1900000000); await assert.rejects(f.oauth.verifyAccessToken(tokens.access_token));
});
test('real MCP transport exposes only consented tools and executes an idempotent task write', async t => {
  const f = await fixture(t), { code } = await f.approve();
  const tokens = await (await f.exchange(code)).json();
  const rpc = async (method: string, params: unknown) => {
    const r = await f.request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(r.status, 200); return r.json();
  };
  const tools = await rpc('tools/list', {}); assert.equal(tools.result.tools.length, 6);
  const args = { requestId: '5c46c850-1982-4510-90c7-a196088d4b96', task: { title: '測試修回', date: '2026-12-01' } };
  const created = await rpc('tools/call', { name: 'studio_create_task', arguments: args });
  assert.equal(JSON.parse(created.result.content[0].text).value.title, '測試修回');
  const repeated = await rpc('tools/call', { name: 'studio_create_task', arguments: args });
  assert.equal(JSON.parse(repeated.result.content[0].text).alreadyApplied, true);
  const readOnlyCode = await f.approve(false), readTokens = await (await f.exchange(readOnlyCode.code)).json();
  const list = await f.request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + readTokens.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  assert.equal((await list.json()).result.tools.length, 2);
  const denied = await f.request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + readTokens.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'studio_create_task', arguments: args } }) });
  const deniedBody = await denied.json();
  assert.ok(deniedBody.error || deniedBody.result?.isError);
});
