/**
 * Adapters that connect the headless editor to the app's real services:
 * whisper (speech), the YouTube Audio Library archive + saved library, and the
 * stock footage sources. Kept out of the agent bridge so the bridge stays testable.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AudioArchive } from '../audio-archive';
import type { AudioLibrary } from '../audio-library';
import type { StockFootageService, StockVideo } from '../stock-footage';
import * as whisper from '../captions/whisper-service';
import { formatCaptions } from '../captions/caption-formatter';
import { DEFAULT_CAPTION_LANGUAGE, getWhisperLanguageCode } from '../captions/languages';
import { getDefaultModelId, getModelById, isEnglishOnlyModel } from '../captions/model-manager';
import type { FetchedAsset, LibraryService, MusicHit, SpeechService, StockHit } from './edit-features';

export function createSpeechService(deps: {
  store: { get(key: string): unknown };
  isBusy: () => boolean;
}): SpeechService {
  const model = (): string => {
    const id = (deps.store.get('captionModel') as string | null) || getDefaultModelId();
    if (!getModelById(id)) throw new Error('The selected caption model is missing. Pick one in Settings → Captions.');
    return id;
  };
  const language = (requested?: string): string => {
    const id = model();
    if (isEnglishOnlyModel(id)) return 'en';
    const stored = (deps.store.get('captionLanguage') as string | null) || DEFAULT_CAPTION_LANGUAGE;
    return getWhisperLanguageCode(requested || stored);
  };
  return {
    isReady: () => {
      try { return whisper.isModelLoaded() && whisper.getCurrentModelId() === model(); } catch { return false; }
    },
    describe: () => model(),
    async prepare(onProgress, signal) {
      if (deps.isBusy()) throw new Error('A transcription is already running. Try again when it finishes.');
      whisper.setEnginePreference((deps.store.get('captionEngine') as 'auto' | 'cuda' | 'cpu') || 'auto');
      await whisper.loadModel(model(), progress => {
        const pct = typeof progress.progress === 'number' ? Math.round(progress.progress) : 0;
        onProgress(pct, progress.status === 'downloading-bin' ? 'Downloading speech engine' : progress.status === 'downloading' ? 'Downloading speech model' : 'Preparing speech engine');
      }, signal);
    },
    async transcribe(wav, requested, signal, onProgress) {
      if (deps.isBusy()) throw new Error('A transcription is already running. Try again when it finishes.');
      return whisper.transcribe(wav, progress => onProgress(typeof progress.progress === 'number' ? progress.progress : 0, progress.status), model(), language(requested), signal);
    },
    format: (result, settings) => formatCaptions(result, settings as any).map(item => ({ startTime: item.startTime, endTime: item.endTime, text: item.text }))
  };
}

function bestFile(video: StockVideo) {
  const sorted = [...video.files].sort((a, b) => (b.height || 0) - (a.height || 0));
  return sorted.find(file => (file.height || 0) <= 1080) || sorted[sorted.length - 1];
}

export function createLibraryService(deps: {
  archive: AudioArchive;
  library: AudioLibrary;
  stock: StockFootageService;
  stockFolder: () => string;
  trackTool?: (id: string) => void;
  libraryChanged?: () => void;
}): LibraryService {
  const moodNames = ['calm', 'happy', 'bright', 'dramatic', 'dark', 'funky', 'inspirational', 'sad', 'romantic', 'angry'];
  const genreIds: Record<string, string> = { cinematic: 'cinematic', ambient: 'ambient', electronic: 'electronic', dance: 'electronic', hiphop: 'hip-hop', rap: 'hip-hop', jazz: 'jazz-blues', blues: 'jazz-blues', rock: 'rock', pop: 'pop', classical: 'classical', country: 'country-folk', folk: 'country-folk', soul: 'soul', alternative: 'alternative', punk: 'alternative', reggae: 'reggae', world: 'world', holiday: 'holiday', children: 'children' };
  return {
    async musicSearch({ query, mood, genre, limit }): Promise<MusicHit[]> {
      const moodName = moodNames.find(name => name === String(mood || '').toLowerCase());
      const category = genreIds[String(genre || '').toLowerCase().replace(/[^a-z]/g, '')] || 'all';
      const result = await deps.archive.search({ query: query || '', mood: moodName ? moodName[0].toUpperCase() + moodName.slice(1) : '', category, offset: 0 });
      deps.trackTool?.('audio_search');
      return result.tracks.slice(0, limit).map((track: any) => ({ id: track.id, title: track.title, artist: track.artist, genre: track.genre, mood: track.mood, duration: track.duration }));
    },
    async musicFetch(id, signal, progress): Promise<FetchedAsset> {
      const track = await deps.archive.track(id);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-agent-audio-'));
      try {
        const file = path.join(dir, 'track.mp3');
        progress(10, 'Downloading music');
        await deps.archive.download(track.id, file, signal, (received, total) => progress(10 + (total ? (received / total) * 60 : 0), 'Downloading music'));
        progress(75, 'Validating');
        const saved = await deps.library.keepArchive(file, track.title, track.id, signal, track);
        deps.libraryChanged?.();
        deps.trackTool?.('audio_save');
        return { path: await deps.library.file(saved.id), title: track.title, provider: 'YouTube Audio Library', license: 'unverified (archive does not state the licence)', credit: saved.credit };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    async stockSearch({ query, provider, orientation, limit }, signal): Promise<StockHit[]> {
      const result = await deps.stock.search({ query, provider: (provider as any) || 'all', orientation }, signal);
      deps.trackTool?.('stock_search');
      return result.videos.slice(0, limit).flatMap(video => {
        const file = bestFile(video);
        if (!file) return [];
        return [{ ref: `${video.id}|${file.id}`, title: video.title, provider: video.provider, duration: video.duration, width: file.width, height: file.height, license: video.license }];
      });
    },
    async stockFetch(ref, signal, progress): Promise<FetchedAsset> {
      const [rawId, rawFile] = ref.split('|');
      const fileId = Number(rawFile);
      if (!rawId || !Number.isInteger(fileId)) throw new Error('Search stock footage again and use a ref from the results.');
      const id: number | string = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
      const filePath = await deps.stock.download(id, fileId, deps.stockFolder(), signal, (received, total, phase) => progress(phase === 'converting' ? 80 : 10 + (total ? (received / total) * 65 : 0), phase === 'converting' ? 'Converting' : 'Downloading footage'));
      deps.trackTool?.('stock_download');
      let meta: any = {};
      try { meta = JSON.parse(await fs.readFile(filePath + '.source.json', 'utf8')); } catch {}
      return { path: filePath, title: String(meta.title || path.basename(filePath)), provider: String(meta.provider || 'stock'), license: meta.license, credit: meta.creator ? `${meta.creator}${meta.source ? ` — ${meta.source}` : ''}` : undefined, url: meta.source };
    }
  };
}
