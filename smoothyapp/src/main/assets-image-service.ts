import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { ensureAssetModel, type AssetOperation, type AssetProgress } from './assets-models';

export function createAssetsImageService(options: {
  modelRoot: () => string;
  spawn: (job: any, progress: (data: AssetProgress) => void, signal: AbortSignal) => Promise<void>;
  track: (id: string) => void;
  ensureModel?: typeof ensureAssetModel;
}) {
  let active: AbortController | null = null;
  return {
    cancel() { active?.abort(); return { success: true }; },
    async process(input: { operation?: unknown; bytes?: unknown; factor?: unknown }, progress: (data: AssetProgress) => void) {
      if (active) return { success: false, error: 'An image is already being processed.' };
      if (!input || !['remove-background', 'upscale'].includes(input.operation as string)) return { success: false, error: 'Choose a supported image tool.' };
      if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > 64 * 1024 * 1024) return { success: false, error: 'Choose an image smaller than 64 MB.' };
      if (input.operation === 'upscale' && input.factor !== 2 && input.factor !== 4) return { success: false, error: 'Choose 2× or 4× upscaling.' };
      const operation = input.operation as AssetOperation;
      const controller = new AbortController();
      active = controller;
      let folder: string | null = null;
      const report = (data: AssetProgress) => { if (!controller.signal.aborted) { try { progress(data); } catch {} } };
      try {
        const bytes = Buffer.from(input.bytes);
        const metadata = await sharp(bytes, { limitInputPixels: 8192 * 8192 }).metadata();
        if (metadata.format !== 'png' || !metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 8192) throw new Error('Choose a valid PNG image up to 8192 pixels per side.');
        const factor = operation === 'upscale' ? input.factor as number : 1;
        if (operation === 'upscale' && (Math.max(metadata.width, metadata.height) * factor > 8192 || metadata.width * metadata.height * factor * factor > 32 * 1024 * 1024)) throw new Error('Upscaled images must fit 8192 pixels per side and 32 megapixels. Choose 2× or a smaller source.');
        controller.signal.throwIfAborted();
        const model = await (options.ensureModel || ensureAssetModel)(operation, options.modelRoot(), controller.signal, report);
        controller.signal.throwIfAborted();
        folder = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-image-'));
        const inputPath = path.join(folder, 'input.png'), outputPath = path.join(folder, 'output.png');
        await fs.writeFile(inputPath, bytes, { mode: 0o600 });
        controller.signal.throwIfAborted();
        await options.spawn({ operation, factor, model, input: inputPath, output: outputPath }, report, controller.signal);
        controller.signal.throwIfAborted();
        const output = await fs.readFile(outputPath);
        const result = await sharp(output).metadata();
        if (result.format !== 'png' || result.width !== metadata.width * factor || result.height !== metadata.height * factor) throw new Error('The processed image could not be verified. Try again.');
        controller.signal.throwIfAborted();
        try { options.track(operation === 'upscale' ? 'assets_upscale' : 'assets_remove_background'); } catch {}
        return { success: true, bytes: new Uint8Array(output), width: result.width, height: result.height };
      } catch (error) {
        if (controller.signal.aborted) return { success: false, canceled: true };
        const message = error instanceof Error ? error.message : '';
        return { success: false, error: /^(Choose |Upscaled images |Model |Invalid model |Unexpected model |The processed image |Local image)/.test(message) ? message : 'Could not process the image locally. Check your connection for the first model download, then try again.' };
      } finally {
        if (folder) await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
        active = null;
      }
    },
  };
}
