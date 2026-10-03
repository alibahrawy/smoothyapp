import { randomUUID } from 'node:crypto';

type Store = { get(key: string): unknown; set(key: string, value: unknown): void };
type Favorite = { active: boolean; updatedAt: number };
const archiveId = /^[A-Za-z0-9_-]{20,100}$/;
const localId = /^local:[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Local stars are authoritative. Only archive IDs are shared, once per install. */
export class AudioFavorites {
  private favorites: Record<string, Favorite> = {};
  private pending: Record<string, Favorite> = {};
  private counts: Record<string, number> = {};
  private staffPicks: string[] = [];
  private syncing?: Promise<void>;
  private refreshing?: Promise<void>;
  private fetchedAt = 0;
  private online = false;
  private installId: string;
  private readonly sharingAllowed: boolean;
  private syncController?: AbortController;
  constructor(private store: Store, private changed = () => {}, private request: typeof fetch = fetch,
    private endpoint = process.env.SMOOTHY_API_URL || 'https://smoothyedit.com', private share = process.env.SMOOTHY_TELEMETRY !== '0', private now = () => Date.now()) {
    this.sharingAllowed = share;
    this.share = share && store.get('audioFavoriteSharing') !== false;
    for (const [id, value] of Object.entries((store.get('audioFavorites') || {}) as object)) {
      const item = value as Favorite;
      if ((archiveId.test(id) || localId.test(id)) && typeof item?.active === 'boolean' && Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0) this.favorites[id] = item;
    }
    for (const [id, value] of Object.entries((store.get('audioFavoritePending') || {}) as object)) {
      if (archiveId.test(id) && this.favorites[id] && (value as Favorite)?.updatedAt === this.favorites[id].updatedAt) this.pending[id] = this.favorites[id];
    }
    const cached = store.get('audioCommunityCache') as any;
    try { if (cached) this.accept(cached); } catch { /* Rebuild an invalid community cache online. */ }
    const saved = store.get('installId');
    this.installId = typeof saved === 'string' && uuid.test(saved) ? saved : randomUUID();
    if (this.share && this.installId !== saved) store.set('installId', this.installId);
  }
  private accept(data: any) {
    if (!data || typeof data.counts !== 'object' || !Array.isArray(data.staffPicks)) throw new Error('Invalid community data.');
    this.counts = Object.fromEntries(Object.entries(data.counts || {}).filter(([id, count]) => archiveId.test(id) && Number.isSafeInteger(count) && Number(count) >= 0)) as Record<string, number>;
    this.staffPicks = data.staffPicks.filter((id: unknown) => typeof id === 'string' && archiveId.test(id));
  }
  snapshot() { return { favorites: Object.keys(this.favorites).filter(id => this.favorites[id].active), counts: { ...this.counts }, staffPicks: [...this.staffPicks], online: this.online, sharing: this.share, sharingLocked: !this.sharingAllowed, pending: Object.keys(this.pending).length }; }
  setSharing(enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to share favorites.');
    if (enabled && !this.sharingAllowed) throw new Error('Favorite sharing is disabled for this installation.');
    this.share = enabled;
    this.store.set('audioFavoriteSharing', enabled);
    if (enabled) {
      this.store.set('installId', this.installId);
      if (this.syncing) void this.syncing.then(() => this.sync()); else void this.sync();
    } else this.syncController?.abort();
    this.changed(); return this.snapshot();
  }
  set(id: string, active: boolean) {
    if (!(archiveId.test(id) || localId.test(id)) || typeof active !== 'boolean') throw new Error('Choose an audio track to favorite.');
    if (this.favorites[id]?.active === active) return this.snapshot();
    const item = { active, updatedAt: Math.max(this.now(), (this.favorites[id]?.updatedAt || 0) + 1) };
    this.favorites[id] = item;
    if (archiveId.test(id)) this.pending[id] = item;
    this.store.set('audioFavorites', this.favorites);
    this.store.set('audioFavoritePending', this.pending);
    this.changed(); void this.sync(); return this.snapshot();
  }
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing;
    if (!force && this.now() - this.fetchedAt < 60000) return;
    this.refreshing = (async () => {
      try {
        const response = await this.request(`${this.endpoint}/api/audio/community`, { signal: AbortSignal.timeout(10000), credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error('Community data unavailable.');
        this.accept(await response.json()); this.online = true; this.fetchedAt = this.now();
        this.store.set('audioCommunityCache', { counts: this.counts, staffPicks: this.staffPicks });
      } catch { this.online = false; }
      this.changed();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  async sync() {
    if (!this.share) return;
    if (this.syncing) return this.syncing;
    const controller = new AbortController(); this.syncController = controller;
    this.syncing = (async () => {
      try {
        while (this.share && !controller.signal.aborted && Object.keys(this.pending).length) {
          const batch = Object.entries(this.pending).slice(0, 100).map(([trackId, item]) => ({ trackId, ...item }));
          const response = await this.request(`${this.endpoint}/api/audio/favorites`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'omit', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), body: JSON.stringify({ installId: this.installId, favorites: batch }) });
          if (!response.ok || (await response.json()).ok !== true) throw new Error('Favorite sync unavailable.');
          for (const item of batch) if (this.pending[item.trackId]?.updatedAt === item.updatedAt) delete this.pending[item.trackId];
          this.store.set('audioFavoritePending', this.pending);
        }
        if (this.share && !controller.signal.aborted) await this.refresh(true);
      } catch { if (!controller.signal.aborted) this.online = false; this.changed(); }
    })().finally(() => { this.syncing = undefined; this.syncController = undefined; });
    return this.syncing;
  }
}
