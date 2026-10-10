import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function load(relative) {
  const result = await build({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const pref = await load('../src/main/app-preferences.ts');
const writing = JSON.parse(await fs.readFile(new URL('../src/shared/chat-writing.json', import.meta.url), 'utf8'));
const expectedPreferences = (studioEnabled = true) => ({ studioEnabled, chatPromptVersion: 2, chatWritingPrompt: writing.defaultPrompt });
const studio = await load('../src/main/studio-service.ts');
const draft = await load('../src/renderer/studio-text.js');
function memoryStore(saved) { const values = { appPreferences: saved }; return { values, get: key => values[key], set: (key, value) => { values[key] = value; } }; }

test('AI preference persists across restarts and notifies the renderer without support state', () => {
  const store = memoryStore(); let changes = 0;
  const service = pref.createAppPreferences(store, () => changes++);
  assert.deepEqual(service.snapshot(), expectedPreferences());
  assert.deepEqual(service.setStudioEnabled(false), expectedPreferences(false));
  assert.equal(changes, 1);
  const reload = pref.createAppPreferences(store);
  assert.deepEqual(reload.snapshot(), expectedPreferences(false));
  reload.setStudioEnabled(true);
  assert.deepEqual(pref.createAppPreferences(store).snapshot(), expectedPreferences());
});

test('legacy donation preferences cannot restore a reminder or change a saved AI opt-out', () => {
  const store = memoryStore({ studioEnabled: false, toolUses: 90, supportShown: false, supportHidden: false });
  const service = pref.createAppPreferences(store);
  assert.deepEqual(service.snapshot(), expectedPreferences(false));
  assert.throws(() => service.setStudioEnabled('false'));
  assert.deepEqual(service.snapshot(), expectedPreferences(false));
  service.setStudioEnabled(false);
  assert.deepEqual(store.values.appPreferences, expectedPreferences(false));
});

test('writing preferences persist separately; successful changed instruction saves/reset count without toggle/read events', () => {
  const store = memoryStore(), events = [];
  const service = pref.createAppPreferences(store, () => {}, id => events.push(id));
  assert.equal(service.snapshot().chatWritingPrompt, '');
  assert.deepEqual(events, []);
  service.saveChatWritingPrompt('  Keep sentences short.  ');
  assert.deepEqual(events, ['chat_writing_save']);
  const reloaded = pref.createAppPreferences(store);
  assert.equal(reloaded.snapshot().chatWritingPrompt, 'Keep sentences short.');
  service.setStudioEnabled(false);
  assert.equal(service.snapshot().chatWritingPrompt, 'Keep sentences short.');
  service.saveChatWritingPrompt('Keep sentences short.'); assert.equal(events.length, 1);
  service.resetChatWritingPrompt(); assert.equal(events.length, 2);
  assert.equal(service.snapshot().chatWritingPrompt, writing.defaultPrompt);
  assert.equal(service.snapshot().studioEnabled, false);
  service.resetChatWritingPrompt(); assert.equal(events.length, 2);
  service.saveChatWritingPrompt('Next prompt'); service.saveChatWritingPrompt('  ');
  assert.equal(service.snapshot().chatWritingPrompt, ''); assert.equal(events.length, 4);
});

test('retired Natural writing preferences start empty without writing or telemetry; newly saved prompts persist', () => {
  for (const naturalWritingEnabled of [true, false]) {
    const store = memoryStore({studioEnabled: false, naturalWritingEnabled, chatWritingPrompt: 'Old natural style'}), events = [];
    const service = pref.createAppPreferences(store, () => {}, id => events.push(id));
    assert.equal(service.snapshot().chatWritingPrompt, ''); assert.equal(service.snapshot().studioEnabled, false);
    assert.equal(store.values.appPreferences.chatWritingPrompt, 'Old natural style'); assert.deepEqual(events, []);
    service.setStudioEnabled(true); assert.equal(service.snapshot().chatWritingPrompt, ''); assert.deepEqual(events, []);
    service.saveChatWritingPrompt('New custom prompt'); assert.equal(pref.createAppPreferences(store).snapshot().chatWritingPrompt, 'New custom prompt');
    assert.deepEqual(events, ['chat_writing_save']);
  }
});

test('invalid/failed writing saves do not count; analytics/renderer failure cannot block persisted saves', () => {
  const store = memoryStore(), events = [], service = pref.createAppPreferences(store, () => {}, id => events.push(id));
  for (const invalid of [null, false, {}, 'x'.repeat(4001)]) assert.throws(() => service.saveChatWritingPrompt(invalid));
  assert.deepEqual(events, []);
  const bad = pref.createAppPreferences({ ...store, set: () => { throw Error('Disk full'); } }, () => {}, id => events.push(id));
  assert.throws(() => bad.saveChatWritingPrompt('Unsaved instructions'), /Disk/);
  assert.equal(service.snapshot().chatWritingPrompt, writing.defaultPrompt); assert.deepEqual(events, []);
  const resilient = pref.createAppPreferences(store, () => { throw Error('Window closed'); }, () => { throw Error('Offline'); });
  assert.equal(resilient.saveChatWritingPrompt('Saved instructions').chatWritingPrompt, 'Saved instructions');
  assert.equal(pref.createAppPreferences(memoryStore({ chatWritingPrompt: 'x'.repeat(4001) })).snapshot().chatWritingPrompt, writing.defaultPrompt);
});

test('disabling Studio rejects new cloud work and aborts the current signal; re-enabling starts a fresh signal', () => {
  let enabled = true; pref.configureStudioPreference(() => enabled);
  const old = pref.studioSignal(); enabled = false; pref.studioPreferenceChanged();
  assert.equal(old.aborted, true); assert.throws(pref.assertStudioEnabled, /turned off/); assert.throws(pref.studioSignal, /turned off/);
  enabled = true; assert.equal(pref.studioSignal().aborted, false); pref.configureStudioPreference(() => true);
});

function fixture(options = {}) {
  const f = { owner: 'a', enabled: true, calls: [], history: [], tracked: [], ...options };
  const service = studio.createStudioService({ owner: () => f.owner, enabled: () => f.enabled, track: id => f.tracked.push(id), verifyAccess: async mode => { if (f.pro === false && studio.studioProModes.includes(mode)) throw Error('Studio Pro required'); }, request: async (...args) => { f.calls.push(args); if (f.request) return f.request(...args); if (f.failure) throw Error(f.failure); return JSON.stringify({ draft: 'Idea' }); }, saveHistory: async (...args) => { if (f.historyFailure) throw Error('Offline'); f.history.push(args); } });
  return { f, service };
}
const input = (mode = 'title') => ({ mode, subtitleText: '00:00:01,000 --> 00:00:05,000\nA real transcript', fileName: 'Interview.srt', ...(mode === 'broll' && { videoType: 'Interview', brollCategories: ['stock footage', 'graphics'] }), ...(mode === 'condense' && { duration: 60 }) });

test('all nine Pick a Tool modes send canonical analysis bodies and save shared history once with a successful action ID', async () => {
  const { f, service } = fixture();
  for (const mode of studio.studioModes) {
    const result = await service.run(input(mode)); assert.equal(result.mode, mode); assert.equal(f.calls.at(-1)[0], '/api/analyze'); assert.equal(f.calls.at(-1)[1].analysisMode, mode);
    assert.equal(f.history.at(-1)[0], mode); assert.equal(f.tracked.at(-1), `studio_${mode}`);
  }
  assert.equal(studio.studioModes.length, 9); assert.equal(f.calls.length, 9); assert.equal(f.history.length, 9);
  const condensed = f.calls.find(([, body]) => body.analysisMode === 'condense'); assert.equal(condensed[1].duration, 60);
});

test('invalid, anonymous, disabled, Pro-only and failed-credit requests do not send or report successful tool use', async () => {
  const { f, service } = fixture();
  for (const value of [input('music'), { ...input(), subtitleText: '' }, { ...input('broll'), brollCategories: [] }, { ...input('condense'), duration: -1 }]) await assert.rejects(service.run(value));
  f.owner = null; await assert.rejects(service.run(input()), /Sign in/); f.owner = 'a'; f.enabled = false; await assert.rejects(service.run(input()), /turned off/); f.enabled = true; f.pro = false;
  await assert.rejects(service.run(input('thumbnail')), /Pro/); assert.equal(f.calls.length, 0);
  f.failure = 'No credits remaining'; await assert.rejects(service.run(input()), /No credits/); assert.deepEqual(f.tracked, []); assert.deepEqual(f.history, []);
  f.failure = ''; assert.equal((await service.run(input())).raw, '{"draft":"Idea"}');
});

test('refinements use the fixed follow-up schema; history failure preserves a usable draft and successful count', async () => {
  const { f, service } = fixture({ historyFailure: true });
  const result = await service.run({ ...input(), currentResult: '{"titles":["Original"]}', followUp: 'Make it shorter' });
  assert.match(result.warning, /Shared history/); assert.equal(f.calls[0][0], '/api/follow-up'); assert.equal(f.calls[0][1].followUpPrompt, 'Make it shorter'); assert.deepEqual(f.tracked, ['studio_refine']);
});

test('cancel, account change and disabled preference drop stale drafts and history without blocking subsequent work', async () => {
  for (const change of ['cancel', 'account', 'disabled']) {
    let finish; const { f, service } = fixture({ request: () => new Promise(resolve => { finish = resolve; }) });
    const job = service.run(input()); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.run(input()), /Wait/);
    if (change === 'cancel') service.cancel(); if (change === 'account') f.owner = 'b'; if (change === 'disabled') f.enabled = false;
    finish('{"titles":["Stale"]}'); await assert.rejects(job, /canceled/); assert.deepEqual(f.tracked, []); assert.deepEqual(f.history, []);
    f.enabled = true; f.request = null; assert.match((await service.run(input())).raw, /Idea/);
  }
});

test('drafts render every JSON structure as readable text, keeping HTML inert and Markdown untouched', () => {
  const value = draft.readableDraft('```json\n{"titleDrafts":[{"title":"<img src=x onerror=alert(1)>","reason":"Relevant"}]}\n```');
  assert.match(value, /Title Drafts/); assert.match(value, /<img src=x/); assert.match(value, /Reason: Relevant/);
  assert.equal(draft.readableDraft('# Blog draft\n\nA real story.'), '# Blog draft\n\nA real story.');
});

test('desktop labels/descriptions stay identical to the web Pick a Tool catalog when its source is present', async t => {
  const source = process.env.SMOOTHY_STUDIO_WEB_SOURCE || new URL('../../web/src/components/dashboard/toolPrefs.ts', import.meta.url).pathname;
  let text; try { text = await fs.readFile(source, 'utf8'); } catch { t.skip('Standalone app checkout; web source not bundled'); return; }
  const { transform } = await import('esbuild'); const ctx = { module: { exports: {} } };
  vm.runInNewContext((await transform(text, { loader: 'ts', format: 'cjs' })).code, ctx);
  const canonical = JSON.parse(JSON.stringify(ctx.module.exports.ALL_TOOLS.filter(tool => tool.id !== 'shorts').map(({id,label,description}) => ({id,label,description}))));
  const actual = JSON.parse(await fs.readFile(new URL('../src/shared/studio-catalog.json', import.meta.url), 'utf8')); assert.deepEqual(actual, canonical);
});
