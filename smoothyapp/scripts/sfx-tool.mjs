#!/usr/bin/env node
/**
 * Maintains the bundled SFX library in resources/sfx.
 *
 *   node scripts/sfx-tool.mjs generate
 *       Re-renders the original synthesized sounds (no third-party audio) and
 *       updates their entries in library.json.
 *   node scripts/sfx-tool.mjs import <folder> --category "UI & clicks" --author "Kenney"
 *        --source https://kenney.nl/assets/ui-audio [--license CC0] [--prefix kenney-ui] [--tags a,b]
 *       Converts every wav/ogg/mp3/flac in <folder> to 48 kHz 16-bit WAV and adds it
 *       to the library. Only CC0 / public-domain packs are accepted.
 *   node scripts/sfx-tool.mjs sync
 *       Re-measures durations for every entry.
 *
 * Only add sounds whose license you have verified yourself. The library is
 * redistributed inside the app, so "free to use" is not enough: it must allow
 * redistribution (CC0 / public domain).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'resources', 'sfx');
const libraryPath = path.join(dir, 'library.json');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const RATE = 48000;

export const SYNTH_LICENSE = 'SmoothyEdit original';
const ACCEPTED_IMPORT_LICENSES = new Set(['CC0', 'Public domain']);

const run = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const duration = file => Number(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const title = value => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());

function load() { return fs.existsSync(libraryPath) ? JSON.parse(fs.readFileSync(libraryPath, 'utf8')) : []; }
function save(entries) {
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  fs.writeFileSync(libraryPath, JSON.stringify(entries, null, 2) + '\n');
}

function measurePeak(input) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', input, '-af', 'aformat=channel_layouts=stereo,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /max_volume:\s*(-?[\d.]+) dB/.exec(result.stderr || '');
  if (!match) throw new Error('Could not measure ' + input);
  return Number(match[1]);
}

function normalize(input, output, { fadeIn = 0.002, fadeOut = 0.02, target = -1 } = {}) {
  const gain = target - measurePeak(input);
  const length = duration(input);
  const filters = [`aformat=channel_layouts=stereo`, `volume=${gain.toFixed(2)}dB`, `afade=t=in:d=${fadeIn}`, `afade=t=out:st=${Math.max(0, length - fadeOut).toFixed(3)}:d=${fadeOut}`,
    `aformat=sample_fmts=s16:sample_rates=${RATE}:channel_layouts=stereo`];
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-af', filters.join(','), '-c:a', 'pcm_s16le', output]);
}

// ---- Synthesised sounds -------------------------------------------------------------------
const E = v => v.toFixed(5);
const tone = (f, start, decay, amp = 1, partials = [[1, 1], [2.76, 0.35], [5.4, 0.15]]) =>
  partials.map(([m, a]) => `${E(amp * a)}*gt(t,${start})*exp(-${decay}*(t-${start}))*sin(2*PI*${E(f * m)}*t)`).join('+');
const sine = (expr, length) => `aevalsrc='${expr}':s=${RATE}:d=${length}`;
const noise = (length, seed, color = 'white', amp = 0.6) => `anoisesrc=d=${length}:c=${color}:r=${RATE}:a=${amp}:seed=${seed}`;
const swell = (center, width) => `exp(-pow((t-${center})/${width},2))`;

/** Noise whoosh: six bands whose loudness peaks one after another so the energy sweeps upward. */
function whoosh(length, seed, { low = 300, high = 7000, peak = 0.5, label = 'out' } = {}) {
  const bands = 6, w = length / 6.5, centers = Array.from({ length: bands }, (_, i) => low * Math.pow(high / low, i / (bands - 1)));
  const lines = [`${noise(length, seed, 'white', 0.9)},asplit=${bands}${centers.map((_, i) => `[s${i}]`).join('')}`];
  centers.forEach((f, i) => {
    const at = length * peak + (i - (bands - 1) / 2) * w * 0.8;
    lines.push(`[s${i}]bandpass=f=${Math.round(f)}:w=1.1,volume='${swell(at.toFixed(4), w.toFixed(4))}':eval=frame[b${i}]`);
  });
  lines.push(`${centers.map((_, i) => `[b${i}]`).join('')}amix=inputs=${bands}:normalize=0,lowpass=f=10000[${label}]`);
  return lines.join(';');
}

