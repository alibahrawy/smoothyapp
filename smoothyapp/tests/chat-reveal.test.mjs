import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../src/renderer/chat-reveal.js', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const { createWordReveal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture(reduced = false) {
  const pending = new Map(), values = []; let id = 0;
  const reveal = createWordReveal({ update: value => values.push(value), reducedMotion: () => reduced,
    schedule: fn => { pending.set(++id, fn); return id; }, unschedule: key => pending.delete(key) });
  const step = () => { const first = pending.entries().next().value; if (!first) return false; pending.delete(first[0]); first[1](); return true; };
  return { reveal, values, step, drain() { for (let i = 0; i < 100 && step(); i++); assert.equal(pending.size, 0); } };
}
test('real chunks wait for split words and reveal one complete word at a time, including the final word', async () => {
  const f = fixture(); f.reveal.feed('Hel'); f.drain(); assert.deepEqual(f.values, []);
  f.reveal.feed('lo there 🌟'); f.step(); assert.deepEqual(f.values, ['Hello ']);
  f.step(); assert.equal(f.values.at(-1), 'Hello there '); f.drain();
  const done = f.reveal.finish('Hello there 🌟'); f.drain(); await done;
  assert.equal(f.values.at(-1), 'Hello there 🌟');
});
test('a buffered provider reply is still paced, and Stop freezes visible text and resolves draining', async () => {
  const f = fixture(); const done = f.reveal.finish('One two three four');
  f.step(); assert.deepEqual(f.values, ['One ']); f.reveal.cancel(); await done;
  f.reveal.feed('Late words'); f.drain(); assert.deepEqual(f.values, ['One ']);
});
test('reduced motion shows received complete words together without jumping to a repeated future word', async () => {
  const f = fixture(true); f.reveal.feed('One One two incomplete'); f.drain();
  assert.deepEqual(f.values, ['One One two ']);
  const done = f.reveal.finish('One One two incomplete'); f.drain(); await done;
  assert.equal(f.values.at(-1), 'One One two incomplete');
});
