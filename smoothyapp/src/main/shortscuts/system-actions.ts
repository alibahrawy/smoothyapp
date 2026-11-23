import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { ShortsCutHistoryAction, ShortsCutsApplyResult } from './types';

function runProcess(command: string, args: string[], timeout = 6000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '').trim();
        reject(new Error(message || `${command} failed`));
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

function appDisplayName(target: string): string {
  const base = path.basename(target.replace(/[\\/]+$/, ''));
  return base.replace(/\.(app|exe|lnk|bat|cmd|appref-ms)$/i, '') || target;
}

function isAccessibilityError(message: string): boolean {
  return /assistive|not allowed to send keystrokes|-1719|-25211|accessibility/i.test(message);
}

/**
 * Launches or focuses a user-configured application on macOS, Windows or Linux.
 * Uses execFile / Electron shell.openPath with no shell interpolation.
 */
export async function openConfiguredApp(target: string): Promise<ShortsCutsApplyResult> {
  const clean = String(target || '').trim();
  if (!clean) return { success: false, error: 'Choose an app for this shortcut first.' };
  const name = appDisplayName(clean);

  if (process.platform === 'darwin') {
    if ((path.isAbsolute(clean) || clean.endsWith('.app')) && !fs.existsSync(clean)) {
      return { success: false, error: `Could not find “${name}”. Choose the app again.` };
    }
    try {
      await runProcess('open', ['-a', clean], 8000);
      return { success: true, message: `Opened ${name}.` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not open that app.';
      return { success: false, error: `Could not open ${name}: ${detail}` };
    }
  }

  if (process.platform === 'win32') {
    if (!fs.existsSync(clean)) {
      return { success: false, error: `Could not find “${name}”. Choose the app again.` };
    }
    try {
      const err = await shell.openPath(clean);
      if (err) return { success: false, error: `Could not open ${name}: ${err}` };
      return { success: true, message: `Opened ${name}.` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : `Could not open ${name}.` };
    }
  }

  if (!fs.existsSync(clean)) {
    return { success: false, error: `Could not find “${name}”. Choose the app again.` };
  }
  const err = await shell.openPath(clean);
  if (err) return { success: false, error: `Could not open ${name}: ${err}` };
  return { success: true, message: `Opened ${name}.` };
}

/**
 * Opens a user-configured directory in Finder / File Explorer / file manager.
 * Refuses non-directory targets so an open-folder key can never execute a file.
 */
export async function openConfiguredFolder(target: string): Promise<ShortsCutsApplyResult> {
  const clean = String(target || '').trim();
  if (!clean) return { success: false, error: 'Choose a folder for this shortcut first.' };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(clean);
  } catch {
    return { success: false, error: 'That folder no longer exists. Choose another folder.' };
  }
  if (!stat.isDirectory()) {
    return { success: false, error: 'That shortcut target is not a folder.' };
  }
  const err = await shell.openPath(clean);
  if (err) return { success: false, error: `Could not open folder: ${err}` };
  const folderName = path.basename(clean.replace(/[\\/]+$/, '')) || clean;
  return { success: true, message: `Opened ${folderName}.` };
}

/**
 * Triggers native Undo or Redo in Adobe Premiere Pro.
 * Premiere Pro's ExtendScript DOM exposes no reliable undo/redo command, so we
 * invoke Premiere's Edit menu (macOS) or layout-independent Ctrl(+Shift)+Z
 * (Windows / macOS fallback).
 */
