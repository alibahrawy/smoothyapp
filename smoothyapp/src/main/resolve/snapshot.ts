import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import path from 'path';
import { pathToFileURL } from 'url';
import { parseResolveTimeline, normalizeSnapshotMedia } from './timeline';

export const SNAPSHOT_LIMIT = 512 * 1024;

/** Read-only native getters and pure Lua encoding. No filesystem or module APIs. */
export const snapshotLua = String.raw`
local function encode(value)
  local kind = type(value)
  if kind == "string" then
    return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
      if c == '"' then return '\\"' end
      if c == '\\' then return '\\\\' end
      return string.format('\\u%04x', string.byte(c))
    end) .. '"'
  end
  if kind == "number" then
    if value ~= value or value == math.huge or value == -math.huge then error("Invalid native number") end
    return tostring(value)
  end
  if kind == "boolean" then return tostring(value) end
  if kind ~= "table" then return "null" end
  local output = {}
  for key, item in pairs(value) do output[#output+1] = encode(tostring(key)) .. ':' .. encode(item) end
  return '{' .. table.concat(output, ',') .. '}'
end
local function captureTimeline(timeline)
  local settings = attempt(function() return timeline:GetSettings() end) or {}
  local function setting(key)
    return settings[key] or attempt(function() return timeline:GetSetting(key) end)
  end
  local data = {
    version=1, nativeId=attempt(function() return timeline:GetUniqueId() end), name=timeline:GetName(), origin=timeline:GetStartFrame(), finish=timeline:GetEndFrame(),
    timecode=timeline:GetStartTimecode(), fps=setting("timelineFrameRate"),
    width=setting("timelineResolutionWidth"), height=setting("timelineResolutionHeight"),
    video={}, audio={}
  }
  local count = 0
  for _, kind in ipairs({"video", "audio"}) do
    local tracks = timeline:GetTrackCount(kind)
    if type(tracks) ~= "number" or tracks > 64 then error("Too many tracks") end
    for index=1,tracks do
      local track = {name=timeline:GetTrackName(kind,index), enabled=timeline:GetIsTrackEnabled(kind,index), clips={}}
      data[kind][index] = track
      local items = timeline:GetItemListInTrack(kind,index)
      if type(items) ~= "table" then error("Cannot read timeline track") end
      for _, item in ipairs(items) do
        count = count + 1
        if count > 512 then error("Too many source clips") end
        local media = item:GetMediaPoolItem()
        local properties = media and media:GetClipProperty() or {}
        track.clips[#track.clips+1] = {
          name=item:GetName(), path=properties["File Path"], fps=properties["FPS"], frames=properties["Frames"], timecode=properties["Start TC"],
          start=item:GetStart(true), finish=item:GetEnd(true),
          left=item:GetLeftOffset(true), sourceStart=item:GetSourceStartFrame(), sourceEnd=item:GetSourceEndFrame(),
          enabled=item:GetClipEnabled(),
          speed=attempt(function() return item:GetSpeed() end),
          fusion=attempt(function() return item:GetFusionCompCount() end),
          mapping=kind == "audio" and attempt(function() return item:GetSourceAudioChannelMapping() end) or nil
        }
      end
    end
  end
  local json = encode(data)
  if #json > 524288 then error("Timeline snapshot exceeds the development limit") end
  local hex = json:gsub('.', function(c) return string.format('%02x', string.byte(c)) end)
  preferences:SetPrefs("Global.SmoothyEditSnapshotV1", tostring(serial) .. '|' .. hex)
end
`;

function object(value: any, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} in the Resolve handoff.`);
  return value;
}
function list(value: any, maximum: number, label: string): any[] {
  const record = object(value, label), keys = Object.keys(record);
  if (keys.length > maximum || keys.some((key, i) => key !== String(i + 1))) throw new Error(`Invalid ${label} in the Resolve handoff.`);
  return keys.map(key => record[key]);
}
function finite(value: any, label: string) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`Missing ${label} in the Resolve handoff.`);
  return Number(value);
}
function string(value: any, label: string, limit = 4096) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Invalid ${label} in the Resolve handoff.`);
  return value;
}

