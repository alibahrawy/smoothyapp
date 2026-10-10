/** Pace complete words from real stream chunks. An unfinished word waits for
 * its next chunk; reduced motion shows each received chunk without animation. */
export function createWordReveal({ update, reducedMotion = () => false, schedule = setTimeout, unschedule = clearTimeout }) {
  let text = '', visible = '', ended = false, canceled = false, timer = null, resolve;
  const finished = new Promise(done => { resolve = done; });
  function tick() {
    timer = null;
    if (canceled) return;
    const pending = text.slice(visible.length);
    const next = pending.match(ended ? /^\s*\S+(?:\s+|$)|^\s+$/ : /^\s*\S+\s+|^\s+$/)?.[0];
    if (next) {
      if (reducedMotion()) {
        const complete = ended || /\s$/.test(text) ? text.length : text.search(/\S+$/);
        visible = text.slice(0, Math.max(visible.length, complete));
      } else visible += next;
      update(visible);
    }
    if (ended && visible.length === text.length) { resolve(); return; }
    if (next) {
      const waiting = (text.slice(visible.length).match(/\S+/g) || []).length;
      timer = schedule(tick, reducedMotion() ? 0 : Math.max(10, Math.min(38, 12 + 450 / Math.max(1, waiting))));
    }
  }
  function wake() { if (timer === null && !canceled) timer = schedule(tick, 0); }
  return {
    feed(delta) { if (ended || canceled || !delta) return; text += delta; wake(); },
    finish(value) { if (canceled) return finished; text = value; ended = true; wake(); return finished; },
    cancel() { canceled = true; if (timer !== null) unschedule(timer); timer = null; resolve(); },
  };
}
