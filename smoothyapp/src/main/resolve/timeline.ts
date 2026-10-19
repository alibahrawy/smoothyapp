import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { CameraRange } from '../autocut/multicam-plan';

const children = (node: any, tag: string): any[] => Array.from(node?.childNodes || []).filter((n: any) => n.nodeType === 1 && n.nodeName === tag);
const child = (node: any, tag: string) => children(node, tag)[0];
const text = (node: any, tag: string, fallback = '') => child(node, tag)?.textContent?.trim() || fallback;
const number = (node: any, tag: string) => Number(text(node, tag, 'NaN'));
const descendants = (node: any, tag: string): any[] => Array.from(node.getElementsByTagName(tag));
const rate = (node: any, fallback = 0): number => {
  const value = child(node, 'rate');
  const base = number(value, 'timebase');
  return base > 0 ? base * (text(value, 'ntsc').toUpperCase() === 'TRUE' ? 1000 / 1001 : 1) : fallback;
};
function set(node: any, tag: string, value: unknown) {
  const element = child(node, tag) || node.appendChild(node.ownerDocument.createElement(tag));
  element.textContent = String(value);
}

export function serializeResolveXml(doc:any) {
  const formatted=doc.cloneNode(true),pending=[formatted.documentElement];
  while(pending.length){
    const node=pending.pop();const nodes=Array.from(node.childNodes || []) as any[];
    const elements=nodes.filter(n=>n.nodeType===1);for(const element of elements)pending.push(element);
    // Add structural whitespace only; never rewrite CDATA or mixed effect text.
    if(elements.length && nodes.every(n=>n.nodeType===1) ){
      for(const element of elements)node.insertBefore(formatted.createTextNode('\n'),element);
      node.appendChild(formatted.createTextNode('\n'));
    }
  }
  const xml=new XMLSerializer().serializeToString(formatted);
  return xml.startsWith('<?xml') ? xml : '<?xml version="1.0" encoding="UTF-8"?>\n'+xml;
}

/** Snapshot clips sharing an AV source must reference one complete media file.
 * FCP7 importers cannot reliably infer full source duration from a trimmed cut. */
