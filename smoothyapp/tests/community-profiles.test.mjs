import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Bundle a TypeScript module for Node, replacing the native/Electron imports with stubs. */
async function load(entry, stubs = {}) {
  const output = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const key = Object.keys(stubs).find((name) => args.path === name || args.path.endsWith(`/${name}`));
          return key ? { path: key, namespace: 'stub' } : undefined;
        });
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

const links = await load('src/shared/community-links.ts');
const avatars = await load('src/shared/community-avatar.ts');

test('links: only the allow-listed https hosts become clickable', () => {
  assert.equal(links.safeCommunityLink('https://youtu.be/abc123'), 'https://youtu.be/abc123');
  assert.equal(links.safeCommunityLink('https://app.frame.io/reviews/x'), 'https://app.frame.io/reviews/x');
  for (const bad of ['http://youtu.be/abc', 'https://evil.io/x', 'https://youtube.com.evil.io/', 'https://user:pw@x.com/', 'https://x.com:444/', 'javascript:alert(1)', 'file:///etc/passwd', '', null, 42]) {
    assert.equal(links.safeCommunityLink(bad), null, String(bad));
  }
  assert.deepEqual(links.splitCommunityMessage('see https://youtu.be/abc123. Then https://evil.io/x ok'), [
    { type: 'text', text: 'see ' },
    { type: 'link', url: 'https://youtu.be/abc123' },
    { type: 'text', text: '. Then https://evil.io/x ok' },
  ]);
});