function riser(length, f0, f1, seed) {
  const k = (f1 - f0) / (2 * length);
  return [
    `${sine(`pow(t/${length},2)*0.55*sin(2*PI*(${f0}*t+${E(k)}*t*t))`, length)}[tone]`,
    `${noise(length, seed, 'white', 0.8)},highpass=f=1200,volume='pow(t/${length},2.4)*0.7':eval=frame[hiss]`,
    `${sine(`pow(t/${length},3)*0.35*sin(2*PI*(${f0 / 2}*t+${E(k / 2)}*t*t))`, length)}[sub]`,
    `[tone][hiss][sub]amix=inputs=3:normalize=0[out]`,
  ].join(';');
}

function downlifter(length, f0, f1, seed) {
  const k = (f1 - f0) / (2 * length);
  return [
    `${sine(`pow(1-t/${length},2)*0.55*sin(2*PI*(${f0}*t+${E(k)}*t*t))`, length)}[tone]`,
    `${noise(length, seed, 'white', 0.8)},highpass=f=900,lowpass=f=7000,volume='pow(1-t/${length},2)*0.6':eval=frame[hiss]`,
    `[tone][hiss]amix=inputs=2:normalize=0[out]`,
  ].join(';');
}

const impact = (length, seed, { start = 62, drop = 140, body = 7, grit = 12, echo = true } = {}) => [
  `${sine(`0.95*exp(-${body}*t)*sin(2*PI*(${start}*t+${drop}*(1-exp(-28*t))/28))`, length)}[thump]`,
  `${noise(length, seed, 'white', 0.9)},lowpass=f=3200,highpass=f=80,volume='exp(-${grit}*t)*0.9':eval=frame[crack]`,
  `${noise(length, seed + 1, 'brown', 0.9)},lowpass=f=420,volume='exp(-${body * 0.45}*t)*0.8':eval=frame[rumble]`,
  `[thump][crack][rumble]amix=inputs=3:normalize=0${echo ? ',aecho=0.8:0.55:45|110:0.35|0.18' : ''}[out]`,
].join(';');

