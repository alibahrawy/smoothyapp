/**
 * Picture geometry shared by the preview renderer and the Premiere XML export,
 * so the headless preview shows what Premiere will show.
 *
 * The visible region (an asset's crop, or the whole frame) is fitted to the
 * canvas (cover or contain), then zoomed by `zoom` around `anchor` (a point in
 * the region, normalized), which stays where it was: an eye-anchored punch-in.
 *
 * Premiere/FCP7 Basic Motion: scale is a percentage of the source's own pixels;
 * center is the offset of the source frame's center from the sequence center in
 * half-frame units (vert 0.1 = 108 px in a 2160-high sequence, y down). For a
 * full-frame source that fills the frame this gives the calibrated formula
 *   horiz = 2(z−1)(0.5−ex), vert = 2(z−1)(0.5−ey).
 */

import type { EditAsset, EditClip, Region } from './edit-project';

export type Placement = {
  /** Visible region in source pixels. */
  region: Region;
  /** Full source frame size. */
  iw: number;
  ih: number;
  /** Source pixels → canvas pixels (fit × zoom). */
  scale: number;
  /** Offset of the full source frame's center from the canvas center, in canvas pixels. */
  dx: number;
  dy: number;
};

export function placement(asset: Pick<EditAsset, 'width' | 'height' | 'crop'>, clip: Pick<EditClip, 'zoom' | 'anchor' | 'fit'>, outW: number, outH: number): Placement {
  const iw = asset.width;
  const ih = asset.height;
  const region = asset.crop || { x: 0, y: 0, w: iw, h: ih };
  const fit = clip.fit === 'contain' ? Math.min(outW / region.w, outH / region.h) : Math.max(outW / region.w, outH / region.h);
  const z = clip.zoom && clip.zoom > 0 ? clip.zoom : 1;
  const ax = region.x + (clip.anchor?.x ?? 0.5) * region.w;
  const ay = region.y + (clip.anchor?.y ?? 0.5) * region.h;
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  // Region centered at z = 1, then the anchor held in place while zooming.
  const dx = -(cx - iw / 2) * fit + (ax - iw / 2) * fit * (1 - z);
  const dy = -(cy - ih / 2) * fit + (ay - ih / 2) * fit * (1 - z);
  return { region, iw, ih, scale: fit * z, dx, dy };
}

/** FCP7 Basic Motion values and Crop percentages for a placement. */
export function motionValues(asset: Pick<EditAsset, 'width' | 'height' | 'crop'>, p: Placement, outW: number, outH: number): { scale: number; horiz: number; vert: number; crop: { left: number; right: number; top: number; bottom: number } | null } {
  const crop = asset.crop
    ? {
      left: (asset.crop.x / asset.width) * 100,
      right: ((asset.width - asset.crop.x - asset.crop.w) / asset.width) * 100,
      top: (asset.crop.y / asset.height) * 100,
      bottom: ((asset.height - asset.crop.y - asset.crop.h) / asset.height) * 100
    }
    : null;
  return { scale: p.scale * 100, horiz: p.dx / (outW / 2), vert: p.dy / (outH / 2), crop };
}

const floorEven = (value: number) => Math.max(2, 2 * Math.floor(value / 2));

/**
 * ffmpeg filters that draw a clip at its placement: crop the region, scale it,
 * keep only the part that lands on the canvas, and where to overlay that part.
 * Uncovered canvas stays transparent (black on V1), as in Premiere.
 */
export function placementFilters(p: Placement, outW: number, outH: number): { filters: string[]; x: number; y: number; covers: boolean; visible: boolean } {
  const { region, scale } = p;
  const sw = Math.max(2, Math.round(region.w * scale));
  const sh = Math.max(2, Math.round(region.h * scale));
  const x0 = Math.round(outW / 2 + p.dx - (p.iw * scale) / 2 + region.x * scale);
  const y0 = Math.round(outH / 2 + p.dy - (p.ih * scale) / 2 + region.y * scale);
  const cx = Math.max(0, -x0);
  const cy = Math.max(0, -y0);
  const cw = Math.min(sw, outW - x0) - cx;
  const ch = Math.min(sh, outH - y0) - cy;
  const filters = [];
  if (region.x || region.y || region.w !== p.iw || region.h !== p.ih) filters.push(`crop=${region.w}:${region.h}:${region.x}:${region.y}`);
  filters.push(`scale=${sw}:${sh}`);
  if (cw < 2 || ch < 2) return { filters: [...filters, 'crop=2:2:0:0'], x: outW, y: outH, covers: false, visible: false };
  const w = Math.min(floorEven(cw), sw - cx);
  const h = Math.min(floorEven(ch), sh - cy);
  if (cx || cy || w !== sw || h !== sh) filters.push(`crop=${w}:${h}:${cx}:${cy}`);
  const covers = x0 <= 0 && y0 <= 0 && x0 + sw >= outW && y0 + sh >= outH;
  return { filters, x: Math.max(0, x0), y: Math.max(0, y0), covers, visible: true };
}
