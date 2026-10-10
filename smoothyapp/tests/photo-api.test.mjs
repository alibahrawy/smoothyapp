import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const bundle = await build({ entryPoints: [new URL('../src/main/web-api.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'auth', setup(builder) {
  builder.onResolve({ filter: /^\.\/auth-service$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getStoredUserId=()=>globalThis.fixture.user,getAuthHeaders=()=>({'Content-Type':'application/json',Authorization:'Bearer fixture-session'});` }));
} }] });
function fixture() {
  const f = { user: 'account-a', calls: [], response: new Response(JSON.stringify({ imageUrl: 'fixture' }), { status: 200 }) };
  const module = { exports: {} }; vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), process: { env: {} }, Buffer, URL, AbortSignal, AbortController, fetch: async (...args) => { f.calls.push(args); return f.response; }, fixture: f });
  return { f, api: module.exports };
}
test('photo requests use the existing signed session, fixed routes and JSON bodies; invalid/anonymous requests never fetch', async () => {
  const { f, api } = fixture();
  await api.requestPhotoRoute('/api/generate-reaction', { method: 'POST', body: { prompt: 'Sky' } });
  assert.equal(f.calls[0][0], 'https://smoothyedit.com/api/generate-reaction'); assert.equal(f.calls[0][1].headers.Authorization, 'Bearer fixture-session'); assert.equal(f.calls[0][1].body, '{"prompt":"Sky"}');
  await assert.rejects(api.requestPhotoRoute('https://evil.test'), /Unsupported/); f.user = null;
  await assert.rejects(api.requestPhotoRoute('/api/reactions'), /Sign in/); assert.equal(f.calls.length, 1);
});
test('401 and 402 responses produce useful errors with no provider or billing retries', async () => {
  for (const [status, message, expected] of [[401, 'Invalid session', /session expired/], [402, 'No credits remaining', /No credits remaining/]]) {
    const { f, api } = fixture(); f.response = new Response(JSON.stringify({ message }), { status });
    await assert.rejects(api.requestPhotoRoute('/api/generate-reaction', { method: 'POST', body: { prompt: 'Sky' } }), expected); assert.equal(f.calls.length, 1);
  }
});
test('image downloads omit credentials, reject other hosts/nonmedia/redirects and enforce declared and streamed size limits', async () => {
  const { f, api } = fixture();
  for (const url of ['http://127.0.0.1/private', 'https://smoothyedit.com/api/auth/me', 'https://evil.test/media/image', 'https://u:p@smoothyedit.com/media/x', 'data:text/html;base64,eA==']) await assert.rejects(api.fetchPhotoBytes(url));
  assert.deepEqual(f.calls, []);
  f.response = new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  assert.deepEqual(await api.fetchPhotoBytes('https://smoothyedit.com/media/image.png'), Buffer.from([1, 2, 3]));
  assert.equal(f.calls[0][1].headers, undefined); assert.equal(f.calls[0][1].redirect, 'error');
  f.response = new Response('x', { headers: { 'content-length': String(26 * 1024 * 1024) } }); await assert.rejects(api.fetchPhotoBytes('https://smoothyedit.com/media/image.png'), /25 MB/);
  f.response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(26 * 1024 * 1024)); controller.close(); } })); await assert.rejects(api.fetchPhotoBytes('https://smoothyedit.com/media/image.png'), /25 MB/);
});
