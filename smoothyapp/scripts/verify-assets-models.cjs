// Actual ONNX/native utility-process checks. Supply ASSETS_MODEL_FIXTURE directory.
const { app, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-assets-native-'));
app.setPath('userData', path.join(scratch, 'profile'));
const models = process.env.ASSETS_MODEL_FIXTURE;
const worker = process.env.ASSETS_WORKER_FILE || path.join(root, 'out/main/assets-worker.js');
const proof = process.env.ASSETS_REVIEW_DIR || path.resolve(root, '../docs/reviews/smoothyapp-v2-assets-local');
fs.mkdirSync(proof, { recursive: true });
const run = (job, cancel = false) => new Promise((resolve, reject) => {
  const child = utilityProcess.fork(worker, [], { stdio: 'pipe' });
  const started = Date.now(); let sent = false, log = '';
  child.stderr?.on('data', data => { log += data; });
  child.stdout?.on('data', data => { log += data; });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Model timeout: ' + log.slice(-1000))); }, 5 * 60 * 1000);
  child.on('spawn', () => child.postMessage(job));
  child.on('message', message => {
    if (message.type === 'progress') console.log(message.message);
    if (message.type === 'progress' && cancel && /Removing|Upscaling/.test(message.message)) {
      sent = true; clearTimeout(timer); child.kill(); resolve({ canceled: true });
    } else if (message.type === 'done' || message.type === 'error') {
      sent = true; clearTimeout(timer); child.kill();
      message.type === 'error' ? reject(new Error(message.error + ': ' + log.slice(-1000))) : resolve({ ...message, elapsedMs: Date.now() - started });
    }
  });
  child.on('exit', code => { clearTimeout(timer); if (!sent) reject(new Error('Worker exit ' + code + ': ' + log.slice(-1000))); });
});
app.whenReady().then(async () => {
  try {
    assert.ok(models, 'Set ASSETS_MODEL_FIXTURE');
    const sample = path.join(scratch, 'sample.png');
    await sharp(path.join(models, 'sample.jpg')).resize({ width: 192 }).png().toFile(sample);
    const meta = await sharp(sample).metadata();
    const details = [];
    for (const factor of [2, 4]) {
      const output = path.join(proof, 'native-upscale-' + factor + 'x.png');
      const result = await run({ operation: 'upscale', factor, model: path.join(models, 'real_esrgan_x4plus-onnx-float/real_esrgan_x4plus.onnx'), input: sample, output });
      const png = await sharp(output).metadata();
      assert.equal(png.width, meta.width * factor); assert.equal(png.height, meta.height * factor); assert.equal(png.hasAlpha, true);
      details.push({ operation: 'upscale', factor, ...result });
    }
    const cutout = path.join(proof, 'native-cutout.png');
    const result = await run({ operation: 'remove-background', factor: 1, model: path.join(models, 'birefnet.onnx'), input: sample, output: cutout });
    const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0, transparent = 0, soft = 0;
    for (let i = 3; i < data.length; i += 4) { if (data[i] > 250) opaque++; else if (data[i] < 5) transparent++; else soft++; }
    assert.equal(info.width, meta.width); assert.equal(info.height, meta.height); assert.ok(opaque > 0 && transparent > 0, 'Cutout has foreground and background');
    details.push({ operation: 'remove-background', ...result, opaque, transparent, soft });
    const transparentUpscale = path.join(proof, 'native-cutout-2x.png');
    await run({ operation: 'upscale', factor: 2, model: path.join(models, 'real_esrgan_x4plus-onnx-float/real_esrgan_x4plus.onnx'), input: cutout, output: transparentUpscale });
    const stats = await sharp(transparentUpscale).stats();
    assert.equal(stats.channels[3].min, 0); assert.equal(stats.channels[3].max, 255);
    const canceled = path.join(scratch, 'canceled.png');
    assert.equal((await run({ operation: 'remove-background', factor: 1, model: path.join(models, 'birefnet.onnx'), input: sample, output: canceled }, true)).canceled, true);
    assert.equal(fs.existsSync(canceled), false);
    fs.copyFileSync(sample, path.join(proof, 'native-source.png'));
    fs.writeFileSync(path.join(proof, 'native-model-results.json'), JSON.stringify(details, null, 2));
    console.log('Native cutout, 2×/4× upscale, transparent upscale and cancel passed:', JSON.stringify(details));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); app.quit(); }
});
