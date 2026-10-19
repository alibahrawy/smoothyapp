import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

// Match --titlebar-height in the renderer. Native Windows controls retain their
// accessibility, maximize/restore and system window behavior inside this row.
export const TITLEBAR_HEIGHT = 38;
export function windowChromeOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 12 } };
  if (platform === 'win32') return {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#9FEAE2', symbolColor: '#253238', height: TITLEBAR_HEIGHT },
    autoHideMenuBar: true,
  };
  return {};
}

export function setWindowTitlebarColor(window: BrowserWindow | null, color: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32' || !window || window.isDestroyed() || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
  window.setTitleBarOverlay({ color, symbolColor: '#253238', height: TITLEBAR_HEIGHT });
  return true;
}
