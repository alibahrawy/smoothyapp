import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const bundle = await build({ stdin: { contents: `export { requestChatHistory } from './src/main/web-api'; export { configureStudioPreference, studioPreferenceChanged } from './src/main/app-preferences';`, resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'auth', setup(builder) {
 builder.onResolve({ filter: /^\.\/auth-service$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
 builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getStoredUserId=()=>globalThis.fixture.user,getAuthHeaders=()=>({'Content-Type':'application/json',Authorization:'Bearer fixture-session'});` }));
} }] });
function fixture(env = {}) {
 const f = { user: 'account-a', calls: [], response: () => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })) }, module = { exports: {} };
 vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), process: { env }, Buffer, URL, AbortSignal, AbortController, fetch: async (...args) => { f.calls.push(args); return f.response(); }, fixture: f });
 return { f, api: module.exports };
}
test('native history uses the signed credential and fixed Cloudflare endpoint, respects opt-out, and has no local fallback', async () => {
 const { f, api } = fixture({ SMOOTHY_TELEMETRY: '0' });
 await api.requestChatHistory(); await api.requestChatHistory({ action: 'save', turns: [{ prompt: 'q', reply: 'a' }] });
 assert.equal(f.calls[0][0], 'https://smoothyedit.com/api/chat/history'); assert.equal(f.calls[0][1].method, 'GET'); assert.equal(f.calls[0][1].body, undefined);
 assert.equal(f.calls[1][1].method, 'POST'); assert.equal(f.calls[1][1].headers.Authorization, 'Bearer fixture-session'); assert.equal(f.calls[1][1].headers['X-Smoothy-Telemetry'], '0');
 assert.equal(JSON.parse(f.calls[1][1].body).action, 'save'); assert.ok(f.calls[1][1].signal instanceof AbortSignal);
 f.response = () => Promise.resolve(new Response(JSON.stringify({ error: 'History unavailable' }), { status: 503 })); await assert.rejects(api.requestChatHistory(), /History unavailable/);
 f.user = null; await assert.rejects(api.requestChatHistory(), /Sign in/); assert.equal(f.calls.length, 3);
});
test('account changes, AI-off abort and expired sessions discard server history responses', async () => {
 const { f, api } = fixture();
 f.response = async () => { f.user = 'other'; return new Response(JSON.stringify({ items: [] })); }; await assert.rejects(api.requestChatHistory(), /Account changed/);
 f.response = () => Promise.resolve(new Response(JSON.stringify({ error: 'Expired' }), { status: 401 })); await assert.rejects(api.requestChatHistory(), /Sign in/);
 f.response = async () => { api.studioPreferenceChanged(); return new Response(JSON.stringify({ items: [] })); }; await assert.rejects(api.requestChatHistory(), /abort/i);
 api.configureStudioPreference(() => false); const count = f.calls.length; await assert.rejects(api.requestChatHistory(), /turned off/); assert.equal(f.calls.length, count);
});