const SYNTH = [
  { id: 'riser-cinematic', title: 'Cinematic riser', category: 'Risers & drops', length: 4, tags: ['riser', 'build up', 'tension', 'cinematic', 'transition'], graph: () => riser(4, 140, 2200, 11) },
  { id: 'riser-short', title: 'Quick riser', category: 'Risers & drops', length: 1.6, tags: ['riser', 'build up', 'short', 'transition'], graph: () => riser(1.6, 260, 2800, 12) },
  { id: 'downlifter', title: 'Downlifter', category: 'Risers & drops', length: 2, tags: ['downlifter', 'fall', 'release', 'transition'], graph: () => downlifter(2, 2200, 120, 13) },
  { id: 'sub-drop', title: 'Sub drop', category: 'Risers & drops', length: 2.4, tags: ['bass drop', 'sub', 'low', 'boom'],
    graph: () => `${sine('0.95*exp(-1.5*t)*sin(2*PI*(36*t+84*(1-exp(-5*t))/5))', 2.4)}[out]` },
  { id: 'boom-cinematic', title: 'Cinematic boom', category: 'Hits & impacts', length: 3.2, tags: ['boom', 'impact', 'trailer', 'cinematic', 'hit'], graph: () => impact(3.2, 21, { start: 48, drop: 110, body: 2.4, grit: 7 }) },
  { id: 'hit-heavy', title: 'Heavy hit', category: 'Hits & impacts', length: 1.3, tags: ['hit', 'impact', 'thud', 'title', 'stinger'], graph: () => impact(1.3, 22, { body: 6, grit: 11 }) },
  { id: 'hit-punch', title: 'Punch hit', category: 'Hits & impacts', length: 0.5, tags: ['hit', 'punch', 'short', 'tight', 'emphasis'], graph: () => impact(0.5, 23, { start: 90, drop: 160, body: 16, grit: 26, echo: false }) },
  { id: 'whoosh-fast', title: 'Fast whoosh', category: 'Whooshes & swipes', length: 0.7, tags: ['whoosh', 'swoosh', 'transition', 'fast', 'cut'], graph: () => whoosh(0.7, 31) },
  { id: 'whoosh-long', title: 'Long whoosh', category: 'Whooshes & swipes', length: 1.5, tags: ['whoosh', 'swoosh', 'transition', 'long', 'slide'], graph: () => whoosh(1.5, 32, { peak: 0.55 }) },
  { id: 'whoosh-reverse', title: 'Reverse whoosh', category: 'Whooshes & swipes', length: 1.1, tags: ['whoosh', 'reverse', 'suck in', 'transition', 'zoom'],
    graph: () => `${whoosh(1.1, 33, { peak: 0.8, label: 'pre' })};[pre]areverse[out]` },
  { id: 'swipe-ui', title: 'UI swipe', category: 'Whooshes & swipes', length: 0.28, tags: ['swipe', 'ui', 'slide', 'short', 'interface'], graph: () => whoosh(0.28, 34, { low: 700, high: 7500 }) },
  { id: 'pop', title: 'Pop', category: 'Pops & clicks', length: 0.16, tags: ['pop', 'bubble', 'text', 'appear', 'ui'],
    graph: () => `${sine('exp(-34*t)*sin(2*PI*(260*t+1000*(1-exp(-70*t))/70))', 0.16)}[out]` },
  { id: 'pop-double', title: 'Double pop', category: 'Pops & clicks', length: 0.3, tags: ['pop', 'double', 'text', 'appear', 'ui'],
    graph: () => `${sine('exp(-36*t)*sin(2*PI*(300*t+1000*(1-exp(-70*t))/70))+gt(t,0.11)*exp(-36*(t-0.11))*sin(2*PI*(360*t+1000*(1-exp(-70*(t-0.11)))/70))', 0.3)}[out]` },
  { id: 'click-soft', title: 'Soft click', category: 'Pops & clicks', length: 0.08, tags: ['click', 'tap', 'ui', 'button', 'soft'],
    graph: () => `${noise(0.08, 41, 'white', 0.9)},bandpass=f=3200:w=1.2,volume='exp(-120*t)':eval=frame[n];${sine('0.6*exp(-90*t)*sin(2*PI*1900*t)', 0.08)}[t];[n][t]amix=inputs=2:normalize=0[out]` },
  { id: 'chime-notification', title: 'Notification chime', category: 'Chimes & UI', length: 1.4, tags: ['notification', 'chime', 'ding', 'message', 'bell', 'alert'],
    graph: () => sine(`${tone(1318.5, 0, 3.4, 0.55)}+${tone(1760, 0.14, 3.2, 0.6)}`, 1.4) + '[out]' },
  { id: 'chime-success', title: 'Success arpeggio', category: 'Chimes & UI', length: 1.2, tags: ['success', 'complete', 'level up', 'win', 'arpeggio'],
    graph: () => sine([[1046.5, 0], [1318.5, 0.09], [1568, 0.18], [2093, 0.27]].map(([f, s]) => tone(f, s, 4.2, 0.4)).join('+'), 1.2) + '[out]' },
  { id: 'buzz-error', title: 'Error buzz', category: 'Chimes & UI', length: 0.5, tags: ['error', 'wrong', 'buzz', 'denied', 'fail'],
    graph: () => sine('0.5*lt(mod(t,0.22),0.15)*(sin(2*PI*140*t)+0.5*sin(2*PI*280*t)+0.33*sin(2*PI*420*t)+0.2*sin(2*PI*560*t))*exp(-1.5*t)', 0.5) + '[out]' },
  { id: 'shimmer', title: 'Sparkle shimmer', category: 'Chimes & UI', length: 1.6, tags: ['sparkle', 'shimmer', 'magic', 'glitter', 'reveal'],
    graph: () => sine([[3520, 0], [4186, 0.07], [3136, 0.15], [4699, 0.22], [3951, 0.31], [5274, 0.4], [4435, 0.52]].map(([f, s]) => tone(f, s, 5.5, 0.28, [[1, 1], [2.01, 0.25]])).join('+'), 1.6) + '[out]' },
  { id: 'glitch-short', title: 'Glitch', category: 'Glitch & digital', length: 0.55, tags: ['glitch', 'digital', 'stutter', 'error', 'distortion'],
    graph: () => `${sine('lt(mod(t,0.075),0.032)*(0.5*(random(0)*2-1)+0.5*sin(2*PI*(260+620*mod(floor(t*13.33),4))*t))', 0.55)},acrusher=bits=5:mode=lin:mix=0.8[out]` },
  { id: 'tape-stop', title: 'Tape stop', category: 'Glitch & digital', length: 1.1, tags: ['tape stop', 'power down', 'slow down', 'record', 'rewind'],
    graph: () => `${sine('0.7*exp(-0.8*t)*(sin(2*PI*900*(1-exp(-3.5*t))/3.5)+0.4*sin(4*PI*900*(1-exp(-3.5*t))/3.5))', 1.1)}[out]` },
];

