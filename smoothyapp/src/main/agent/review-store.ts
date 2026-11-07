import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentAuthor, ReviewThread } from './types';

const MAX_BODY = 6000;
const MAX_REPLIES = 80;
const MAX_THREADS = 1500;
const STORE_VERSION = 1;

type StoreShape = {
  version: number;
  threads: ReviewThread[];
};

function cleanBody(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, MAX_BODY);
}

/**
 * Review notes live next to the app, not in the user's media folder. Writes are
 * atomic so a crash cannot truncate the only copy of a review session.
 */
export class ReviewStore {
  private state: StoreShape = { version: STORE_VERSION, threads: [] };
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly events = new EventEmitter();

  constructor(private readonly file: string) {
    this.events.setMaxListeners(50);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as StoreShape;
      if (parsed?.version === STORE_VERSION && Array.isArray(parsed.threads)) {
        this.state = {
          version: STORE_VERSION,
          threads: parsed.threads.filter(thread => thread && typeof thread.id === 'string').slice(0, MAX_THREADS)
        };
      }
    } catch {
      // A missing or corrupt review file starts a fresh, empty session.
    }
  }

  private save(): Promise<void> {
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    return this.saveChain;
  }

  onChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  private changed(): void {
    this.events.emit('change');
  }

  count(): { total: number; open: number } {
    return {
      total: this.state.threads.length,
      open: this.state.threads.filter(thread => thread.status === 'open').length
    };
  }

  list(options: { since?: string; includeResolved?: boolean } = {}): ReviewThread[] {
    const since = options.since ? new Date(options.since).getTime() : 0;
    return this.state.threads
      .filter(thread => (options.includeResolved || thread.status !== 'resolved') && (!since || new Date(thread.createdAt).getTime() > since))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(thread => ({ ...thread, replies: thread.replies.slice(-MAX_REPLIES) }));
  }

  latestStamp(): string {
    return this.state.threads.reduce((latest, thread) => (thread.createdAt > latest ? thread.createdAt : latest), '');
  }

  async add(input: {
    time: number;
    timecode: string;
    frame: number;
    body: string;
    author: AgentAuthor;
    sequenceId: string | null;
    sequenceName: string | null;
    revision: number | null;
    drawing?: unknown[];
    screenshot?: ReviewThread['screenshot'];
  }): Promise<ReviewThread> {
    const now = new Date().toISOString();
    const thread: ReviewThread = {
      id: randomUUID(),
      sequenceId: input.sequenceId,
      sequenceName: input.sequenceName,
      revision: input.revision,
      frame: Number.isFinite(input.frame) ? Math.max(0, Math.round(input.frame)) : 0,
      time: Number.isFinite(input.time) ? Math.max(0, input.time) : 0,
      timecode: String(input.timecode || '00:00:00:00').slice(0, 20),
      body: cleanBody(input.body) || `Note at ${input.timecode || 'the playhead'}`,
      author: input.author === 'agent' ? 'agent' : 'user',
      status: 'open',
      createdAt: now,
      updatedAt: now,
      drawing: Array.isArray(input.drawing) ? input.drawing.slice(0, 400) : [],
      screenshot: input.screenshot || null,
      replies: []
    };
    this.state.threads.push(thread);
    if (this.state.threads.length > MAX_THREADS) this.state.threads = this.state.threads.slice(-MAX_THREADS);
    await this.save();
    this.changed();
    return thread;
  }

  async reply(id: string, body: string, author: AgentAuthor): Promise<ReviewThread> {
    const thread = this.state.threads.find(item => item.id === id);
    if (!thread) throw new Error('Review note not found.');
    const text = cleanBody(body);
    if (!text) throw new Error('Write a reply first.');
    thread.replies.push({ id: randomUUID(), body: text, author: author === 'agent' ? 'agent' : 'user', createdAt: new Date().toISOString() });
    thread.replies = thread.replies.slice(-MAX_REPLIES);
    thread.updatedAt = new Date().toISOString();
    await this.save();
    this.changed();
    return thread;
  }

  async resolve(id: string, resolved: boolean): Promise<ReviewThread> {
    const thread = this.state.threads.find(item => item.id === id);
    if (!thread) throw new Error('Review note not found.');
    thread.status = resolved ? 'resolved' : 'open';
    thread.updatedAt = new Date().toISOString();
    await this.save();
    this.changed();
    return thread;
  }

  async waitForChange(since: string, timeoutMs: number): Promise<ReviewThread[]> {
    if (!since) return this.list({ includeResolved: true });
    const initial = this.latestStamp();
    if (initial > since) return this.list({ since, includeResolved: true });
    await new Promise<void>(resolve => {
      let timer: NodeJS.Timeout | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.events.off('change', onChange);
        resolve();
      };
      const onChange = () => done();
      timer = setTimeout(done, Math.max(1000, Math.min(120000, timeoutMs || 25000)));
      this.events.on('change', onChange);
    });
    return this.list({ since, includeResolved: true });
  }

  /** Remove notes and replies for a sequence that no longer exists. */
  async pruneMissingSequence(sequenceId: string): Promise<void> {
    const before = this.state.threads.length;
    this.state.threads = this.state.threads.filter(thread => thread.sequenceId !== sequenceId);
    if (this.state.threads.length !== before) {
      await this.save();
      this.changed();
    }
  }
}
