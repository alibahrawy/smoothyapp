/**
 * Headless edit → Premiere (FCP7 xmeml v4), with the details learned on real edits:
 * - the sequence runs at the project frame rate (build it at the source rate);
 * - Basic Motion scale is a percentage of the source's own pixels and center is
 *   in half-frame units (see transform.ts), so punch-ins pivot on the eye line;
 * - regions become a Crop filter on the original file (source timecode kept);
 * - clips reference sources by frame offsets, so the editor can extend them;
 * - upper video and audio tracks can be packed onto as few tracks as possible;
 * - chapters become sequence markers.
 * A sidecar JSON records exactly what was exported, for the live diff later.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clipEnd, type EditAsset, type EditClip, type EditProject } from './edit-project';
import { motionValues, placement } from './transform';

export type ExportedClip = {
  name: string;
  track: string;
  kind: EditClip['kind'];
  path: string;
  start: number;
  end: number;
  srcIn: number;
  srcOut: number;
  clipId: string;
  asset: string;
  meta?: Record<string, unknown>;
};

export type Sidecar = {
  kind: 'smoothy-xml-export';
  version: 1;
  sequenceName: string;
  fps: number;
  width: number;
  height: number;
  projectId: string;
  revision: number;
  exportedAt: string;
  xml: string;
  clips: ExportedClip[];
};

const esc = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Premiere rate block: integer timebase plus the NTSC flag for 23.976 / 29.97 / 59.94. */
export function rateXml(fps: number): string {
  const timebase = Math.round(fps);
  const ntsc = Math.abs(fps - timebase) > 0.005;
  return `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

/** file://localhost/… with each path segment percent-encoded (as Premiere writes it). */
export function pathUrl(file: string): string {
  const href = pathToFileURL(file).href; // file:///Users/…
  return href.replace(/^file:\/\//, 'file://localhost');
}

const n6 = (value: number) => (Math.abs(value) < 5e-7 ? 0 : value).toFixed(6);

function motionFilter(scale: number, horiz: number, vert: number): string {
  return '<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>'
    + `<parameter authoringApp="PremierePro"><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale.toFixed(3)}</value></parameter>`
    + `<parameter authoringApp="PremierePro"><parameterid>center</parameterid><name>Center</name><value><horiz>${n6(horiz)}</horiz><vert>${n6(vert)}</vert></value></parameter></effect></filter>`;
}

function cropFilter(crop: { left: number; right: number; top: number; bottom: number }): string {
  const parameter = (id: string, value: number) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${id}</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${value.toFixed(4)}</value></parameter>`;
  return '<filter><effect><name>Crop</name><effectid>crop</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>'
    + parameter('left', crop.left) + parameter('right', crop.right) + parameter('top', crop.top) + parameter('bottom', crop.bottom) + '</effect></filter>';
}

function opacityFilter(opacity: number): string {
  return '<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>'
    + `<parameter authoringApp="PremierePro"><parameterid>opacity</parameterid><name>opacity</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${(opacity * 100).toFixed(2)}</value></parameter></effect></filter>`;
}

function levelFilter(db: number): string {
  const gain = Math.pow(10, db / 20);
  return '<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>'
    + `<parameter authoringApp="PremierePro"><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${gain.toFixed(6)}</value></parameter></effect></filter>`;
}

/** Packs clips onto as few lanes as possible, keeping time order. */
function pack<T extends { start: number; end: number }>(items: T[]): T[][] {
  const lanes: T[][] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const lane = lanes.find(list => list[list.length - 1].end <= item.start + 1e-6);
    if (lane) lane.push(item); else lanes.push([item]);
  }
  return lanes;
}

export type XmlOptions = {
  sequenceName: string;
  markers?: { title: string; at: number; comment?: string }[];
  /** Pack V2+ and A2+ onto as few tracks as possible. Default true. */
  pack?: boolean;
  xmlPath: string;
};

