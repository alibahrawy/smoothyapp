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
 * determined. Supports macOS (lsappinfo) and Windows (GetForegroundWindow);
 * callers must treat null as "unknown" and fail open.
 */
export async function getFrontmostAppName(): Promise<string | null> {
  if (process.platform === 'darwin') {
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
  if (process.platform === 'win32') {
    try {
      const script = [
        'Add-Type -Name Win -Namespace Smoothy -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\';',
        '$h = [Smoothy.Win]::GetForegroundWindow();',
        '$p = 0; [void][Smoothy.Win]::GetWindowThreadProcessId($h, [ref]$p);',
        'if ($p -gt 0) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName }'
      ].join(' ');
      const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
      return out || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when ShortsCuts keys should be active for this frontmost app name. */
export function shortcutsAllowedFor(name: string | null): boolean {
  if (!name) return true;
  return /premiere/i.test(name) || /smoothy/i.test(name) || /^electron$/i.test(name);
}
