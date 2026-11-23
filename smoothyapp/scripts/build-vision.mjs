// Builds the macOS Vision helper (resources/vision/smoothy-vision) used by the
// Agent Bridge for eye-line and hands-on-face scans. macOS only; needs swiftc
// (Xcode or the Command Line Tools). Other platforms skip it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native/vision/main.swift');
const outDir = path.join(root, 'resources/vision');
const output = path.join(outDir, 'smoothy-vision');

if (process.platform !== 'darwin') {
  console.log('[vision] Skipped: the Vision helper is macOS only.');
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
const fresh = fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
if (fresh && !process.argv.includes('--force')) {
  console.log('[vision] Up to date:', path.relative(root, output));
  process.exit(0);
}
execFileSync('swiftc', ['-O', '-target', 'arm64-apple-macos12', '-o', output, source], { stdio: 'inherit' });
console.log('[vision] Built', path.relative(root, output));
