import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-cloud-history-')), output = path.join(scratch, 'history.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/chat-history.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output });
const { createChatHistoryService } = require(output);
function fixture(stored) {
 let owner = 'account-a', hold, fail = false, confirmed = true;
 const calls = [], writes = [];
 const api = createChatHistoryService({ owner: () => owner, get: () => stored, set: (_key, value) => { stored = value; writes.push(value); }, createId: () => 'new-server-id', request: async body => {
  calls.push(body); if (fail) throw Error('Server unavailable'); if (hold) await hold;
  if (body?.action === 'load') return { conversation: { id: body.conversationId, turns: [{ prompt: 'q', reply: 'Server reply' }] } };
  if (body?.action === 'save') return { id: body.conversationId }; if (body?.action === 'delete') return { deleted: true };
  return body ? { migrated: confirmed } : { items: [{ id: 'cloud-chat' }] };
 } });
 return { api, calls, writes, stored: () => stored, owner(value) { owner = value; }, fail(value) { fail = value; }, hold(value) { hold = value; }, confirmed(value) { confirmed = value; } };
}
test('history uses server operations and new saves never persist chat text locally', async () => {
 const f = fixture(); assert.deepEqual(await f.api.list('account-a'), [{ id: 'cloud-chat' }]);
 assert.deepEqual(await f.api.save('account-a', null, [{ prompt: 'q', reply: 'a' }]), { id: 'new-server-id' });
 assert.deepEqual(f.calls[1], { action: 'save', conversationId: 'new-server-id', create: true, turns: [{ prompt: 'q', reply: 'a' }] });
 assert.equal((await f.api.load('account-a', 'cloud-chat')).turns[0].reply, 'Server reply'); assert.deepEqual(await f.api.remove('account-a', 'cloud-chat'), { deleted: true });
 assert.deepEqual(f.writes, []); assert.equal(f.stored(), undefined);
});
test('legacy history transfers only the current account, strips attachment fields and clears only after confirmation', async () => {
 const stored = ['account-a','account-b'].map(owner => ({ owner, conversations: [{ id: `old-${owner}`, createdAt: 1, updatedAt: 2, turns: [{ prompt: 'q', reply: 'a', name: 'private.txt', data: 'bytes', path: '/private/file', attachmentsCount: 1 }] }] }));
 const f = fixture(stored); f.fail(true); await assert.rejects(f.api.list('account-a'), /Server unavailable/); assert.deepEqual(f.stored(), stored); assert.deepEqual(f.writes, []);
 f.fail(false); await f.api.list('account-a'); const transfer = f.calls.find(call => call?.action === 'migrate');
 assert.equal(transfer.conversations.length, 1); assert.equal(JSON.stringify(transfer).includes('private'), false); assert.equal(JSON.stringify(transfer).includes('bytes'), false);
 assert.deepEqual(f.stored().map(account => account.owner), ['account-b']); await f.api.list('account-a'); assert.equal(f.calls.filter(call => call?.action === 'migrate').length, 2);
});
test('account changes and resets discard stale results and preserve unconfirmed local transfers', async () => {
 const f = fixture([{ owner: 'account-a', conversations: [{ id: 'old', turns: [{ prompt: 'q', reply: 'a' }] }] }]);
 let release; f.hold(new Promise(resolve => { release = resolve; })); const request = f.api.list('account-a'); await new Promise(resolve => setImmediate(resolve));
 f.owner('account-b'); f.api.reset(); release(); await assert.rejects(request, /Account changed/); assert.equal(f.stored().length, 1); assert.deepEqual(f.writes, []); await assert.rejects(f.api.list('account-a'), /Account changed/);
});
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

test('an unconfirmed transfer never clears the local account history', async () => {
 const f = fixture([{ owner: 'account-a', conversations: [{ id: 'old', turns: [{ prompt: 'q', reply: 'a' }] }] }]);
 f.confirmed(false); await assert.rejects(f.api.list('account-a'), /not confirmed/); assert.equal(f.stored().length, 1); assert.deepEqual(f.writes, []);
});
