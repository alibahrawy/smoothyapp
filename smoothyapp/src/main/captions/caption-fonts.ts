/**
 * Fonts for the Smoothy Pro caption templates. A .mogrt does not embed fonts,
 * so before a send the app copies the template's font from the bundled CEP
 * panel (smoothyapp-cep/fonts, SIL Open Font License) into the user's own
 * font folder. Nothing is overwritten: a font already installed is kept.
 *
 * Premiere reads its font list at launch, so a font installed while Premiere
 * is open shows after Premiere restarts; the send reports that case.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProCaptionTemplate } from './pro-captions';

interface CaptionFont { file: string; family: string }

const JAKARTA: CaptionFont = { file: 'PlusJakartaSans-ExtraBold.ttf', family: 'Plus Jakarta Sans ExtraBold' };
const INTER_BOLD: CaptionFont = { file: 'InterDisplay-Bold.ttf', family: 'Inter Display Bold' };
const INTER_EXTRABOLD: CaptionFont = { file: 'InterDisplay-ExtraBold.ttf', family: 'Inter Display ExtraBold' };

export const CAPTION_TEMPLATE_FONTS: Record<ProCaptionTemplate, CaptionFont[]> = {
  'box-highlight': [JAKARTA],
  'word-rise': [INTER_BOLD],
  'word-slide': [INTER_BOLD],
  'stroke-highlight': [INTER_EXTRABOLD],
};

/** The per-user font folder Premiere reads, or null where Premiere does not run. */
export function userFontFolder(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  if (platform === 'darwin') return path.join(home, 'Library', 'Fonts');
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null;
  return null;
}

export interface CaptionFontResult {
  /** Families copied now; Premiere needs a restart to list them. */
  installed: string[];
  /** Families that could not be installed (Premiere will substitute a font). */
  failed: string[];
}

/**
 * Installs the template's fonts if they are missing. Never throws: a missing
 * font only changes how the caption looks, so it must not block the send.
 */
export function ensureCaptionFonts(template: ProCaptionTemplate, bundledFontFolder: string, options: { platform?: NodeJS.Platform; fontFolder?: string | null } = {}): CaptionFontResult {
  const result: CaptionFontResult = { installed: [], failed: [] };
  const platform = options.platform ?? process.platform;
  const target = options.fontFolder !== undefined ? options.fontFolder : userFontFolder(platform);
  if (!target) return result;
  for (const font of CAPTION_TEMPLATE_FONTS[template] ?? []) {
    const destination = path.join(target, font.file);
    try {
      if (fs.existsSync(destination)) continue;
      if (platform === 'darwin' && options.fontFolder === undefined && fs.existsSync(path.join('/Library/Fonts', font.file))) continue;
      const source = path.join(bundledFontFolder, font.file);
      if (!fs.existsSync(source)) { result.failed.push(font.family); continue; }
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      if (platform === 'win32') {
        // Per-user fonts on Windows are listed in the registry as well as copied.
        execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', `${font.family} (TrueType)`, '/t', 'REG_SZ', '/d', destination, '/f'], { stdio: 'ignore', windowsHide: true });
      }
      result.installed.push(font.family);
    } catch {
      result.failed.push(font.family);
    }
  }
  return result;
}
