#!/usr/bin/env node
// Rebuilds a Smoothy Pro caption template in smoothyapp-cep/mogrt/ by driving
// After Effects (macOS), then widens the slider ranges in its definition.json.
//
//   node scripts/pro-captions/build-mogrt.mjs                             Box Highlight (default)
//   node scripts/pro-captions/build-mogrt.mjs --template box-highlight    the same, explicitly
//   node scripts/pro-captions/build-mogrt.mjs --patch-only [--template …] only re-apply ranges
//
// A full rebuild needs Automation access to After Effects and AE's "Allow
// Scripts to Write Files and Access Network" setting. On Windows, run the .jsx
// from File > Scripts > Run Script File, then run this with --patch-only.
// SMOOTHY_AE_APP picks the After Effects version (a template only opens in
// Premiere versions at least as new as the AE that exported it).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// AE always exports sliders as 0–100; Premiere enforces these limits.
const TEMPLATES = {
  'box-highlight': {
    script: 'build-box-highlight-mogrt.jsx',
    name: 'Smoothy Box Highlight',
    file: 'smoothy-box-highlight.mogrt',
    ranges: {
      'Upcoming Word Opacity': [0, 100],
      'Box Opacity': [0, 100],
      'Box Radius': [0, 60],
      'Box Padding': [0, 80],
      'Box Height': [40, 240],
      'Shadow Opacity': [0, 100],
      'Caption Size': [25, 300],
      'Vertical Position': [0, 100],
    },
  },
};
const templateArg = process.argv.indexOf('--template');
const templateId = templateArg > -1 ? process.argv[templateArg + 1] : 'box-highlight';
const template = TEMPLATES[templateId];
if (!template) {
  console.error(`Unknown template "${templateId}". Use one of: ${Object.keys(TEMPLATES).join(', ')}`);
  process.exit(1);
}
const SLIDER_RANGES = template.ranges;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const script = path.join(here, template.script);
const mogrtFolder = path.join(repoRoot, 'smoothyapp-cep', 'mogrt');
const out = path.join(mogrtFolder, template.file);
const status = path.join(mogrtFolder, '.build-status.txt');
const staging = path.join(mogrtFolder, '.build');
const exported = path.join(staging, `${template.name}.mogrt`);
const appName = process.env.SMOOTHY_AE_APP || 'Adobe After Effects 2026';

function exportFromAfterEffects() {
  rmSync(status, { force: true });
  rmSync(staging, { recursive: true, force: true });
  const js = `$.global.SMOOTHY_REPO_ROOT = ${JSON.stringify(repoRoot)}; $.evalFile(${JSON.stringify(script)});`;
  execFileSync('osascript', ['-e', 'with timeout of 600 seconds', '-e', `tell application ${JSON.stringify(appName)} to DoScript ${JSON.stringify(js)}`, '-e', 'end timeout'], { stdio: 'inherit' });
  const result = existsSync(status) ? readFileSync(status, 'utf8').trim() : 'no status written (is AE idle, and is file access allowed?)';
  rmSync(status, { force: true });
  if (!result.startsWith('OK') || !existsSync(exported)) throw new Error(`After Effects export failed: ${result}`);
  rmSync(out, { recursive: true, force: true });
  renameSync(exported, out);
  rmSync(staging, { recursive: true, force: true });
}

function patchSliderRanges(file) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'smoothy-mogrt-'));
  try {
    execFileSync('unzip', ['-q', file, '-d', work]);
    const definitionPath = path.join(work, 'definition.json');
    const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
    const patched = new Set();
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      const range = SLIDER_RANGES[node.capPropUIName];
      if (range && node.capPropType === 1) {
        [node.capPropMin, node.capPropMax] = range;
        patched.add(node.capPropUIName);
      }
      Object.values(node).forEach(visit);
    };
    visit(definition);
    const missing = Object.keys(SLIDER_RANGES).filter(name => !patched.has(name));
    if (missing.length) throw new Error(`Template is missing sliders: ${missing.join(', ')}`);
    writeFileSync(definitionPath, JSON.stringify(definition));
    const rebuilt = path.join(work, 'out.mogrt');
    const entries = ['definition.json', 'project.aegraphic', 'thumb.png', 'thumb.mp4'].filter(name => existsSync(path.join(work, name)));
    execFileSync('zip', ['-q', '-X', rebuilt, ...entries], { cwd: work });
    copyFileSync(rebuilt, file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  if (!process.argv.includes('--patch-only')) exportFromAfterEffects();
  if (!existsSync(out)) throw new Error(`${out} not found`);
  patchSliderRanges(out);
  console.log(`Built ${path.relative(repoRoot, out)} (${statSync(out).size} bytes)`);
} catch (error) {
  console.error(`MOGRT build failed: ${error.message}`);
  process.exit(1);
}
