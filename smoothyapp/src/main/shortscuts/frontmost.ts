import { execFile } from 'child_process';

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 1500, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Name of the app that currently has keyboard focus, or null when it cannot be
 * determined. Only macOS is supported today (lsappinfo needs no permissions);
 * callers must treat null as "unknown" and fail open.
 */
export async function getFrontmostAppName(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const front = (await run('lsappinfo', ['front'])).trim();
    if (!front.startsWith('ASN:')) return null;
    const info = await run('lsappinfo', ['info', '-only', 'name', front]);
    const display = info.match(/"LSDisplayName"\s*=\s*"([^"]*)"/);
    if (display) return display[1];
    const first = info.match(/"([^"]+)"/);
    return first ? first[1] : null;
  } catch {
    return null;
  }
}

/** True when ShortsCuts keys should be active for this frontmost app name. */
export function shortcutsAllowedFor(name: string | null): boolean {
  if (!name) return true;
  return /premiere/i.test(name) || /smoothy/i.test(name) || name === 'Electron';
}