test('links: pictures and thumbnails come only from preview-safe hosts', () => {
  assert.equal(links.isCommunityImage('https://i.redd.it/abc.png'), true);
  assert.equal(links.isCommunityImage('https://www.reddit.com/r/x/comments/1'), false);
  assert.equal(links.isCommunityImage('http://i.redd.it/abc.png'), false);
  assert.equal(links.youtubeThumbnail('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(links.youtubeThumbnail('https://youtu.be/dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(links.youtubeThumbnail('https://www.youtube.com/shorts/abcdefghijk'), 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  assert.equal(links.youtubeThumbnail('https://x.com/a/status/1'), null);
  assert.equal(links.communitySiteName('https://drive.google.com/file/d/x'), 'Google Drive');
  assert.equal(links.communitySiteName('https://f.io/abc'), 'Frame.io');
});

test('avatars: monograms render cleanly with safe initials, and bad data is dropped', () => {
  assert.equal(avatars.avatarInitials('Ali Bahrawy', 'u1'), 'AB');
  assert.equal(avatars.avatarInitials('Ali', 'u1'), 'A');
  assert.equal(avatars.avatarInitials('Guest Otter 14', 'g1'), 'O');
  assert.equal(avatars.avatarInitials('Guest Alex Chen', 'g2'), 'AC');
  assert.match(avatars.avatarInitials('', 'id-1'), /^[A-Z]$/);

  for (let color = 0; color < avatars.AVATAR_COLORS.length; color += 1) {
    const svg = avatars.avatarSvg({ kind: 'gen', style: 'flat', shape: 0, eyes: 0, color }, 'someone', 32, 'Ali <script>');
    assert.match(svg, /^<svg [^>]*>.*<\/svg>$/s);
    assert.doesNotMatch(svg, /<script|onload|href=/i);
    assert.match(svg, />AS<\/text>/);
  }
  // Smoothy Lime (#B0EC9C at index 4) uses dark ink; Ink (#18181B at index 0) uses white ink.
  assert.match(avatars.avatarSvg({ kind: 'gen', style: 'flat', shape: 0, eyes: 0, color: 4 }, 'u', 32, 'Ali'), /fill="#141414"/);
  assert.match(avatars.avatarSvg({ kind: 'gen', style: 'flat', shape: 0, eyes: 0, color: 0 }, 'u', 32, 'Ali'), /fill="#FFFFFF"/);

  assert.equal(avatars.AVATAR_COLORS.length, 17);
  assert.deepEqual(avatars.defaultAvatar('abc'), avatars.defaultAvatar('abc'), 'defaults are stable');
  assert.notDeepEqual(avatars.defaultAvatar('abc'), avatars.defaultAvatar('abd'));

  const good = { kind: 'gen', style: 'plush', shape: 9, eyes: 15, color: 16 };
  assert.deepEqual(avatars.cleanAvatar(good), good);
  for (const bad of [{ ...good, shape: 10 }, { ...good, eyes: 16 }, { ...good, color: 17 }, { ...good, style: 'x' }, { kind: 'img', data: 'https://evil.io/a.png' }, { kind: 'img', data: 'data:image/svg+xml;base64,AAAA' }, null]) {
    assert.equal(avatars.cleanAvatar(bad), null, JSON.stringify(bad));
  }
  const picture = `data:image/webp;base64,${Buffer.from('RIFFxxxxWEBP').toString('base64')}`;
  assert.deepEqual(avatars.cleanAvatar({ kind: 'img', data: picture }), { kind: 'img', data: picture });
});

/* --------------------------- the desktop service --------------------------- */

const fakeWs = `
  class FakeWs {
    static OPEN = 1;
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.handlers = {}; FakeWs.instances.push(this); setTimeout(() => this.handlers.open?.(), 0); }
    on(name, handler) { this.handlers[name] = handler; return this; }
    removeAllListeners() { this.handlers = {}; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
    push(frame) { this.handlers.message?.(Buffer.from(JSON.stringify(frame))); }
  }
  export default FakeWs;
  globalThis.__FakeWs = FakeWs;
`;
const service = await load('src/main/community-service.ts', {
  ws: fakeWs,
  'electron-store': 'export default class Store {}',
  'auth-service': 'export const getAuthHeaders = () => ({}); export const getSessionToken = () => "token";',
});

globalThis.fetch = async () => new Response(JSON.stringify({
  ticket: 't1',
  identity: { id: 'me', name: 'Me', guest: false, tier: 'free' },
}), { status: 200, headers: { 'content-type': 'application/json' } });

async function online() {
  const data = new Map();
  const tracked = [];
  const profileBatches = [];
  const states = [];
  const community = service.createCommunityService({
    store: { get: (key) => data.get(key), set: (key, value) => data.set(key, value) },
    track: (id) => tracked.push(id),
    onState: (state) => states.push(state),
    onProfiles: (list) => profileBatches.push(list),
  });
  await community.connect();
  const socket = globalThis.__FakeWs.instances.at(-1);
  socket.push({
    type: 'hello',
    you: { id: 'me', name: 'Me', guest: false, tier: 'free' },
    history: [{ id: 'm1', authorId: 'ana', authorName: 'Ana', guest: false, tier: 'pro', body: 'hello', at: 1 }],
    count: 2,
    blocks: [{ id: 'bob', name: 'Bob' }],
    sanction: null,
  });
  return { community, socket, tracked, profileBatches, states };
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('service: hello fills history, blocks and presence', async () => {
  const { community } = await online();
  const state = community.state();
  assert.equal(state.status, 'online');
  assert.deepEqual(state.blocks, [{ id: 'bob', name: 'Bob' }]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.sanction, null);
  community.dispose();
});

test('service: profiles are validated, sent separately, and unknown authors are requested once', async () => {
  const { community, socket, profileBatches } = await online();
  socket.push({ type: 'profiles', profiles: [
    { id: 'ana', name: null, avatar: { kind: 'gen', style: 'flat', shape: 2, eyes: 3, color: 4 } },
    { id: 'evil', name: 'Evil', avatar: { kind: 'img', data: 'https://evil.io/x.png' } },
  ] });
  assert.equal(profileBatches.length, 1);
  assert.deepEqual(profileBatches[0].map((entry) => [entry.id, entry.avatar?.kind ?? null]), [['ana', 'gen'], ['evil', null]]);
  assert.equal(community.profiles().length, 2);
  assert.ok(!('profiles' in community.state()), 'pictures never ride along with every state push');

  socket.sent.length = 0;
  for (const id of ['newcomer', 'newcomer', 'other']) {
    socket.push({ type: 'message', message: { id: `m-${id}-${Math.random()}`, authorId: id, authorName: id, guest: false, tier: 'free', body: 'hi', at: 5 } });
  }
  await tick(250);
  const asks = socket.sent.filter((frame) => frame.type === 'profiles');
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].ids.sort(), ['newcomer', 'other']);
  community.dispose();
});

test('service: deletions, history refreshes and timeouts update the state', async () => {
  const { community, socket } = await online();
  socket.push({ type: 'deleted', id: 'm1', by: 'reports' });
  assert.equal(community.state().messages.length, 0);

  socket.push({ type: 'history', history: [{ id: 'm9', authorId: 'cy', authorName: 'Cy', guest: false, tier: 'free', body: 'back', at: 9 }], blocks: [] });
  assert.deepEqual(community.state().messages.map((entry) => entry.id), ['m9']);
  assert.deepEqual(community.state().blocks, []);

  socket.push({ type: 'sanction', sanction: { until: Date.now() + 3_600_000, strikes: 1 } });
  assert.equal(community.state().sanction.strikes, 1);
  socket.push({ type: 'sanction', sanction: { until: Date.now() - 1, strikes: 1 } });
  assert.equal(community.state().sanction, null, 'an expired timeout is not shown');
  community.dispose();
});

test('service: each accepted action counts once and failures count nothing', async () => {
  const { community, socket, tracked } = await online();

  const deleted = community.deleteMessage('m1');
  await tick();
  const frame = socket.sent.at(-1);
  assert.deepEqual([frame.type, frame.id], ['delete', 'm1']);
  socket.push({ type: 'ack', action: 'delete', id: 'm1', clientId: frame.clientId });
  assert.deepEqual(await deleted, { success: true, removed: false });

  const failed = community.block('bob');
  await tick();
  socket.push({ type: 'error', error: 'Your block list is full.', clientId: socket.sent.at(-1).clientId });
  assert.deepEqual(await failed, { success: false, error: 'Your block list is full.' });

  const report = community.reportMessage('m1', 'spam');
  await tick();
  socket.push({ type: 'ack', action: 'report', id: 'm1', removed: true, clientId: socket.sent.at(-1).clientId });
  assert.equal((await report).removed, true);

  const unblock = community.unblock('bob');
  await tick();
  socket.push({ type: 'ack', action: 'unblock', id: 'bob', clientId: socket.sent.at(-1).clientId });
  await unblock;

  assert.deepEqual(tracked, ['community_message_delete', 'community_report', 'community_unblock']);
  community.dispose();
});

test('service: bad input never reaches the lobby', async () => {
  const { community, socket } = await online();
  socket.sent.length = 0;
  assert.equal((await community.deleteMessage('<script>')).success, false);
  assert.equal((await community.block('')).success, false);
  assert.equal((await community.saveProfile({ avatar: { kind: 'img', data: 'https://evil.io/x.png' } })).success, false);
  assert.equal((await community.saveProfile({ name: '   ' })).success, false);
  assert.equal((await community.saveProfile({})).success, false);
  assert.equal(socket.sent.length, 0);

  const saved = community.saveProfile({ avatar: { kind: 'gen', style: 'flat', shape: 1, eyes: 2, color: null }, name: '  Mia  ' });
  await tick();
  assert.equal(socket.sent.at(-1).name, 'Mia');
  socket.push({ type: 'ack', action: 'profile', clientId: socket.sent.at(-1).clientId });
  assert.equal((await saved).success, true);

  community.disconnect();
  assert.equal((await community.deleteMessage('m1')).error, 'Connect to the lobby first.');
});
