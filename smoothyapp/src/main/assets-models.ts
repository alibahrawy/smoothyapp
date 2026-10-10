// Public weights only. No image, user data or credentials are sent to these hosts.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

export const ASSET_MODELS = {
  'remove-background': {
    id: 'birefnet-general-v1', name: 'BiRefNet',
    url: 'https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx',
    size: 972666916, sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c',
    files: [{ name: 'model.onnx', size: 972666916, sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c' }],
  },
  upscale: {
    id: 'realesrgan-x4plus-v0.63.0', name: 'Real-ESRGAN',
    url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/real_esrgan_x4plus/releases/v0.63.0/real_esrgan_x4plus-onnx-float.zip',
    size: 62174027, sha256: 'ba463a04c206eb8576dbd65093144a5302deff8331e25920ec95f71e3163c43f',
    files: [
      { name: 'real_esrgan_x4plus.onnx', size: 3158313, sha256: '0c40d89889e621d4f1a9a0a6d728e4ccd612a67a90927ca8b394eb0917329ed9' },
      { name: 'real_esrgan_x4plus.data', size: 66737664, sha256: '28fada125730d3c87d504d48dd8332837f65811ec431a570ea4919ba3eee3287' },
    ],
  },
} as const;
export type AssetOperation = keyof typeof ASSET_MODELS;
export type AssetProgress = { message: string; percent?: number };

export async function fileHash(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function ensureAssetModel(operation: AssetOperation, root: string, signal: AbortSignal,
  progress: (data: AssetProgress) => void, fetchModel: typeof fetch = fetch): Promise<string> {
  const model = ASSET_MODELS[operation];
  const folder = path.join(root, model.id);
  const modelPath = path.join(folder, model.files[0].name);
  progress({ message: `Checking ${model.name}…` });
  try {
    for (const file of model.files) {
      signal.throwIfAborted();
      const local = path.join(folder, file.name);
      if ((await fs.stat(local)).size !== file.size || await fileHash(local, signal) !== file.sha256) throw new Error('Model needs download');
    }
    return modelPath;
  } catch (error) { signal.throwIfAborted(); }
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, model.id + '-download-'));
  const archive = path.join(staging, 'download.part');
  try {
    progress({ message: `Downloading ${model.name} once (${Math.ceil(model.size / 1048576)} MB)…`, percent: 0 });
    const response = await fetchModel(model.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
    if (!response.ok || !response.body) throw new Error('Model download failed. Check your connection and try again.');
    const handle = await fs.open(archive, 'wx');
    const hash = createHash('sha256');
    let received = 0, lastProgress = 0;
    try {
      for await (const chunk of response.body as any) {
        signal.throwIfAborted();
        received += chunk.length;
        if (received > model.size) throw new Error('Unexpected model download size.');
        hash.update(chunk);
        await handle.writeFile(chunk);
        if (Date.now() - lastProgress > 200) {
          lastProgress = Date.now();
          progress({ message: `Downloading ${model.name} · ${Math.floor(received / model.size * 100)}%`, percent: received / model.size * 100 });
        }
      }
    } finally { await handle.close(); }
    signal.throwIfAborted();
    if (received !== model.size || hash.digest('hex') !== model.sha256) throw new Error('Model verification failed. Try downloading again.');
    progress({ message: `Preparing ${model.name}…` });
    if (operation === 'upscale') {
      const zip = new AdmZip(archive);
      for (const file of model.files) {
        const entry = zip.getEntry('real_esrgan_x4plus-onnx-float/' + file.name);
        if (!entry || entry.header.size !== file.size) throw new Error('Invalid model archive.');
        const output = path.join(staging, file.name);
        await fs.writeFile(output, entry.getData());
        if (await fileHash(output, signal) !== file.sha256) throw new Error('Model verification failed.');
      }
      await fs.unlink(archive);
    } else {
      await fs.rename(archive, path.join(staging, model.files[0].name));
    }
    signal.throwIfAborted();
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rename(staging, folder);
    return modelPath;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