function generate() {
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-sfx-'));
  const entries = load().filter(entry => entry.origin !== 'synth');
  try {
    for (const item of SYNTH) {
      const raw = path.join(work, item.id + '.wav');
      const graph = item.graph();
      const labelled = /\[out\]$/.test(graph) ? graph : graph + '[out]';
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex', labelled, '-map', '[out]', '-t', String(item.length), '-ar', String(RATE), '-c:a', 'pcm_f32le', raw]);
      const file = `synth/${item.id}.wav`;
      fs.mkdirSync(path.join(dir, 'synth'), { recursive: true });
      normalize(raw, path.join(dir, file), { fadeOut: item.length > 1 ? 0.05 : 0.01 });
      entries.push({ id: item.id, title: item.title, category: item.category, tags: item.tags, file, license: SYNTH_LICENSE, author: 'SmoothyEdit',
        sourceUrl: '', origin: 'synth', duration: Math.round(duration(path.join(dir, file)) * 1000) / 1000 });
      console.log('rendered', item.id);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  save(entries);
}

function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[++i]; else out._.push(list[i]);
  }
  return out;
}

function importPack(argv) {
  const options = args(argv), folder = options._[0];
  if (!folder || !fs.statSync(folder).isDirectory()) throw new Error('Pass the folder that holds the pack.');
  const license = options.license || 'CC0';
  if (!ACCEPTED_IMPORT_LICENSES.has(license)) throw new Error('Only CC0 or Public domain sounds can be bundled. Got: ' + license);
  for (const required of ['category', 'author', 'source']) if (!options[required]) throw new Error(`Missing --${required}.`);
  const prefix = slug(options.prefix || options.author);
  const entries = load(), have = new Set(entries.map(entry => entry.id));
  const files = [];
  (function walk(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full); else if (/\.(wav|ogg|mp3|flac)$/i.test(item.name)) files.push(full);
    }
  })(folder);
  files.sort();
  fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-sfx-'));
  let added = 0;
  try {
    for (const source of files) {
      const base = path.basename(source).replace(/\.[^.]+$/, '');
      const id = `${prefix}-${slug(base)}`;
      if (have.has(id)) { console.log('skip (exists)', id); continue; }
      const raw = path.join(work, id + '.wav');
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, '-vn', '-c:a', 'pcm_f32le', raw]);
      const length = duration(raw);
      if (!(length > 0.02 && length <= 15)) { console.log('skip (length)', base); continue; }
      const file = `packs/${id}.wav`;
      normalize(raw, path.join(dir, file), { fadeOut: 0.005, target: -3 });
      entries.push({ id, title: title(base), category: options.category, tags: [...new Set([...(options.tags ? options.tags.split(',') : []), ...base.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(word => word.length > 2)])],
        file, license, author: options.author, sourceUrl: options.source, origin: 'cc0', duration: Math.round(length * 1000) / 1000 });
      have.add(id); added++;
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  save(entries);
  console.log(`Added ${added} sounds.`);
}

function sync() {
  const entries = load();
  for (const entry of entries) entry.duration = Math.round(duration(path.join(dir, entry.file)) * 1000) / 1000;
  save(entries);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'generate') generate();
else if (command === 'import') importPack(rest);
else if (command === 'sync') sync();
else { console.error('Usage: sfx-tool.mjs generate | import <folder> --category C --author A --source URL | sync'); process.exit(1); }
