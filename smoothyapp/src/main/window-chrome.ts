import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

// Match --titlebar-height in the renderer. Native Windows controls retain their
// accessibility, maximize/restore and system window behavior inside this row.
export const TITLEBAR_HEIGHT = 38;
export function windowChromeOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 12 } };
  if (platform === 'win32') return {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F1F6FE', symbolColor: '#151515', height: TITLEBAR_HEIGHT },
    autoHideMenuBar: true,
  };
  return {};
}

export function setWindowTitlebarColor(window: BrowserWindow | null, color: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32' || !window || window.isDestroyed() || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
  window.setTitleBarOverlay({ color, symbolColor: captionSymbolColor(color), height: TITLEBAR_HEIGHT });
  return true;
}

/** Dark caption glyphs on a light strip, light glyphs on a dark one (dark mode). */
export function captionSymbolColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? '#151515' : '#F4F3EF';
}
