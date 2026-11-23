import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/main/nudges.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const api = (() => { const context = { module: { exports: {} } }; vm.createContext(context); vm.runInContext(bundle.outputFiles[0].text, context); return context.module.exports; })();
const HOUR = 3600_000, DAY = 24 * HOUR;

function fixture({ pro = false, saved } = {}) {
  const data = new Map(saved ? [['nudges', saved]] : []);
  const store = { get: k => data.get(k), set: (k, v) => data.set(k, JSON.parse(JSON.stringify(v))) };
  let clock = 1_000 * DAY;
  const shown = [], tracked = [];
  const deps = { store, isPro: () => pro, notify: p => shown.push(p), track: id => tracked.push(id), now: () => clock };
  const n = api.createNudges(deps);
  return { n, shown, tracked, data, deps, tick: ms => { clock += ms; }, relaunch: () => api.createNudges(deps), setPro: v => { pro = v; } };
}
const run = (n, times, tool = 'multicam') => { for (let i = 0; i < times; i++) n.recordRun(tool); };

test('only finished tools count; searches, previews and sign-ins do not', () => {
  const f = fixture();
  ['stock_search', 'audio_preview', 'auth_login', 'shortscuts_effect', 'agent_engine_run', 'chat_copy'].forEach(t => f.n.recordRun(t));
  assert.equal(f.n.snapshot().runs, 0);
  run(f.n, 2, 'captions_export');
  assert.equal(f.n.snapshot().runs, 2);
  assert.equal(f.shown.length, 0);
});

test('social comes first at 3 tools, then Pro waits for the next launch and 20 hours', () => {
  const f = fixture();
  run(f.n, 3);
  assert.deepEqual(f.shown.map(p => p.kind), ['social']);
  f.n.shown('social'); f.n.action('social', 'skip');
  run(f.n, 5); // 8 runs: Pro is due, but one per launch
  assert.equal(f.shown.length, 1);
  let next = f.relaunch(); next.recordRun('multicam');
  assert.equal(f.shown.length, 1, 'still inside the 20-hour cooldown');
  f.tick(20 * HOUR); next = f.relaunch(); next.recordRun('silence');
  assert.equal(f.shown.at(-1).kind, 'pro');
  assert.ok(f.tracked.includes('nudge_social_shown') && f.tracked.includes('nudge_social_skip'));
});

test('Pro skips wait 10, then 20, then 20 tools', () => {
  const f = fixture({ saved: { runs: 0, lastShownAt: 0, pro: { nextAt: 5, skips: 0 }, social: { nextAt: 3, skips: 0, done: true } } });
  let n = f.n;
  const showsAt = [];
  for (let i = 1; i <= 60; i++) {
    const before = f.shown.length;
    n.recordRun('multicam');
    if (f.shown.length > before) { showsAt.push(i); n.shown('pro'); n.action('pro', 'skip'); f.tick(DAY); n = f.relaunch(); }
  }
  assert.deepEqual(showsAt, [5, 15, 35, 55]);
});

test('Upgrade without subscribing waits like a skip; Pro members never see it', () => {
  const f = fixture({ saved: { runs: 4, lastShownAt: 0, pro: { nextAt: 5, skips: 0 }, social: { nextAt: 3, skips: 0, done: true } } });
  f.n.recordRun('multicam'); f.n.shown('pro'); f.n.action('pro', 'upgrade');
  assert.equal(f.n.snapshot().pro.nextAt, 15);
  assert.ok(f.tracked.includes('nudge_pro_upgrade'));
  f.setPro(true); f.tick(2 * DAY);
  const n = f.relaunch(); run(n, 20);
  assert.equal(f.shown.length, 1);
});

test('opening a social link or "already follow" stops the social reminder for good', () => {
  for (const action of ['discord', 'already']) {
    const f = fixture({ pro: true });
    run(f.n, 3); f.n.shown('social'); f.n.action('social', action);
    assert.equal(f.n.snapshot().social.done, true);
    assert.ok(f.tracked.includes(`nudge_social_${action}`));
    f.tick(60 * DAY); const n = f.relaunch(); run(n, 100);
    assert.equal(f.shown.length, 1);
  }
});

test('social skips also wait days; a dropped reminder is offered again after the next tool', () => {
  const f = fixture({ pro: true });
  run(f.n, 3); f.n.dropped('social'); f.n.recordRun('multicam');
  assert.equal(f.shown.length, 2, 'offered again after a drop');
  f.n.shown('social'); f.n.action('social', 'skip');
  assert.equal(f.n.snapshot().social.nextAt, 4 + 15);
  f.tick(2 * DAY); let n = f.relaunch(); run(n, 20);
  assert.equal(f.shown.length, 2, 'enough tools but not 7 days yet');
  f.tick(6 * DAY); n = f.relaunch(); n.recordRun('multicam');
  assert.equal(f.shown.length, 3);
});

test('previews change nothing and unknown actions are ignored', () => {
  const f = fixture();
  f.n.preview('pro'); f.n.shown('pro', true); f.n.action('pro', 'skip', true);
  f.n.action('social', 'tiktok'); f.n.action('pro', 'discord');
  assert.deepEqual(f.tracked, []);
  assert.equal(f.n.snapshot().pro.skips, 0);
  assert.equal(f.shown[0].preview, true);
});

test('a corrupt saved state falls back to defaults', () => {
  const f = fixture({ saved: { runs: 'x', pro: null, social: { nextAt: -4 } } });
  assert.deepEqual({ runs: f.n.snapshot().runs, pro: f.n.snapshot().pro.nextAt, social: f.n.snapshot().social.nextAt }, { runs: 0, pro: 5, social: 3 });
});

test('status reports the cooldown and whether one was shown this launch', () => {
  const f = fixture();
  assert.equal(f.n.status().cooldownMs, 0);
  run(f.n, 3); f.n.shown('social');
  const s = f.n.status();
  assert.equal(s.shownThisLaunch, true);
  assert.equal(s.cooldownMs, 20 * HOUR);
  f.tick(5 * HOUR);
  assert.equal(f.n.status().cooldownMs, 15 * HOUR);
});
