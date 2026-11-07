/**
 * Read Premiere effect presets from the user's `.prfpset` XML container.
 *
 * Premiere exposes no scripting API for applying user presets. We rebuild the
 * effect stack and static/keyframed parameter values ourselves, which is the
 * same approach third-party preset tools use.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import type {
  ShortsCutKeyframe,
  ShortsCutPreset,
  ShortsCutPresetComponent,
  ShortsCutPresetProperty,
  ShortsCutValue,
} from './types';

export interface PremierePresetSummary {
  id: string;
  name: string;
  folder: string;
  file: string;
  animated: boolean;
  mediaType: 'video' | 'audio';
  bytes: number;
  components: number;
}

interface FullPreset extends PremierePresetSummary {
  preset: ShortsCutPreset;
}

interface Cache {
  key: string;
  summaries: PremierePresetSummary[];
  full: Map<string, FullPreset>;
  errors: string[];
}

const MAX_BYTES = 512 * 1024;
const MAX_COMPONENTS = 80;
const MAX_PROPERTIES = 1200;
const MAX_KEYFRAMES = 500;
let cache: Cache | null = null;

function direct(parent: any, tag: string): any | null {
  if (!parent?.childNodes) return null;
  for (let index = 0; index < parent.childNodes.length; index++) {
    const child = parent.childNodes[index];
    if (child?.nodeType === 1 && child.tagName === tag) return child;
  }
  return null;
}

function directAll(parent: any, tag: string): any[] {
  const out: any[] = [];
  if (!parent?.childNodes) return out;
  for (let index = 0; index < parent.childNodes.length; index++) {
    const child = parent.childNodes[index];
    if (child?.nodeType === 1 && child.tagName === tag) out.push(child);
  }
  return out;
}

function textOf(parent: any, tag: string): string {
  return String(direct(parent, tag)?.textContent || '').trim();
}

function refOf(parent: any, tag: string): string {
  return String(direct(parent, tag)?.getAttribute?.('ObjectRef') || '');
}

function parseValue(raw: string | null | undefined): ShortsCutValue | undefined {
  const value = String(raw || '').trim();
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.includes(':')) {
    const parts = value.split(':').map(Number);
    if (parts.every((entry) => Number.isFinite(entry))) return parts;
  }
  if (value.includes(',')) {
    const parts = value.split(',').map(Number);
    if (parts.every((entry) => Number.isFinite(entry))) return parts;
  }
  return value;
}

function parseKeyframes(raw: string | null | undefined): ShortsCutKeyframe[] {
  const out: ShortsCutKeyframe[] = [];
  for (const entry of String(raw || '').split(';')) {
    const line = entry.trim();
    if (!line || out.length >= MAX_KEYFRAMES) continue;
    const parts = line.split(',');
    const time = Number(parts[0]);
    const value = parseValue(parts[1]);
    if (!Number.isFinite(time) || value === undefined) continue;
    out.push({ time, value });
  }
  return out;
}

function componentFrom(
  filterPreset: any,
  byId: Map<string, any>,
  propertyBudget: { count: number }
): ShortsCutPresetComponent | null {
  const componentRef = refOf(filterPreset, 'Component');
  const componentRoot = byId.get(componentRef);
  if (!componentRoot) return null;
  const inner = direct(componentRoot, 'Component');
  if (!inner) return null;
  const displayName = textOf(inner, 'DisplayName') || textOf(filterPreset, 'FilterMatchName');
  const matchName = textOf(inner, 'MatchName') || textOf(filterPreset, 'FilterMatchName') || displayName;
  if (!displayName && !matchName) return null;
  const paramsRoot = direct(inner, 'Params');
  const properties: ShortsCutPresetProperty[] = [];
  for (const paramRef of paramsRoot ? directAll(paramsRoot, 'Param') : []) {
    if (propertyBudget.count >= MAX_PROPERTIES) break;
    const param = byId.get(String(paramRef.getAttribute?.('ObjectRef') || ''));
    if (!param) continue;
    const name = textOf(param, 'Name');
    if (!name) continue;
    const keyframes = parseKeyframes(textOf(param, 'Keyframes'));
    const staticValue = parseValue(textOf(param, 'CurrentValue'));
    const startKeyframe = parseKeyframes(textOf(param, 'StartKeyframe'));
    const allKeyframes = keyframes.length ? keyframes : (textOf(param, 'IsTimeVarying') === 'true' ? startKeyframe : []);
    const value = allKeyframes.length ? allKeyframes[0].value : staticValue;
    if (value === undefined) continue;
    properties.push({ name, value, ...(allKeyframes.length > 1 ? { keyframes: allKeyframes } : {}) });
    propertyBudget.count++;
  }
  return { matchName, displayName: displayName || matchName, properties };
}

function parsePresetItem(
  filterPresetItem: any,
  name: string,
  folder: string,
  file: string,
  index: number,
  byId: Map<string, any>
): { summary: PremierePresetSummary; full: FullPreset } | null {
  const presetsRoot = direct(filterPresetItem, 'FilterPresets');
  if (!presetsRoot) return null;
  const refs = directAll(presetsRoot, 'FilterPreset');
  const components: ShortsCutPresetComponent[] = [];
  let animated = false;
  let audioComponents = 0;
  const propertyBudget = { count: 0 };
  for (const ref of refs) {
    if (components.length >= MAX_COMPONENTS) break;
    const filterPreset = byId.get(String(ref.getAttribute?.('ObjectRef') || ''));
    if (!filterPreset) continue;
    const componentRootRef = refOf(filterPreset, 'Component');
    const componentRoot = byId.get(componentRootRef);
    if (!componentRoot) continue;
    const mediaType = componentRoot.tagName === 'AudioFilterComponent' ? 'audio' : 'video';
    if (mediaType === 'audio') audioComponents++;
    const component = componentFrom(filterPreset, byId, propertyBudget);
    if (!component) continue;
    components.push(component);
    if (component.properties.some((property) => property.keyframes?.length)) animated = true;
  }
  if (!components.length) return null;
  const mediaType: 'video' | 'audio' = audioComponents === components.length ? 'audio' : 'video';
  const preset: ShortsCutPreset = {
    mediaType,
    components,
    ...(animated ? { animated: true } : {}),
    source: 'premiere',
  };
  const bytes = Buffer.byteLength(JSON.stringify(preset), 'utf8');
  if (bytes > MAX_BYTES) return null;
  const id = createHash('sha1').update(`${file}|${folder}|${name}|${index}`).digest('hex').slice(0, 20);
  const summary: PremierePresetSummary = {
    id,
    name,
    folder,
    file,
    animated,
    mediaType,
    bytes,
    components: components.length,
  };
  return { summary, full: { ...summary, preset } };
}

function parsePresetXml(xml: string, file: string): { summaries: PremierePresetSummary[]; full: Map<string, FullPreset>; errors: string[] } {
  const summaries: PremierePresetSummary[] = [];
  const full = new Map<string, FullPreset>();
  const errors: string[] = [];
  let doc: any;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
  } catch (error) {
    return { summaries, full, errors: [`Could not parse ${path.basename(file)}: ${error instanceof Error ? error.message : 'invalid XML'}`] };
  }
  const root = doc?.documentElement;
  if (!root) return { summaries, full, errors: [`${path.basename(file)} is empty.`] };
  const byId = new Map<string, any>();
  for (let index = 0; index < root.childNodes.length; index++) {
    const child = root.childNodes[index];
    if (child?.nodeType !== 1) continue;
    const objectId = String(child.getAttribute?.('ObjectID') || '');
    if (objectId) byId.set(objectId, child);
  }
  const binItems = directAll(root, 'BinTreeItem');
  const rootBin = binItems.find((bin) => textOf(direct(bin, 'TreeItemBase'), 'Name') === 'Root');
  if (!rootBin) return { summaries, full, errors: [`${path.basename(file)} has no Root bin.`] };
  const presetsBin = directAll(direct(rootBin, 'Items'), 'Item')
    .map((item) => byId.get(String(item.getAttribute?.('ObjectRef') || '')))
    .find((item) => item && textOf(direct(item, 'TreeItemBase'), 'Name') === 'Presets');
  if (!presetsBin) return { summaries, full, errors: [`${path.basename(file)} has no Presets bin.`] };
  const pathParts = file.split(path.sep);
  const productIndex = pathParts.findIndex((part) => part === 'Premiere Pro' || part === 'Premiere Pro (Beta)');
  const product = productIndex >= 0 ? pathParts[productIndex] : 'Premiere';
  const version = productIndex >= 0 ? pathParts[productIndex + 1] || '' : '';
  const productLabel = version ? `${product} ${version}` : product;
  let index = 0;
  function walk(bin: any, folder: string) {
    const itemsRoot = direct(bin, 'Items');
    for (const item of itemsRoot ? directAll(itemsRoot, 'Item') : []) {
      const child = byId.get(String(item.getAttribute?.('ObjectRef') || ''));
      if (!child) continue;
      const treeBase = direct(child, 'TreeItemBase');
      const name = textOf(treeBase, 'Name');
      if (!name) continue;
      if (child.tagName === 'BinTreeItem') {
        walk(child, folder ? `${folder} / ${name}` : name);
        continue;
      }
      const dataRef = refOf(treeBase, 'Data');
      const filterPresetItem = dataRef ? byId.get(dataRef) : null;
      if (!filterPresetItem) continue;
      const parsed = parsePresetItem(filterPresetItem, name, [productLabel, folder].filter(Boolean).join(' / '), file, index++, byId);
      if (parsed) {
        if (!full.has(parsed.summary.id)) {
          summaries.push(parsed.summary);
          full.set(parsed.summary.id, parsed.full);
        }
      }
    }
  }
  walk(presetsBin, '');
  return { summaries, full, errors };
}

function scanPresetFiles(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string, depth: number) {
    if (depth > 5 || files.length >= 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.prfpset')) {
        try {
          if (fs.statSync(full).size <= 40 * 1024 * 1024) files.push(full);
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }
  walk(root, 0);
  return files;
}

function findPresetFiles(): string[] {
  // Prefer the release profile. Beta copies the same preset container and would
  // otherwise duplicate every shortcut in the picker.
  const stable = scanPresetFiles(path.join(os.homedir(), 'Documents', 'Adobe', 'Premiere Pro'));
  if (stable.length) return stable;
  return scanPresetFiles(path.join(os.homedir(), 'Documents', 'Adobe', 'Premiere Pro (Beta)'));
}

function cacheKey(files: string[]): string {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${file}:missing`;
    }
  }).join('|');
}

function load(force = false): Cache {
  const files = findPresetFiles();
  const key = cacheKey(files);
  if (!force && cache && cache.key === key) return cache;
  const summaries: PremierePresetSummary[] = [];
  const full = new Map<string, FullPreset>();
  const errors: string[] = [];
  for (const file of files) {
    try {
      const parsed = parsePresetXml(fs.readFileSync(file, 'utf8'), file);
      errors.push(...parsed.errors);
      for (const summary of parsed.summaries) {
        if (full.has(summary.id)) continue;
        summaries.push(summary);
        const fullPreset = parsed.full.get(summary.id);
        if (fullPreset) full.set(summary.id, fullPreset);
      }
    } catch (error) {
      errors.push(`Could not read ${path.basename(file)}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  summaries.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  cache = { key, summaries, full, errors };
  return cache;
}

export function listPremierePresets(force = false): { presets: PremierePresetSummary[]; errors: string[] } {
  const loaded = load(force);
  return { presets: loaded.summaries, errors: loaded.errors };
}

export function getPremierePreset(id: string): (FullPreset & { id: string }) | null {
  const loaded = load();
  return loaded.full.get(id) || null;
}

/** Exposed for tests; avoids touching the real Premiere profile. */
export function parsePremierePresetXmlForTest(xml: string, file = 'fixture.prfpset') {
  return parsePresetXml(xml, file);
}
