// Runs in a disposable Electron utility process. Cancel kills native inference too.
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import os from 'node:os';
import type { AssetOperation, AssetProgress } from './assets-models';

const send = (data: unknown) => (process as any).parentPort
  ? (process as any).parentPort.postMessage(data) : process.send?.(data as any);
const progress = (data: AssetProgress) => send({ type: 'progress', ...data });
const INPUT_LIMIT = 8192 * 8192;

export function reflectIndex(value: number, length: number) {
  if (length <= 1) return 0;
  const period = 2 * length - 2;
  const index = ((value % period) + period) % period;
  return index < length ? index : period - index;
}

export function rgbTensor(rgb: Uint8Array, width: number, height: number, normalized = false) {
  const size = width * height;
  const data = new Float32Array(size * 3);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) for (let i = 0; i < size; i++) {
    const value = rgb[i * 3 + c] / 255;
    data[c * size + i] = normalized ? (value - mean[c]) / std[c] : value;
  }
  return new ort.Tensor('float32', data, [1, 3, height, width]);
}

export async function processImage(job: { operation: AssetOperation; factor: number; model: string; input: string; output: string }) {
  const { data: source, info } = await sharp(job.input, { limitInputPixels: INPUT_LIMIT }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  progress({ message: job.operation === 'upscale' ? 'Loading Real-ESRGAN…' : 'Loading BiRefNet…' });
  const session = await ort.InferenceSession.create(job.model, {
    executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.min(8, os.cpus().length - 2)),
    interOpNumThreads: 1, graphOptimizationLevel: 'all',
    // Electron on Apple Silicon traps in ORT's large BFCArena allocations.
    // Direct allocations keep the full BiRefNet model working in the utility process.
    enableCpuMemArena: false, enableMemPattern: false,
  });
  try {
    if (job.operation === 'remove-background') {
      const rgb = await sharp(source, { raw: { width, height, channels: 4 } }).removeAlpha().resize(1024, 1024, { fit: 'fill' }).raw().toBuffer();
      progress({ message: 'Removing background on your device…' });
      const results = await session.run({ [session.inputNames[0]]: rgbTensor(rgb, 1024, 1024, true) });
      const tensor = results[session.outputNames[session.outputNames.length - 1]];
      const logits = tensor.data as Float32Array;
      if (logits.length !== 1024 * 1024) throw new Error('Unexpected mask dimensions.');
      const mask = Buffer.alloc(logits.length);
      for (let i = 0; i < mask.length; i++) mask[i] = Math.round(255 / (1 + Math.exp(-logits[i])));
      const alpha = await sharp(mask, { raw: { width: 1024, height: 1024, channels: 1 } }).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
      for (let i = 0; i < width * height; i++) source[i * 4 + 3] = Math.round(source[i * 4 + 3] * alpha[i] / 255);
      await sharp(source, { raw: { width, height, channels: 4 } }).png().toFile(job.output);
      return { width, height };
    }
    const scale = job.factor, outW = width * scale, outH = height * scale;
    if (![2, 4].includes(scale) || Math.max(outW, outH) > 8192 || outW * outH > 32 * 1024 * 1024) throw new Error('Upscaled images must fit 8192 pixels per side and 32 megapixels. Choose 2× or a smaller source.');
    const output = Buffer.alloc(outW * outH * 3);
    // The official Qualcomm export uses 128px tiles; 16px reflected overlap
    // avoids tile seams and limits memory independently of the source dimensions.
    const tile = 128, border = 16, core = tile - 2 * border;
    const total = Math.ceil(width / core) * Math.ceil(height / core);
    let completed = 0;
    for (let y = 0; y < height; y += core) for (let x = 0; x < width; x += core) {
      const input = Buffer.alloc(tile * tile * 3);
      for (let ty = 0; ty < tile; ty++) for (let tx = 0; tx < tile; tx++) {
        const from = (reflectIndex(y + ty - border, height) * width + reflectIndex(x + tx - border, width)) * 4;
        const to = (ty * tile + tx) * 3;
        input[to] = source[from]; input[to + 1] = source[from + 1]; input[to + 2] = source[from + 2];
      }
      const result = await session.run({ [session.inputNames[0]]: rgbTensor(input, tile, tile) });
      const floats = result[session.outputNames[0]].data as Float32Array;
      if (floats.length !== 512 * 512 * 3) throw new Error('Unexpected upscale dimensions.');
      const rgb = Buffer.alloc(floats.length);
      for (let c = 0; c < 3; c++) for (let i = 0; i < 512 * 512; i++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(floats[c * 512 * 512 + i] * 255)));
      const scaled = scale === 4 ? rgb : await sharp(rgb, { raw: { width: 512, height: 512, channels: 3 } }).resize(256, 256).raw().toBuffer();
      const span = tile * scale, pad = border * scale;
      const rows = Math.min(core, height - y) * scale, cols = Math.min(core, width - x) * scale;
      for (let row = 0; row < rows; row++) {
        const start = ((row + pad) * span + pad) * 3;
        scaled.copy(output, ((y * scale + row) * outW + x * scale) * 3, start, start + cols * 3);
      }
      progress({ message: `Upscaling on your device · ${++completed} of ${total} tiles`, percent: completed / total * 100 });
    }
    // Keep an existing cutout transparent. RGB restoration must never flatten alpha.
    const alphaSource = Buffer.alloc(width * height);
    for (let i = 0; i < alphaSource.length; i++) alphaSource[i] = source[i * 4 + 3];
    const alpha = await sharp(alphaSource, { raw: { width, height, channels: 1 } }).resize(outW, outH, { fit: 'fill' }).greyscale().raw().toBuffer();
    await sharp(output, { raw: { width: outW, height: outH, channels: 3 } }).joinChannel(alpha, { raw: { width: outW, height: outH, channels: 1 } }).png().toFile(job.output);
    return { width: outW, height: outH };
  } finally { await session.release(); }
}

const run = async (job: any) => {
  try { send({ type: 'done', ...await processImage(job) }); }
  catch (error) { send({ type: 'error', error: error instanceof Error && error.message.startsWith('Upscaled images') ? error.message : 'Local image processing failed. Try a smaller image or download the model again.' }); }
};
if ((process as any).parentPort) (process as any).parentPort.once('message', (event: any) => void run(event.data));
else if (process.send) process.once('message', run);
