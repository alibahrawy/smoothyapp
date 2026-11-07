import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeRequire = createRequire(import.meta.url);

function loadCjs(code) {
  const module = { exports: {} };
  const dirname = path.join(root, 'out', 'main');
  new Function('module', 'exports', 'require', '__dirname', '__filename', code)(
    module,
    module.exports,
    nodeRequire,
    dirname,
    path.join(dirname, 'index.js')
  );
  return module.exports;
}

async function bundle(entry, stubs = {}) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['qrcode-generator'],
    plugins: [
      {
        name: 'shortscuts-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'shortscuts-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'shortscuts-stub' }, () => ({
            contents: stubs.electron || 'export const globalShortcut = { register: () => true, unregister: () => {}, unregisterAll: () => {} };',
            loader: 'js',
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

function memoryStore(initial = new Map()) {
  return {
    get: (key) => initial.get(key),
    set: (key, value) => initial.set(key, value),
    values: initial,
  };
}

const storeModule = loadCjs(await bundle('src/main/shortscuts/store.ts'));
const { createShortsCutsStore, defaultShortsCutsConfig, validateShortsCutsConfig, sanitizeShortsCutsConfig } = storeModule;

test('ShortsCuts defaults are non-destructive and edits are validated', () => {
  const defaults = defaultShortsCutsConfig();
  assert.equal(defaults.deck.length, 6);
  assert.equal(defaults.serverPort, 4789);
  assert.equal(defaults.serverEnabled, false);
  assert.equal(defaults.deck[0].shortcut, 'CommandOrControl+Alt+1');

  const store = createShortsCutsStore(memoryStore());
  assert.equal(store.get().deck.length, 6);

  const deck = store.saveDeck([
    { id: 'one', label: 'Crop', kind: 'video-effect', target: 'Crop', shortcut: 'Control+Alt+7' },
  ]).deck;
  assert.equal(deck.length, 1);
  assert.equal(deck[0].shortcut, 'Control+Alt+7');

  assert.throws(
    () => validateShortsCutsConfig({ deck: [
      { id: 'a', label: 'A', kind: 'video-effect', target: 'Crop', shortcut: 'Control+Alt+1' },
      { id: 'b', label: 'B', kind: 'video-effect', target: 'Crop', shortcut: 'Control+Alt+1' },
    ], serverEnabled: false, serverPort: 4789 }),
    /already assigned/
  );
  assert.throws(
    () => validateShortsCutsConfig({ deck: [], serverEnabled: true, serverPort: 80 }),
    /port between 1024/
  );
  const sanitized = sanitizeShortsCutsConfig({ deck: [{ label: 'broken' }], serverEnabled: 'yes', serverPort: 99999 });
  assert.equal(sanitized.deck.length, 0);
  assert.equal(sanitized.serverEnabled, false);
  assert.equal(sanitized.serverPort, 4789);
});

test('ShortsCuts keeps folders, multi-actions, icons and colours', () => {
  const store = createShortsCutsStore(memoryStore());
  const saved = store.saveDeck({
    deck: [
      { id: 'crop', label: 'Crop', kind: 'video-effect', target: 'Crop', icon: 'crop', color: 'red', folderId: 'f1' },
      { id: 'blur', label: 'Blur', kind: 'video-effect', target: 'Gaussian Blur', icon: 'not-an-icon', color: 'nope' },
      { id: 'combo', label: 'Crop + blur', kind: 'multi', steps: ['crop', 'blur', 'missing', 'combo'] },
    ],
    folders: [{ id: 'f1', label: 'Looks', icon: 'star', color: 'violet' }],
    layout: { phoneColumns: 9, tabletColumns: 4 },
  });
  assert.equal(saved.deck[0].icon, 'crop');
  assert.equal(saved.deck[0].color, 'red');
  assert.equal(saved.deck[0].folderId, 'f1');
  assert.equal(saved.deck[1].icon, undefined);
  assert.equal(saved.deck[1].color, undefined);
  assert.deepEqual(saved.deck[2].steps, ['crop', 'blur']);
  assert.equal(saved.folders[0].label, 'Looks');
  assert.deepEqual(saved.layout, { phoneColumns: 5, tabletColumns: 4 });

  // Deleting a folder's record sends its keys back to the top level.
  const noFolder = store.saveDeck({ deck: saved.deck, folders: [] });
  assert.equal(noFolder.deck[0].folderId, undefined);
  // A plain array save keeps the folders and layout.
  const kept = store.saveDeck(saved.deck);
  assert.deepEqual(kept.layout, { phoneColumns: 5, tabletColumns: 4 });

  assert.throws(
    () => store.saveDeck([{ id: 'empty', label: 'Empty', kind: 'multi', steps: [] }]),
    /needs at least one/
  );
  // More than the old 64-key limit is fine.
  const many = Array.from({ length: 150 }, (_, index) => ({ id: `k${index}`, label: `Key ${index}`, kind: 'video-effect', target: 'Crop' }));
  assert.equal(store.saveDeck(many).deck.length, 150);
});

test('ShortsCuts preserves an intentionally empty deck', () => {
  const store = createShortsCutsStore(memoryStore());
  const empty = store.saveDeck([]);
  assert.equal(empty.deck.length, 0);
  const reloaded = createShortsCutsStore(memoryStore(new Map([['shortscuts', empty]])));
  assert.equal(reloaded.get().deck.length, 0);
});

test('shortcut registration is atomic and suspends while recording', async () => {
  globalThis.__shortcutFixture = {
    map: new Map(),
    fail: new Set(['Alt+Q']),
    register(accelerator, callback) {
      if (this.fail.has(accelerator) || this.map.has(accelerator)) return false;
      this.map.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) { this.map.delete(accelerator); },
  };
  const managerModule = loadCjs(await bundle('src/main/shortscuts/shortcuts.ts', {
    electron: 'export const globalShortcut = globalThis.__shortcutFixture;',
  }));
  const triggered = [];
  const manager = managerModule.createShortcutManager((item) => triggered.push(item.id));
  const first = { id: 'first', label: 'Crop', kind: 'video-effect', target: 'Crop', shortcut: 'Control+Alt+1' };
  const second = { id: 'second', label: 'Blur', kind: 'video-effect', target: 'Gaussian Blur', shortcut: 'Control+Alt+2' };
  assert.equal(manager.register([first, second]).success, true);
  globalThis.__shortcutFixture.map.get('Control+Alt+1')();
  assert.deepEqual(triggered, ['first']);

  const conflict = manager.register([first, { ...second, shortcut: 'Alt+Q' }]);
  assert.equal(conflict.success, false);
  assert.match(conflict.error, /Alt\+Q/);
  assert.equal(globalThis.__shortcutFixture.map.has('Control+Alt+1'), true);
  assert.equal(globalThis.__shortcutFixture.map.has('Alt+Q'), false);

  manager.suspend();
  assert.equal(globalThis.__shortcutFixture.map.size, 0);
  manager.resume([first]);
  assert.equal(globalThis.__shortcutFixture.map.has('Control+Alt+1'), true);
  manager.unregisterAll();
  assert.equal(globalThis.__shortcutFixture.map.size, 0);
});

test('deck keys are held only while Premiere has focus', async () => {
  globalThis.__shortcutFixture = {
    map: new Map(),
    register(accelerator, callback) { if (this.map.has(accelerator)) return false; this.map.set(accelerator, callback); return true; },
    unregister(accelerator) { this.map.delete(accelerator); },
  };
  const managerModule = loadCjs(await bundle('src/main/shortscuts/shortcuts.ts', {
    electron: 'export const globalShortcut = globalThis.__shortcutFixture;',
  }));
  const frontmost = loadCjs(await bundle('src/main/shortscuts/frontmost.ts'));
  assert.equal(frontmost.shortcutsAllowedFor('Adobe Premiere Pro 2026'), true);
  assert.equal(frontmost.shortcutsAllowedFor('SmoothyEdit'), true);
  assert.equal(frontmost.shortcutsAllowedFor(null), true);
  assert.equal(frontmost.shortcutsAllowedFor('Google Chrome'), false);

  const manager = managerModule.createShortcutManager(() => {});
  const item = { id: 'first', label: 'Crop', kind: 'video-effect', target: 'Crop', shortcut: 'Control+Alt+1' };
  assert.equal(manager.register([item]).success, true);
  manager.setFocusAllowed(false);
  assert.equal(globalThis.__shortcutFixture.map.size, 0);
  assert.equal(manager.snapshot()[0].registered, true);
  // Saving the deck while another app is in front must not grab keys.
  assert.equal(manager.register([item]).success, true);
  assert.equal(globalThis.__shortcutFixture.map.size, 0);
  manager.setFocusAllowed(true);
  assert.equal(globalThis.__shortcutFixture.map.has('Control+Alt+1'), true);
  manager.unregisterAll();
});

test('phone remote requires its token and applies only deck ids', async (t) => {
  const serverModule = loadCjs(await bundle('src/main/shortscuts/server.ts'));
  const applied = [];
  const server = new serverModule.ShortsCutsServer({
    getState: () => ({
      connected: true,
      editor: 'premiere',
      deck: [
        { id: 'crop', label: 'Crop', kind: 'video-effect' },
        { id: 'transition', label: 'Default transition', kind: 'video-transition' },
        { id: 'inside', label: 'Inside', kind: 'video-effect', folderId: 'looks' },
      ],
      folders: [{ id: 'looks', label: 'Looks', icon: 'folder', color: '#5f6b73' }],
      layout: { phoneColumns: 3, tabletColumns: 6 },
      lastAction: null,
    }),
    apply: async (id) => {
      applied.push(id);
      return id === 'crop' ? { success: true, message: 'Applied Crop.' } : { success: false, error: 'Premiere said no.' };
    },
  });
  t.after(() => server.stop());
  const initial = await server.start(0);
  assert.equal(initial.running, true);
  assert.match(initial.pageUrl, /\/m\//);
  assert.match(initial.qrDataUrl, /^data:image\/svg\+xml/);
  const base = `http://127.0.0.1:${initial.port}`;
  const token = initial.token;

  const page = await fetch(`${base}/m/${token}`, { headers: { connection: 'close' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Crop/);
  assert.match(html, /"connected":true/);
  const markup = html.split('<script>')[0];
  assert.equal((markup.match(/data-cut-id=/g) || []).length, 2);
  assert.equal((markup.match(/data-folder-id="looks"/g) || []).length, 1);
  assert.doesNotMatch(markup, /data-cut-id="inside"/);
  assert.doesNotMatch(markup, /Premiere connected/);
  assert.match(html, /"tabletColumns":6/);
  assert.equal((markup.match(/key-empty/g) || []).length, 0);
  assert.equal((markup.match(/page-label|page-prev/g) || []).length, 0);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');

  const unauthorized = await fetch(`${base}/api/wrong/state`, { headers: { connection: 'close' } });
  assert.equal(unauthorized.status, 401);
  const oldToken = token;
  await server.rotateToken();
  const rotated = await fetch(`${base}/api/${oldToken}/state`, { headers: { connection: 'close' } });
  assert.equal(rotated.status, 401);

  const newToken = server.state().token;
  const stateResponse = await fetch(`${base}/api/${newToken}/state`, { headers: { connection: 'close' } });
  assert.equal(stateResponse.status, 200);
  assert.equal((await stateResponse.json()).deck.length, 3);

  const appliedResponse = await fetch(`${base}/api/${newToken}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ id: 'crop' }),
  });
  assert.equal(appliedResponse.status, 200);
  assert.equal((await appliedResponse.json()).success, true);
  assert.deepEqual(applied, ['crop']);

  const unknown = await fetch(`${base}/api/${newToken}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ id: 'missing' }),
  });
  assert.equal(unknown.status, 404);
  server.stop();
});

test('ShortsCuts counts successful applies and captured presets once', async () => {
  globalThis.__shortcutFixture = {
    map: new Map(),
    register(accelerator, callback) { if (this.map.has(accelerator)) return false; this.map.set(accelerator, callback); return true; },
    unregister(accelerator) { this.map.delete(accelerator); },
  };
  const serviceModule = loadCjs(await bundle('src/main/shortscuts/service.ts', {
    electron: 'export const globalShortcut = globalThis.__shortcutFixture;',
  }));
  const tracked = [];
  let applyResult = { success: true, message: 'Applied.' };
  const service = serviceModule.createShortsCutsService({
    store: memoryStore(),
    applyToPremiere: async () => applyResult,
    readCatalog: async () => ({ videoEffects: ['Crop'], audioEffects: [], videoTransitions: [], audioTransitions: [] }),
    capturePreset: async () => ({
      success: true,
      name: 'Look',
      mediaType: 'video',
      components: [{ matchName: 'AE.ADBE Lumetri', displayName: 'Lumetri Color', properties: [{ name: 'Exposure', value: 0.5 }] }],
    }),
    connected: () => true,
    editor: () => 'premiere',
    allowed: () => true,
    track: (id) => tracked.push(id),
    onState: () => {},
  });
  service.init();
  assert.equal((await service.applyFromPanel('default-effect-crop')).success, true);
  assert.equal((await service.applyFromPanel('default-transition-video')).success, true);
  assert.deepEqual(tracked, ['shortscuts_effect', 'shortscuts_transition']);

  const captured = await service.capturePreset();
  assert.equal(captured.config.deck.length, 7);
  const preset = captured.config.deck.find((item) => item.kind === 'preset');
  assert.ok(preset);
  assert.equal((await service.applyFromPanel(preset.id)).success, true);
  assert.deepEqual(tracked, ['shortscuts_effect', 'shortscuts_transition', 'shortscuts_preset_save', 'shortscuts_preset']);

  applyResult = { success: false, error: 'No selected clips.' };
  assert.equal((await service.applyFromPanel('default-effect-crop')).success, false);
  assert.equal(tracked.length, 4);

  // A multi-action runs its keys in order and counts once.
  applyResult = { success: true, message: 'Applied.' };
  const withMulti = await service.saveDeck({
    deck: [...service.state().config.deck, { id: 'combo', label: 'Combo', kind: 'multi', steps: ['default-effect-crop', 'default-effect-mosaic'] }],
  });
  assert.equal(withMulti.config.deck.at(-1).kind, 'multi');
  // Adding the multi-action key counts once; captured presets use their own ID.
  assert.deepEqual(tracked.slice(4), ['shortscuts_key_add']);
  const multi = await service.applyFromPanel('combo');
  assert.equal(multi.success, true);
  assert.match(multi.message, /2 actions/);
  assert.deepEqual(tracked.slice(5), ['shortscuts_multi']);

  // Renaming, reordering and removing keys are configuration: no new events.
  const reordered = [...service.state().config.deck].reverse().map((item) => item.id === 'combo' ? { ...item, label: 'Renamed' } : item);
  await service.saveDeck({ deck: reordered });
  await service.saveDeck({ deck: service.state().config.deck.filter((item) => item.id !== 'default-effect-mirror') });
  assert.deepEqual(tracked.slice(6), []);

  // A rejected save (unknown multi-action step) adds no key event.
  await assert.rejects(service.saveDeck({
    deck: [...service.state().config.deck, { id: 'broken', label: 'Broken', kind: 'multi', steps: ['missing-step'] }],
  }));
  assert.deepEqual(tracked.slice(6), []);

  // Six default keys had shortcuts; one was removed above.
  assert.equal(service.state().shortcuts.length, 5);
  service.setCapturing(true);
  assert.equal(service.state().shortcuts.length, 0);
  service.setCapturing(false);
  assert.equal(service.state().shortcuts.length, 5);
  service.dispose();
  assert.equal(globalThis.__shortcutFixture.map.size, 0);
});

test('ShortsCuts gives free accounts six working keys and Pro unlimited keys', async () => {
  globalThis.__shortcutFixture = {
    map: new Map(),
    register(accelerator, callback) { if (this.map.has(accelerator)) return false; this.map.set(accelerator, callback); return true; },
    unregister(accelerator) { this.map.delete(accelerator); },
  };
  const serviceModule = loadCjs(await bundle('src/main/shortscuts/service.ts', {
    electron: 'export const globalShortcut = globalThis.__shortcutFixture;',
  }));
  let pro = false;
  const tracked = [];
  let applied = 0;
  const service = serviceModule.createShortsCutsService({
    store: memoryStore(),
    applyToPremiere: async () => { applied += 1; return { success: true, message: 'Applied.' }; },
    readCatalog: async () => ({ videoEffects: ['Crop'], audioEffects: [], videoTransitions: [], audioTransitions: [] }),
    capturePreset: async () => ({ success: true, name: 'Look', mediaType: 'video', components: [{ matchName: 'x', displayName: 'X', properties: [] }] }),
    connected: () => true,
    editor: () => 'premiere',
    allowed: () => pro,
    track: (id) => tracked.push(id),
    onState: () => {},
  });
  service.init();
  const state = service.state();
  assert.equal(state.locked, false);
  assert.equal(state.pro, false);
  assert.equal(state.freeKeys, 6);
  assert.equal(state.config.deck.length, 6, 'the default deck fits the free plan');
  assert.equal(globalThis.__shortcutFixture.map.size, 6, 'free keys are registered');
  assert.equal((await service.applyFromPanel('default-effect-crop')).success, true);
  assert.equal(applied, 1);
  assert.equal((await service.catalog()).videoEffects[0], 'Crop');
  await service.setServer({ enabled: true, port: 4999 });
  assert.equal(service.state().server.running, true, 'the phone remote works on the free plan');
  await service.setServer({ enabled: false });

  const seventh = { id: 'extra-7', label: 'Extra', kind: 'video-effect', target: 'Crop', shortcut: 'CommandOrControl+Alt+7' };
  await assert.rejects(() => service.saveDeck([...state.config.deck, seventh]), /free plan includes 6/);
  await assert.rejects(() => service.capturePreset(), /free plan includes 6/);
  await service.saveDeck(state.config.deck.slice(1));
  assert.equal(service.state().config.deck.length, 5, 'free decks can shrink');

  pro = true;
  service.refreshEntitlement();
  assert.equal(service.state().pro, true);
  await service.saveDeck([...service.state().config.deck, seventh, { ...seventh, id: 'extra-8', shortcut: 'CommandOrControl+Alt+8' }]);
  assert.equal(service.state().config.deck.length, 7);
  assert.equal(globalThis.__shortcutFixture.map.size, 7, 'Pro registers every key');
  assert.equal((await service.applyFromPanel('extra-8')).success, true);

  pro = false;
  service.refreshEntitlement();
  assert.equal(service.state().config.deck.length, 7, 'a downgrade keeps the saved deck');
  assert.equal(globalThis.__shortcutFixture.map.size, 6, 'only the first six keys stay active after a downgrade');
  assert.match((await service.applyFromPanel('extra-8')).error, /free plan includes 6/);
  service.dispose();
});
