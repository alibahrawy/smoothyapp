import { randomUUID } from 'node:crypto';
import catalog from '../shared/photo-catalog.json';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REFS = 6;
type Photo = { id: string; label: string; imageUrl: string; prompt?: string; model?: string; aspectRatio?: string; historyId?: string; createdAt?: string; isFavorite?: boolean };
type PhotoDeps = {
  owner: () => string | null;
  request: (route: string, options?: { method?: string; body?: unknown }) => Promise<any>;
  imageBytes: (url: string) => Promise<Buffer>;
  png: (bytes: Buffer) => Buffer;
  track: (feature: string) => void;
};

function text(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Enter ${label} (maximum ${max.toLocaleString()} characters).`);
  return value.trim();
}

export function validatePhotoReferences(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new Error(`Add up to ${MAX_REFS} reference images.`);
  let total = 0;
  return value.map(image => {
    if (typeof image !== 'string' || image.length > MAX_BYTES * 1.4) throw new Error('Choose an image smaller than 25 MB.');
    const base64 = image.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Choose a PNG, JPEG or WebP image.');
    const bytes = Buffer.from(base64, 'base64'); total += bytes.length;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if ((!png && !jpeg && !webp) || !bytes.length || total > MAX_BYTES) throw new Error('Use PNG, JPEG or WebP references totalling less than 25 MB.');
    return base64;
  });
}

/** Only IDs issued to this signed-in user can reach save, clipboard or Premiere. */
export class PhotoService {
  private user: string | null = null;
  private photos = new Map<string, Photo>();
  private cache = new Map<string, Buffer>();
  private busy = false;
  constructor(private deps: PhotoDeps) {}
  private owner() {
    const user = this.deps.owner();
    if (user !== this.user) { this.photos.clear(); this.cache.clear(); this.user = user; }
    if (!user) throw new Error('Sign in to use AI Photos and shared image history.');
    return user;
  }
  private add(input: Omit<Photo, 'id'>) {
    if (typeof input.imageUrl !== 'string' || !input.imageUrl) throw new Error('The server returned no image. Please retry.');
    const photo = { ...input, id: randomUUID() };
    this.photos.set(photo.id, photo);
    return this.publicPhoto(photo);
  }
  private publicPhoto({ imageUrl: _url, ...photo }: Photo) { return { ...photo, previewUrl: `smoothy-photo://image/${photo.id}` }; }
  private photo(id: string) {
    this.owner();
    const photo = this.photos.get(id);
    if (!photo) throw new Error('This image is no longer available. Reload image history.');
    return photo;
  }
  reset() { this.photos.clear(); this.cache.clear(); this.user = null; }
  async run(input: any) {
    const user = this.owner();
    if (this.busy) throw new Error('Wait for the current image action to finish.');
    const action = input?.action;
    if (!['generate', 'edit', 'preset'].includes(action)) throw new Error('Choose a supported image action.');
    const model = catalog.IMAGE_MODELS.find(item => item.id === input.model)?.id || catalog.DEFAULT_IMAGE_MODEL;
    const caps = catalog.MODEL_CAPABILITIES[model];
    const ratio = catalog.ASPECT_RATIOS.includes(input.aspectRatio) ? input.aspectRatio : (caps.aspectRatios?.includes(catalog.DEFAULT_ASPECT_RATIO) ? catalog.DEFAULT_ASPECT_RATIO : caps.aspectRatios?.[0] || catalog.DEFAULT_ASPECT_RATIO);
    const size = catalog.IMAGE_SIZES.includes(input.imageSize) ? input.imageSize : (caps.imageSizes?.includes(catalog.DEFAULT_IMAGE_SIZE) ? catalog.DEFAULT_IMAGE_SIZE : caps.imageSizes?.[0] || catalog.DEFAULT_IMAGE_SIZE);
    const references = validatePhotoReferences(input.references);
    const selected = input.imageId ? this.photo(input.imageId) : null;
    this.busy = true;
    try {
      let data: any, label: string, prompt = '';
      {
        let images = references;
        if (selected) images = [(await this.bytes(selected.id)).toString('base64')];
        if (action === 'preset') {
          const preset = catalog.REACTION_PRESETS.find(item => item.id === input.presetId);
          if (!preset) throw new Error('Choose a reaction preset.');
          prompt = preset.prompt; label = preset.label;
          if (typeof input.prompt === 'string' && input.prompt.trim()) prompt += `\n\nAdditional instructions: ${text(input.prompt, 10000, 'reaction instructions')}`;
        } else {
          prompt = text(input.prompt, 10000, 'a prompt'); label = prompt.slice(0, 65);
        }
        const maxReferences = caps.maxReferences ?? 6;
        if (images.length > maxReferences) throw new Error(`This model accepts up to ${maxReferences} reference images.`);
        if (caps.aspectRatios && !caps.aspectRatios.includes(ratio)) throw new Error('Choose a supported shape for this model.');
        if (caps.imageSizes && !caps.imageSizes.includes(size)) throw new Error('Choose a supported resolution for this model.');
        if (action !== 'generate' && !images.length) throw new Error('Upload or select a reference image first.');
        if (typeof input.subject === 'string' && input.subject.trim()) prompt = `Subject details: ${text(input.subject, 2000, 'subject details')}.\n\n${prompt}`;
        data = await this.deps.request('/api/generate-reaction', { method: 'POST', body: {
          images, prompt, reactionId: input.presetId || 'custom', reactionLabel: label, model,
          aspectRatio: ratio,
          ...(catalog.MODEL_CAPABILITIES[model]?.supportsImageSize && { imageSize: size }),
          imageType: action === 'edit' ? 'edit' : images.length ? 'reaction' : 'text-to-image',
        } });
      }
      if (this.deps.owner() !== user) throw new Error('Your account changed. Reload image history for your account.');
      const photo = this.add({ label, imageUrl: data.imageUrl, prompt, model, aspectRatio: ratio, historyId: data.savedReactionId, createdAt: new Date().toISOString() });
      this.deps.track(`photos_${action.replace('-', '_')}`);
      return { photo, historySaved: data.historySaved, cloudStorageAvailable: data.cloudStorageAvailable };
    } finally { this.busy = false; }
  }
  async history(page = 1, favorites = false) {
    const user = this.owner();
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('Choose a valid history page.');
    const data = await this.deps.request(`/api/reactions?page=${page}&limit=20${favorites ? '&favorites=true' : ''}`);
    if (this.deps.owner() !== user) throw new Error('Your account changed. Reload history.');
    const items = Array.isArray(data.reactions) ? data.reactions : [];
    return { items: items.map((item: any) => {
      const existing = [...this.photos.values()].find(photo => photo.historyId === item.id);
      const photo = { label: item.reactionLabel || 'Image', imageUrl: item.imageUrl, prompt: item.prompt, model: item.model, aspectRatio: item.aspectRatio, historyId: item.id, createdAt: item.createdAt, isFavorite: Boolean(item.isFavorite) };
      if (existing) { Object.assign(existing, photo); return this.publicPhoto(existing); }
      return this.add(photo);
    }), currentPage: page, totalPages: data.totalPages || 1, totalItems: data.totalItems || 0, cloudStorageAvailable: data.cloudStorageAvailable };
  }
  async favorite(id: string, active: boolean) {
    const photo = this.photo(id), user = this.owner();
    if (!photo.historyId || typeof active !== 'boolean') throw new Error('Reload image history to favorite this image.');
    if (photo.isFavorite === active) return;
    await this.deps.request('/api/reactions', { method: 'PATCH', body: { id: photo.historyId, isFavorite: active } });
    if (this.deps.owner() !== user) throw new Error('Your account changed. Reload history.');
    photo.isFavorite = active; this.deps.track('photos_favorite');
  }
  async remove(id: string) {
    const photo = this.photo(id), user = this.owner();
    if (!photo.historyId) throw new Error('Reload image history to delete this image.');
    await this.deps.request(`/api/reactions/${encodeURIComponent(photo.historyId)}`, { method: 'DELETE' });
    if (this.deps.owner() !== user) throw new Error('Your account changed. Reload history.');
    this.photos.delete(id); this.cache.delete(id); this.deps.track('photos_delete');
  }
  async bytes(id: string) {
    const photo = this.photo(id), user = this.owner();
    if (this.cache.has(id)) return this.cache.get(id)!;
    const bytes = await this.deps.imageBytes(photo.imageUrl);
    if (this.deps.owner() !== user) throw new Error('Your account changed. Reload history.');
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('This image exceeds the 25 MB limit.');
    const png = this.deps.png(bytes);
    if (!png.length || png.length > MAX_BYTES) throw new Error('The image could not be decoded, or exceeds 25 MB as PNG.');
    while (this.cache.size && [...this.cache.values()].reduce((sum, data) => sum + data.length, 0) + png.length > 80 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, png);
    return png;
  }
  label(id: string) { return this.photo(id).label; }
}
