/**
 * Keeping agent context small: a disk cache keyed by input hash, and compaction
 * of large tool results into a short preview plus a JSON file on disk.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Identity of an input file for cache keys: path, size and modification time. */
export async function fileStamp(file: string): Promise<{ path: string; size: number; mtime: number } | null> {
  try {
    const stat = await fs.stat(file);
    return { path: file, size: stat.size, mtime: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

export function hashKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);
}

export class ResultCache {
  constructor(private readonly dir: string, private readonly limit = 400) {}

  private file(kind: string, key: string): string {
    return path.join(this.dir, `${kind.replace(/[^\w.-]+/g, '-')}-${key}.json`);
  }

  async get<T = any>(kind: string, key: string): Promise<T | null> {
    try {
      const text = await fs.readFile(this.file(kind, key), 'utf8');
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async set(kind: string, key: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(kind, key);
    const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value));
    await fs.rename(temp, target);
    void this.prune();
  }

  private pruning = false;
  private async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const names = (await fs.readdir(this.dir)).filter(name => name.endsWith('.json'));
      if (names.length <= this.limit) return;
      const stats = await Promise.all(names.map(async name => ({ name, at: (await fs.stat(path.join(this.dir, name)).catch(() => null))?.mtimeMs || 0 })));
      stats.sort((a, b) => a.at - b.at);
      for (const item of stats.slice(0, stats.length - this.limit)) await fs.rm(path.join(this.dir, item.name), { force: true });
    } catch {
      // Cache pruning is best effort.
    } finally {
      this.pruning = false;
    }
  }
}

export const RESULT_LIMIT = 16 * 1024;
export const DETAIL_LIMIT = 96 * 1024;

/** Shrinks a value: long arrays keep their first items, long strings are cut. */
export function previewValue(value: unknown, depth = 0, maxItems = 12, maxString = 1200): unknown {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}… (${value.length} chars)` : value;
  if (!value || typeof value !== 'object') return value;
  if (depth > 6) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map(item => previewValue(item, depth + 1, maxItems, maxString));
    if (value.length > maxItems) items.push(`… ${value.length - maxItems} more (full list in resultFile)`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = previewValue(item, depth + 1, maxItems, maxString);
  return out;
}

/**
 * Returns `data` unchanged when it is small. Otherwise writes the full value to
 * `dir` and returns a preview with `resultFile` (the full JSON) and `truncated`.
 */
export async function compactData(data: unknown, options: { limit: number; dir: string; name: string }): Promise<{ data: unknown; truncated: boolean; file?: string }> {
  const text = JSON.stringify(data ?? null);
  if (text.length <= options.limit) return { data, truncated: false };
  await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(options.dir, `${options.name.replace(/[^\w.-]+/g, '-')}-${stamp}-${Math.random().toString(36).slice(2, 6)}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 1));
  let preview = previewValue(data);
  if (JSON.stringify(preview).length > options.limit) preview = previewValue(data, 0, 4, 300);
  if (JSON.stringify(preview).length > options.limit) {
    const shallow: Record<string, unknown> = {};
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, item] of Object.entries(data as Record<string, unknown>)) {
        shallow[key] = item && typeof item === 'object' ? (Array.isArray(item) ? `[${item.length} items]` : '{…}') : previewValue(item, 0, 4, 200);
      }
    }
    preview = shallow;
  }
  const wrapped = preview && typeof preview === 'object' && !Array.isArray(preview)
    ? { ...(preview as Record<string, unknown>), resultFile: file, truncated: true, fullBytes: text.length }
    : { preview, resultFile: file, truncated: true, fullBytes: text.length };
  void pruneDir(options.dir, 300);
  return { data: wrapped, truncated: true, file };
}

async function pruneDir(dir: string, keep: number): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    if (names.length <= keep) return;
    const stats = await Promise.all(names.map(async name => ({ name, at: (await fs.stat(path.join(dir, name)).catch(() => null))?.mtimeMs || 0 })));
    stats.sort((a, b) => a.at - b.at);
    for (const item of stats.slice(0, stats.length - keep)) await fs.rm(path.join(dir, item.name), { force: true });
  } catch {
    // Best effort.
  }
}