export function normalizeSnapshotMedia(doc: any, original = doc) {
  if (!descendants(doc,'lognote').some(n=>n.textContent==='smoothy-source-snapshot-v1')) return;
  const definitions=new Map<string,any>();
  for(const f of descendants(original,'file'))if(text(f,'pathurl'))definitions.set(f.getAttribute('id'),f);
  const groups=new Map<string,{file:any;id:string;duration:number}>();
  for(const item of descendants(original,'clipitem')){
    const reference=child(item,'file'),f=definitions.get(reference?.getAttribute('id'));if(!f)continue;
    const url=text(f,'pathurl');let group=groups.get(url);
    if(!group){group={file:doc.importNode(f,true),id:f.getAttribute('id'),duration:0};groups.set(url,group);}
    group.duration=Math.max(group.duration,number(item,'out')||0,number(f,'duration')||0);
    const media=child(group.file,'media') || group.file.appendChild(doc.createElement('media'));
    for(const kind of ['video','audio'])if(!child(media,kind) && child(child(f,'media'),kind))media.appendChild(doc.importNode(child(child(f,'media'),kind),true));
  }
  const emitted=new Set<string>();
  for(const f of descendants(doc,'file')){
    const definition=text(f,'pathurl')?f:definitions.get(f.getAttribute('id'));
    const group=groups.get(text(definition,'pathurl'));if(!group)continue;
    let replacement;
    if(!emitted.has(group.id)){
      replacement=doc.importNode(group.file,true);set(replacement,'duration',group.duration);
      // FCP7's local-file convention; keep escaped spaces/Unicode and UNC hosts.
      set(replacement,'pathurl',text(replacement,'pathurl').replace(/^file:\/\/\//,'file://localhost/'));
      const video=child(child(replacement,'media'),'video');
      if(video){
        set(video,'duration',group.duration);const duration=child(video,'duration');if(duration!==video.firstChild)video.insertBefore(duration,video.firstChild);
        for(const nestedRate of children(child(video,'samplecharacteristics'),'rate'))nestedRate.parentNode.removeChild(nestedRate);
      }
      // Match Resolve's own FCP7 media definition order and inherit video rate
      // from file/rate. The native conformer is stricter than our XML reader.
      for(const tag of ['duration','rate','name','pathurl','timecode','media'])for(const node of children(replacement,tag))replacement.appendChild(node);
      emitted.add(group.id);
    } else replacement=doc.createElement('file');
    const item=f.parentNode;replacement.setAttribute('id',group.id);item.replaceChild(replacement,f);
    // Resolve exports clipitem duration in full source frames, separately from
    // the edit's start/end and in/out. Audio conform depends on these fields.
    if(item.nodeName==='clipitem')set(item,'duration',group.duration);
  }
}

export interface ResolveClip {
  name: string; path: string; start: number; end: number; inPoint: number; outPoint: number;
  disabled: boolean; mediaFps: number; channel: number; element: any; sourceIn: number; sourceOut: number;
}
export interface ResolveTrack { index: number; name: string; clips: ResolveClip[]; enabled: boolean; issues: string[]; element: any }
export interface ResolveTimeline {
  doc: any; sequence: any; xml: string; id: string; nativeId?:string; name: string; fps: number; duration: number; frames: number;
  videoTracks: ResolveTrack[]; audioTracks: ResolveTrack[]; width: number; height: number; warnings: string[];
}

/** Resolve Free's supported file handoff. No scripting or proprietary project parsing. */
export function parseResolveTimeline(xml: string): ResolveTimeline {
  if (Buffer.byteLength(xml) > 25 * 1024 * 1024) throw new Error('This timeline XML exceeds the 25 MB development limit.');
  if (/<!ENTITY|<!DOCTYPE[^>]*(?:SYSTEM|PUBLIC|\[)/i.test(xml)) throw new Error('External XML entities and custom DTDs are not supported.');
  const problems: string[] = [];
  const doc = new DOMParser({ onError: (_level: string, message: string) => { problems.push(message); } }).parseFromString(xml, 'text/xml');
  if (problems.length || !doc || doc.documentElement?.nodeName !== 'xmeml') throw new Error('Export Final Cut Pro 7 XML (.xml) from Resolve. FCPXML, DRT and project files are not supported by this preview.');
  const sequences = descendants(doc, 'sequence').filter(node => child(node, 'media'));
  // A Resolve export contains one top-level sequence; nested sequences remain unsupported cameras.
  const candidates = sequences.filter(node => !['clipitem', 'sequence'].some(tag => {
    for (let p = node.parentNode; p; p = p.parentNode) if (p.nodeName === tag) return true;
    return false;
  }));
  if (candidates.length !== 1) throw new Error('Export one timeline at a time as Final Cut Pro 7 XML.');
  const sequence = candidates[0];
  const fps = rate(sequence);
  const frames = number(sequence, 'duration');
  if (!(fps > 0 && fps <= 120 && Number.isSafeInteger(frames) && frames > 0)) throw new Error('The exported timeline has invalid frame rate or duration.');
  const files = new Map<string, any>();
  for (const file of descendants(doc, 'file')) if (text(file, 'pathurl')) files.set(file.getAttribute('id'), file);
  const parseTracks = (kind: string): ResolveTrack[] => children(child(child(sequence, 'media'), kind), 'track').map((element, index) => {
    const issues: string[] = [];
    if (children(element, 'transitionitem').length) issues.push('Transitions must be removed from selected camera/microphone tracks before export.');
    const enabled = text(element, 'enabled', 'TRUE').toUpperCase() !== 'FALSE';
    const clips = children(element, 'clipitem').map(item => {
      const inlineFile = child(item, 'file');
      const file = text(inlineFile, 'pathurl') ? inlineFile : files.get(inlineFile?.getAttribute('id'));
      const name = text(item, 'name', 'Untitled clip');
      let path = '';
      try { const url = new URL(text(file, 'pathurl')); if (url.protocol === 'file:') path = fileURLToPath(url); } catch {}
      const mediaFps = rate(item, rate(file, fps));
      const start = number(item, 'start'), end = number(item, 'end'), sourceIn = number(item, 'in'), sourceOut = number(item, 'out');
      const disabled = !enabled || text(item, 'enabled', 'TRUE').toUpperCase() === 'FALSE';
      const filters = descendants(item, 'filter');
      if (!disabled) {
        if (!path || child(item, 'sequence')) issues.push(`${name}: nested, multicam or missing-media clip. Decompose it to source clips before exporting.`);
        if (![start, end, sourceIn, sourceOut].every(Number.isSafeInteger) || start < 0 || end <= start || sourceIn < 0 || sourceOut <= sourceIn || end > frames) issues.push(`${name}: unsupported source/timeline timing.`);
        if (Math.abs((sourceOut - sourceIn) / mediaFps - (end - start) / fps) > 1.1 / fps) issues.push(`${name}: retimed or mixed-rate clip. Use matching-rate, normal-speed source clips for this preview.`);
        if (Math.abs(mediaFps - fps) > 0.01) issues.push(`${name}: source frame rate differs from the timeline. Use matching-rate sources for this preview.`);
        if (filters.some(filter => /timeremap|speed|reverse/i.test(new XMLSerializer().serializeToString(filter)))) issues.push(`${name}: speed effects are unsupported.`);
        if (descendants(item, 'keyframe').length) issues.push(`${name}: animated XML effects are unsupported. Apply them after the Multicam edit.`);
      }
      return { name, path, start: start / fps, end: end / fps, inPoint: sourceIn / mediaFps, outPoint: sourceOut / mediaFps,
        disabled, mediaFps, sourceIn, sourceOut, channel: number(child(item, 'sourcetrack'), 'trackindex') || 1, element: item };
    });
    const active = clips.filter(clip => !clip.disabled).sort((a, b) => a.start - b.start);
    if (active.some((clip, i) => i > 0 && clip.start < active[i - 1].end - 0.1 / fps)) issues.push('Overlapping clips on one selected track are unsupported.');
    return { index, name: text(element, 'name', `${kind === 'video' ? 'Video' : 'Audio'} ${index + 1}`), clips, enabled, issues: [...new Set(issues)], element };
  });
  const sample = child(child(child(child(sequence, 'media'), 'video'), 'format'), 'samplecharacteristics');
  const videoTracks = parseTracks('video'), audioTracks = parseTracks('audio');
  if (!videoTracks.some(track => track.clips.length) && !audioTracks.some(track => track.clips.length)) throw new Error('Export a synchronized timeline with separate camera and microphone tracks.');
  const snapshot = text(child(sequence, 'logginginfo'), 'lognote') === 'smoothy-source-snapshot-v1';
  return { doc, sequence, xml, nativeId:text(sequence,'smoothy-native-id') || undefined, id: `resolve-${createHash('sha256').update(xml).digest('hex')}`, name: text(sequence, 'name', 'Resolve timeline'),
    fps, frames, duration: frames / fps, width: number(sample, 'width') || 1920, height: number(sample, 'height') || 1080,
    videoTracks, audioTracks, warnings: [snapshot
      ? 'Source-only handoff: source clips, timing and mono microphone channels were read directly. Grades, transforms, effects, fades, automation and mixer processing are not copied. Use this for a synced source assembly before finishing. Your original Resolve timeline is untouched.'
      : 'XML handoff keeps only what Resolve exports. Grades, Fusion work and some effects do not round-trip. Run Multicam before finishing; the original Resolve timeline is untouched.'] };
}

export function resolveTimelineInfo(timeline: ResolveTimeline) {
  const tracks = (items: ResolveTrack[]) => items.map(({ element, clips, ...track }) => ({ ...track,
    clips: clips.map(({ element, sourceIn, sourceOut, ...clip }) => clip) }));
  return { hasSequence: true, nle: 'resolve', id: timeline.id, timelineRevision: timeline.id,
    nativeId:timeline.nativeId, name: timeline.name, fps: timeline.fps, duration: timeline.duration, width: timeline.width, height: timeline.height,
    videoTracks: tracks(timeline.videoTracks), audioTracks: tracks(timeline.audioTracks),
    capabilities: { multicam: true, live: false }, warnings: timeline.warnings };
}

/** Clone the exported document so audio, timecode and unselected overlays retain their XML. */
export function renderResolveMulticam(timeline: ResolveTimeline, cameras: number[], ranges: CameraRange[]): string {
  if (cameras.length < 2 || new Set(cameras).size !== cameras.length || cameras.some(i => !Number.isInteger(i) || !timeline.videoTracks[i])) throw new Error('Select at least two different camera tracks.');
  let previous = 0;
  for (const range of ranges) {
    if (![range.startFrame, range.endFrame, range.trackIndex].every(Number.isSafeInteger) || range.startFrame !== previous || range.endFrame <= previous || range.endFrame > timeline.frames || (range.trackIndex !== -1 && !cameras.includes(range.trackIndex))) throw new Error('Invalid Resolve camera edit plan.');
    previous = range.endFrame;
  }
  if (previous !== timeline.frames) throw new Error('The camera edit plan does not cover the timeline.');
  for (const index of cameras) if (timeline.videoTracks[index].issues.length) throw new Error(timeline.videoTracks[index].issues.join('\n'));
  const doc = timeline.doc.cloneNode(true);
  const sequences = descendants(doc, 'sequence').filter(node => child(node, 'media'));
  const sequence = sequences.find(node => node.getAttribute('id') === timeline.sequence.getAttribute('id')) || sequences[0];
  sequence.setAttribute('id', `smoothy-${randomUUID()}`);
  set(sequence, 'name', timeline.name + ' - Auto-Switch');
  set(sequence, 'uuid', randomUUID());
  for(const tag of children(sequence,'smoothy-native-id'))sequence.removeChild(tag);
  const video = child(child(sequence, 'media'), 'video');
  const outputTracks = children(video, 'track');
  const ordered = [...cameras].sort((a, b) => b - a);
  for (const camera of cameras) {
    const track = outputTracks[camera];
    for (const node of [...children(track, 'clipitem'), ...children(track, 'transitionitem')]) track.removeChild(node);
    set(track, 'enabled', 'TRUE');
  }
  let serial = 0;
  const prefix = `smoothy-${randomUUID()}`;
  for (const range of ranges) {
    if (range.trackIndex < 0) continue;
    const order = [range.trackIndex, ...cameras.filter(index => index !== range.trackIndex)];
    order.forEach((camera, position) => {
      for (const clip of timeline.videoTracks[camera].clips) {
        if (clip.disabled) continue;
        const left = Math.max(range.startFrame, Math.round(clip.start * timeline.fps));
        const right = Math.min(range.endFrame, Math.round(clip.end * timeline.fps));
        if (right <= left) continue;
        const item = doc.importNode(clip.element, true);
        item.setAttribute('id', `${prefix}-video-${++serial}`);
        set(item, 'start', left); set(item, 'end', right);
        const sourceIn = clip.sourceIn + left - Math.round(clip.start * timeline.fps);
        set(item, 'in', sourceIn); set(item, 'out', sourceIn + right - left);
        outputTracks[ordered[position]].insertBefore(item, outputTracks[ordered[position]].firstChild);
      }
    });
  }
  // Put every result track in chronological order.
  for (const camera of cameras) {
    const track = outputTracks[camera];
    children(track, 'clipitem').sort((a, b) => number(a, 'start') - number(b, 'start')).forEach(item => track.appendChild(item));
  }
  // Old clip links point at removed cameras. Audio timing/content itself is left intact.
  for (const link of descendants(sequence, 'link')) link.parentNode.removeChild(link);
  const definitions = new Map<string, any>();
  for (const file of descendants(timeline.doc, 'file')) if (text(file, 'pathurl')) definitions.set(file.getAttribute('id'), file);
  const emitted = new Set<string>();
  for (const file of descendants(doc, 'file')) {
    const id = file.getAttribute('id');
    if (!emitted.has(id) && definitions.has(id)) {
      file.parentNode.replaceChild(doc.importNode(definitions.get(id), true), file);
      emitted.add(id);
    } else if (emitted.has(id)) {
      const reference = doc.createElement('file'); reference.setAttribute('id', id);
      file.parentNode.replaceChild(reference, file);
    }
  }
  normalizeSnapshotMedia(doc,timeline.doc);
  return serializeResolveXml(doc);
}

/** Ripple the same frame-aligned speech ranges across all exported tracks. */
export function renderResolveSilence(timeline: ResolveTimeline, speech: {start:number;end:number}[]) {
  for(const track of [...timeline.videoTracks,...timeline.audioTracks]) if(track.issues.length)throw new Error(track.issues.join('\n'));
  const ranges:{start:number;end:number;destination:number}[]=[];let duration=0,previous=0;
  for(const segment of speech){
    const start=Math.max(previous,Math.round(segment.start*timeline.fps)),end=Math.min(timeline.frames,Math.round(segment.end*timeline.fps));
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
    ranges.push({start,end,destination:duration});duration+=end-start;previous=end;
  }
  if(!duration)throw new Error('No speech remained in the Resolve timeline.');
  const doc=timeline.doc.cloneNode(true),sequence=descendants(doc,'sequence').filter(node=>child(node,'media'))[0];
  sequence.setAttribute('id','smoothy-'+randomUUID());set(sequence,'uuid',randomUUID());for(const tag of children(sequence,'smoothy-native-id'))sequence.removeChild(tag);set(sequence,'name',timeline.name+' - Silence Removed');set(sequence,'duration',duration);
  let serial=0;
  for(const kind of ['video','audio'] as const){
    const tracks=children(child(child(sequence,'media'),kind),'track');
    timeline[kind==='video'?'videoTracks':'audioTracks'].forEach((track,index)=>{
      const output=tracks[index];for(const item of children(output,'clipitem'))output.removeChild(item);
      for(const range of ranges)for(const clip of track.clips){
        const left=Math.max(range.start,Math.round(clip.start*timeline.fps)),right=Math.min(range.end,Math.round(clip.end*timeline.fps));
        if(right<=left)continue;
        const item=doc.importNode(clip.element,true);item.setAttribute('id',`smoothy-${kind}-${++serial}`);
        set(item,'start',range.destination+left-range.start);set(item,'end',range.destination+right-range.start);
        const sourceIn=clip.sourceIn+left-Math.round(clip.start*timeline.fps);set(item,'in',sourceIn);set(item,'out',sourceIn+right-left);
        for(const link of children(item,'link'))item.removeChild(link);
        output.appendChild(item);
      }
    });
  }
  normalizeSnapshotMedia(doc,timeline.doc);
  return serializeResolveXml(doc);
}