export function projectToXmeml(project: EditProject, options: XmlOptions): { xml: string; sidecar: Sidecar; warnings: string[]; counts: Record<string, number> } {
  const fps = project.fps;
  const rate = rateXml(fps);
  const W = project.width;
  const H = project.height;
  const frame = (seconds: number) => Math.round(seconds * fps);
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message) && warnings.length < 20) warnings.push(message); };

  const visual = project.clips.filter(clip => clip.kind === 'video' || clip.kind === 'image');
  const sound = project.clips.filter(clip => clip.kind === 'audio');
  if (project.clips.some(clip => clip.kind === 'text')) warn('Text clips are not exported (titles and captions belong in graphics or an SRT).');
  for (const clip of project.clips) {
    if (clip.speed !== 1) warn(`${clip.id} plays at ${clip.speed}x; the XML keeps its length but not the speed change. Set the speed in Premiere.`);
    if (clip.fadeIn || clip.fadeOut) warn('Fades are not exported; add transitions in Premiere.');
    const asset = clip.asset ? project.assets[clip.asset] : null;
    if (asset && asset.kind === 'video' && asset.fps && Math.abs(asset.fps - fps) > 0.01) warn(`${asset.name} is ${Number(asset.fps.toFixed(3))} fps but the sequence is ${fps} fps. Build at the source frame rate.`);
  }

  // Tracks: keep V1/A1 as built; pack the rest when asked.
  const byTrack = (clips: EditClip[], prefix: 'V' | 'A') => {
    const names = [...new Set(clips.map(clip => clip.track))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const first = names.includes(`${prefix}1`) ? clips.filter(clip => clip.track === `${prefix}1`) : [];
    const rest = clips.filter(clip => clip.track !== `${prefix}1`);
    if (options.pack !== false) {
      const lanes = pack(rest.map(clip => ({ clip, start: clip.start, end: clipEnd(clip) }))).map(lane => lane.map(item => item.clip));
      return [first, ...lanes].filter((lane, i) => i === 0 || lane.length);
    }
    return [first, ...names.filter(name => name !== `${prefix}1`).map(name => clips.filter(clip => clip.track === name))];
  };
  const videoTracks = byTrack(visual, 'V');
  const audioTracks = byTrack(sound, 'A');

  // Names and ids first, so linked clips can point at each other.
  const files = new Map<string, string>();
  const fileIds = new Map<string, string>();
  let counter = 0;
  const items = new Map<string, { id: string; track: number; index: number; media: 'video' | 'audio' }>();
  const nameOf = (clip: EditClip, asset: EditAsset | null) => clip.name || `${asset ? path.parse(asset.name).name : clip.kind} ${clip.id}`;
  videoTracks.forEach((lane, t) => [...lane].sort((a, b) => a.start - b.start).forEach((clip, i) => items.set(clip.id, { id: `clipitem-${++counter}`, track: t + 1, index: i + 1, media: 'video' })));
  audioTracks.forEach((lane, t) => [...lane].sort((a, b) => a.start - b.start).forEach((clip, i) => items.set(clip.id, { id: `clipitem-${++counter}`, track: t + 1, index: i + 1, media: 'audio' })));

  const fileXml = (asset: EditAsset) => {
    const key = asset.path;
    const id = fileIds.get(key) || `file-${fileIds.size + 1}`;
    fileIds.set(key, id);
    if (files.has(key)) return `<file id="${id}"/>`;
    const fileFps = asset.fps && asset.fps > 0 ? asset.fps : fps;
    const duration = asset.kind === 'image' ? 86400 : Math.max(1, Math.round(asset.duration * fps));
    const fullW = asset.width;
    const fullH = asset.height;
    let media = '';
    if (asset.kind !== 'audio') media += `<video><samplecharacteristics>${rateXml(fileFps)}<width>${fullW}</width><height>${fullH}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`;
    if (asset.hasAudio) media += '<audio><samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>';
    const xml = `<file id="${id}"><name>${esc(path.basename(asset.path))}</name><pathurl>${esc(pathUrl(asset.path))}</pathurl>${rate}<duration>${duration}</duration><media>${media}</media></file>`;
    files.set(key, xml);
    return xml;
  };

  const exported: ExportedClip[] = [];
  const clipXml = (clip: EditClip, trackName: string) => {
    const asset = clip.asset ? project.assets[clip.asset] : null;
    if (!asset) return '';
    const start = frame(clip.start);
    const end = frame(clipEnd(clip));
    const inF = asset.kind === 'image' ? 0 : frame(clip.in);
    const outF = inF + (end - start);
    const name = nameOf(clip, asset);
    let filters = '';
    if (clip.kind !== 'audio') {
      // Premiere scales from the full file; a region adds a Crop filter.
      const motion = motionValues(asset, placement(asset, clip, W, H), W, H);
      if (motion.crop) filters += cropFilter(motion.crop);
      filters += motionFilter(motion.scale, motion.horiz, motion.vert);
      if (clip.opacity < 1) filters += opacityFilter(clip.opacity);
    } else if (clip.volume) {
      filters += levelFilter(clip.volume);
    }
    const me = items.get(clip.id)!;
    const group = clip.link ? project.clips.filter(other => other.link === clip.link && items.has(other.id)) : [];
    const links = group.length > 1
      ? group.map(other => { const it = items.get(other.id)!; return `<link><linkclipref>${it.id}</linkclipref><mediatype>${it.media}</mediatype><trackindex>${it.track}</trackindex><clipindex>${it.index}</clipindex></link>`; }).join('')
      : '';
    exported.push({ name, track: trackName, kind: clip.kind, path: asset.path, start: clip.start, end: clipEnd(clip), srcIn: clip.in, srcOut: clip.out, clipId: clip.id, asset: asset.id, ...(clip.meta ? { meta: clip.meta } : {}) });
    return `<clipitem id="${me.id}"><name>${esc(name)}</name><enabled>${clip.mute ? 'FALSE' : 'TRUE'}</enabled><duration>${Math.max(1, Math.round(asset.duration * fps))}</duration>${rate}<start>${start}</start><end>${end}</end><in>${inF}</in><out>${outF}</out>${fileXml(asset)}${filters}${links}</clipitem>`;
  };
  const trackXml = (lane: EditClip[], name: string) => `<track>${[...lane].sort((a, b) => a.start - b.start).map(clip => clipXml(clip, name)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  const video = videoTracks.map((lane, i) => trackXml(lane, `V${i + 1}`)).join('');
  const audio = audioTracks.map((lane, i) => trackXml(lane, `A${i + 1}`)).join('');
  const total = Math.max(1, ...project.clips.map(clip => frame(clipEnd(clip))));
  const markers = (options.markers || []).map(marker => `<marker><name>${esc(marker.title)}</name><comment>${esc(marker.comment ?? 'Chapter')}</comment><in>${frame(marker.at)}</in><out>-1</out></marker>`).join('');
  const format = `<format><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth></samplecharacteristics></format>`;
  const timebase = Math.round(fps);
  // Drop-frame timecode is only defined for 29.97 and 59.94 fps; 23.976 is always NDF.
  const isDropFrame = (timebase === 30 || timebase === 60) && Math.abs(fps - timebase) > 0.005;
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">'
    + `<sequence id="sequence-1"><name>${esc(options.sequenceName)}</name><duration>${total}</duration>${rate}`
    + `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>${isDropFrame ? 'DF' : 'NDF'}</displayformat></timecode>`
    + `<media><video>${format}${video}</video><audio><numOutputChannels>2</numOutputChannels>${audio}</audio></media>${markers}</sequence></xmeml>\n`;
  const sidecar: Sidecar = {
    kind: 'smoothy-xml-export', version: 1, sequenceName: options.sequenceName, fps, width: W, height: H,
    projectId: project.id, revision: project.revision, exportedAt: new Date().toISOString(), xml: options.xmlPath, clips: exported
  };
  return { xml, sidecar, warnings, counts: { videoTracks: videoTracks.length, audioTracks: audioTracks.length, clips: exported.length, files: files.size, markers: options.markers?.length || 0, frames: total } };
}