export async function sendPremiereHistory(action: ShortsCutHistoryAction): Promise<ShortsCutsApplyResult> {
  const label = action === 'undo' ? 'Undo' : 'Redo';

  if (process.platform === 'darwin') {
    const isRedo = action === 'redo';
    const prefix = isRedo ? 'Redo' : 'Undo';
    const cantPrefix = isRedo ? "Can't Redo" : "Can't Undo";
    const keyLine = isRedo
      ? 'key code 6 using {command down, shift down}'
      : 'key code 6 using {command down}';
    const script = [
      'tell application "System Events"',
      '  set pproList to every application process whose name contains "Premiere Pro"',
      '  if (count of pproList) is 0 then error "PREMIERE_NOT_RUNNING"',
      '  set ppro to item 1 of pproList',
      '  set frontmost of ppro to true',
      '  delay 0.04',
      '  try',
      '    set editItems to every menu item of menu 1 of menu bar item "Edit" of menu bar 1 of ppro',
      '    repeat with mi in editItems',
      '      set n to name of mi',
      `      if n starts with "${cantPrefix}" then return "NOTHING"`,
      `      if n starts with "${prefix}" then`,
      '        if enabled of mi is false then return "NOTHING"',
      '        click mi',
      '        return "OK"',
      '      end if',
      '    end repeat',
      '  end try',
      `  ${keyLine}`,
      '  return "OK"',
      'end tell',
    ].join('\n');
    try {
      const { stdout } = await runProcess('osascript', ['-e', script], 5000);
      if (stdout.trim() === 'NOTHING') {
        return { success: false, error: `Nothing to ${action} in Premiere.` };
      }
      return { success: true, message: `${label} in Premiere.` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      if (/PREMIERE_NOT_RUNNING/.test(detail)) {
        return { success: false, error: 'Premiere Pro is not running.' };
      }
      if (isAccessibilityError(detail)) {
        return {
          success: false,
          error: 'Allow SmoothyEdit in macOS System Settings → Privacy & Security → Accessibility to use Undo and Redo.',
        };
      }
      return { success: false, error: detail || `Could not ${action} in Premiere.` };
    }
  }

  if (process.platform === 'win32') {
    const isRedo = action === 'redo';
    const script = [
      'Add-Type -Name Keys -Namespace Smoothy -MemberDefinition \'',
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
      '\';',
      '$p = Get-Process | Where-Object { $_.ProcessName -like "*Premiere*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1;',
      'if (-not $p) { Write-Error "PREMIERE_NOT_RUNNING"; exit 1 }',
      '[void][Smoothy.Keys]::SetForegroundWindow($p.MainWindowHandle);',
      'Start-Sleep -Milliseconds 50;',
      '[Smoothy.Keys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);',
      isRedo ? '[Smoothy.Keys]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero);' : '',
      '[Smoothy.Keys]::keybd_event(0x5A, 0, 0, [UIntPtr]::Zero);',
      'Start-Sleep -Milliseconds 25;',
      '[Smoothy.Keys]::keybd_event(0x5A, 0, 2, [UIntPtr]::Zero);',
      isRedo ? '[Smoothy.Keys]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero);' : '',
      '[Smoothy.Keys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);',
    ].filter(Boolean).join(' ');
    try {
      await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 6000);
      return { success: true, message: `${label} in Premiere.` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      if (/PREMIERE_NOT_RUNNING/.test(detail)) {
        return { success: false, error: 'Premiere Pro is not running.' };
      }
      return { success: false, error: detail || `Could not ${action} in Premiere.` };
    }
  }

  return { success: false, error: 'Undo and Redo require macOS or Windows.' };
}

/**
 * Creates a sequence-matched Adjustment Layer in Premiere Pro via File → New →
 * Adjustment Layer... when the active project has no Adjustment Layer item yet.
 * Subsequent presses reuse the project item directly in ExtendScript.
 */
export async function createPremiereAdjustmentLayerViaMenu(): Promise<ShortsCutsApplyResult> {
  if (process.platform === 'darwin') {
    const script = [
      'tell application "System Events"',
      '  set pproList to every application process whose name contains "Premiere Pro"',
      '  if (count of pproList) is 0 then error "PREMIERE_NOT_RUNNING"',
      '  set ppro to item 1 of pproList',
      '  set frontmost of ppro to true',
      '  delay 0.08',
      '  set newMenu to menu 1 of menu item "New" of menu 1 of menu bar item "File" of menu bar 1 of ppro',
      '  set clicked to false',
      '  repeat with mi in (every menu item of newMenu)',
      '    if (name of mi) starts with "Adjustment Layer" then',
      '      if enabled of mi is false then return "DISABLED"',
      '      click mi',
      '      set clicked to true',
      '      exit repeat',
      '    end if',
      '  end repeat',
      '  if not clicked then return "NOT_FOUND"',
      '  delay 0.35',
      '  key code 36',
      '  delay 0.35',
      '  return "OK"',
      'end tell',
    ].join('\n');
    try {
      const { stdout } = await runProcess('osascript', ['-e', script], 6000);
      const status = stdout.trim();
      if (status === 'OK') return { success: true };
      return {
        success: false,
        error: 'Create an Adjustment Layer once in Premiere (File → New → Adjustment Layer) with the Project panel open, then try again.',
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      if (isAccessibilityError(detail)) {
        return {
          success: false,
          error: 'No Adjustment Layer in this project yet. Create one once via File → New → Adjustment Layer (or allow Accessibility in macOS Settings), then try again.',
        };
      }
      return {
        success: false,
        error: 'No Adjustment Layer in this project yet. Create one once via File → New → Adjustment Layer in Premiere, then try again.',
      };
    }
  }

  return {
    success: false,
    error: 'No Adjustment Layer in this project yet. Create one once via File → New → Adjustment Layer in Premiere, then try again.',
  };
}