/** Conservative source-only reconstruction, used only after native XML export refuses. */
export function snapshotToXml(input: unknown): string {
  const data = object(input, 'snapshot');
  if (data.version !== 1) throw new Error('Unsupported Resolve snapshot version. Reinstall Send to Smoothy.');
  const rawFps = finite(data.fps, 'timeline frame rate');
  const base = Math.round(rawFps);
  const ntsc = Math.abs(rawFps - base * 1000 / 1001) < 0.002 && rawFps !== base;
  const fps = ntsc ? base * 1000 / 1001 : rawFps;
  if (!(fps > 0 && fps <= 120) || (!ntsc && fps !== base)) throw new Error('Unsupported Resolve timeline frame rate.');
  const origin = finite(data.origin, 'timeline origin'), frames = finite(data.finish, 'timeline end') - origin;
  if (!Number.isSafeInteger(origin) || !Number.isSafeInteger(frames) || frames <= 0) throw new Error('Invalid Resolve timeline duration.');
  const timecode = string(data.timecode, 'timecode');
  if (!/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(timecode)) throw new Error('Invalid Resolve timeline timecode.');
  const width = finite(data.width, 'timeline width'), height = finite(data.height, 'timeline height');
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw new Error('Invalid Resolve timeline dimensions.');
  const doc = new DOMImplementation().createDocument(null, 'xmeml', null);
  doc.documentElement.setAttribute('version', '5');
  const node = (parent: any, tag: string, value?: any) => { const element = doc.createElement(tag); if (value !== undefined) element.textContent = String(value); parent.appendChild(element); return element; };
  const rate = (parent: any) => { const r = node(parent, 'rate'); node(r, 'timebase', base); node(r, 'ntsc', ntsc ? 'TRUE' : 'FALSE'); };
  const seq = node(doc.documentElement, 'sequence'); seq.setAttribute('id', 'smoothy-source-snapshot');
  if(typeof data.nativeId==='string' && data.nativeId.length<=256)node(seq,'smoothy-native-id',data.nativeId);
  node(seq, 'name', string(data.name, 'timeline name')); node(seq, 'duration', frames); rate(seq);
  const tc = node(seq, 'timecode'); rate(tc); node(tc, 'string', timecode); node(tc, 'frame', origin); node(tc, 'displayformat', timecode.includes(';') ? 'DF' : 'NDF');
  // This marker persists the source-only limitation after the handoff XML is saved/reloaded.
  node(node(seq, 'logginginfo'), 'lognote', 'smoothy-source-snapshot-v1');
  const media = node(seq, 'media'); let total = 0;
  for (const kind of ['video', 'audio']) {
    const target = node(media, kind);
    if (kind === 'video') { const sample = node(node(target, 'format'), 'samplecharacteristics'); rate(sample); node(sample, 'width', width); node(sample, 'height', height); }
    for (const nativeTrack of list(data[kind], 64, `${kind} tracks`)) {
      const track = object(nativeTrack, 'track');
      if (typeof track.enabled !== 'boolean') throw new Error('Resolve did not report whether a track is enabled.');
      const outTrack = node(target, 'track'); node(outTrack, 'name', string(track.name, 'track name')); node(outTrack, 'enabled', track.enabled ? 'TRUE' : 'FALSE');
      for (const rawClip of list(track.clips, 512, 'clips')) {
        if (++total > 512) throw new Error('This Resolve handoff exceeds 512 source clips.');
        const clip = object(rawClip, 'clip'), name = string(clip.name, 'clip name');
        if (typeof clip.enabled !== 'boolean') throw new Error(`${name}: Resolve did not report clip enablement.`);
        const source = string(clip.path, 'source path');
        if (!path.isAbsolute(source)) throw new Error(`${name}: nested, multicam, generator or missing-media clip. Use manual XML handoff or decompose it to source clips.`);
        const sourceFps = finite(clip.fps, 'source frame rate');
        if (Math.abs(sourceFps - fps) > 0.01) throw new Error(`${name}: snapshot handoff requires matching source and timeline rates. Use manual XML for this timeline.`);
        const start = finite(clip.start, 'clip start') - origin, end = finite(clip.finish, 'clip end') - origin;
        // LeftOffset is exact at normal speed and uses timeline frames for audio.
        // SourceStart/End provide an independent retime witness in the media rate.
        const sourceIn = finite(clip.left, 'source offset'), sourceStart = finite(clip.sourceStart, 'source start'), sourceEnd = finite(clip.sourceEnd, 'source end');
        if (![start, end, sourceIn].every(Number.isSafeInteger) || start < 0 || end <= start || end > frames || sourceIn < 0 || Math.abs(sourceStart - sourceIn) > 1.01 || Math.abs((sourceEnd - sourceStart) - (end - start)) > 1.01 || sourceEnd <= sourceStart) throw new Error(`${name}: ambiguous, retimed or subframe source timing. Use manual XML handoff.`);
        const speed = object(clip.speed, 'clip speed');
        if (finite(speed.Percentage, 'clip speed') !== 100) throw new Error(`${name}: snapshot handoff requires normal-speed clips.`);
        if (finite(clip.fusion, 'Fusion composition count') !== 0) throw new Error(`${name}: Fusion clips require manual XML handoff or editing after Multicam.`);
        let channel = 1, channelCount = 1, muted = false;
        if (kind === 'audio') {
          let mapping: any;
          try { mapping = JSON.parse(string(clip.mapping, 'source channel mapping', 32768)); } catch { throw new Error(`${name}: source audio mapping is unavailable. Use manual XML handoff.`); }
          const maps = Object.values(object(mapping.track_mapping, 'audio mapping'));
          const m: any = maps[0];
          // Refuse unknown/stereo/multichannel/linked mappings instead of merging microphones.
          if (maps.length !== 1 || !m || String(m.type).toLowerCase() !== 'mono' || !Array.isArray(m.channel_idx) || m.channel_idx.length !== 1 || !Number.isInteger(m.channel_idx[0]) || m.channel_idx[0] < 1 || m.channel_idx[0] > mapping.embedded_audio_channels || Object.keys(mapping.linked_audio || {}).length) throw new Error(`${name}: the automatic source handoff currently requires isolated mono audio without linked media. Use manual XML to retain this audio layout.`);
          channel = m.channel_idx[0]; channelCount = mapping.embedded_audio_channels; muted = m.mute === true;
        }
        const outClip = node(outTrack, 'clipitem'); outClip.setAttribute('id', `snapshot-${total}`);
        node(outClip, 'name', name); node(outClip, 'enabled', clip.enabled && !muted ? 'TRUE' : 'FALSE'); node(outClip, 'duration', end - start); rate(outClip);
        node(outClip, 'start', start); node(outClip, 'end', end); node(outClip, 'in', sourceIn); node(outClip, 'out', sourceIn + end - start);
        const file = node(outClip, 'file'); file.setAttribute('id', `snapshot-media-${total}`); node(file, 'name', path.basename(source)); node(file, 'pathurl', pathToFileURL(source).href); rate(file);
        const nativeFrames=Number(clip.frames);
        node(file,'duration',Number.isSafeInteger(nativeFrames) && nativeFrames>=sourceIn+end-start?nativeFrames:sourceIn+end-start);
        if(typeof clip.timecode==='string' && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(clip.timecode)){
          const tc=node(file,'timecode');node(tc,'string',clip.timecode);node(tc,'displayformat',clip.timecode.includes(';')?'DF':'NDF');rate(tc);
        }
        const sourceMedia = node(file, 'media');
        if (kind === 'audio') { node(node(sourceMedia, 'audio'), 'channelcount', channelCount); }
        else { const sample = node(node(sourceMedia, 'video'), 'samplecharacteristics'); rate(sample); node(sample, 'width', width); node(sample, 'height', height); }
        const st = node(outClip, 'sourcetrack'); node(st, 'mediatype', kind); node(st, 'trackindex', channel);
      }
    }
  }
  normalizeSnapshotMedia(doc);
  const xml = new XMLSerializer().serializeToString(doc);
  const parsed = parseResolveTimeline(xml);
  const issues = [...parsed.videoTracks, ...parsed.audioTracks].flatMap(track => track.issues);
  if (issues.length) throw new Error(issues[0]);
  return xml;
}
