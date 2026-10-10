// Real local Whisper binary/models through the current service, isolated cache;
// generated Arabic speech only. Never reports telemetry or spends credits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { build } = require('esbuild');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-caption-engine-'));
const root = path.resolve(__dirname, '..'), review = process.env.SMOOTHY_REVIEW_DIR;
globalThis.__captionNativeProfile = profile;
fs.mkdirSync(path.join(profile, 'whisper-models')); fs.mkdirSync(path.join(profile, 'whisper-bin'));
for (const variant of ['cpu', 'metal']) fs.symlinkSync(path.join(os.homedir(), 'Library/Application Support/smoothyedit/whisper-bin', variant), path.join(profile, 'whisper-bin', variant));
fs.symlinkSync(path.join(os.homedir(), 'Library/Application Support/smoothyedit/whisper-models/ggml-base.bin'), path.join(profile, 'whisper-models/ggml-base.bin'));
fs.symlinkSync('/tmp/smoothy-caption-ggml-large-v3-turbo.bin', path.join(profile, 'whisper-models/ggml-large-v3-turbo.bin'));
const bundle = path.join(profile, 'service.cjs');
async function prepare() { await build({ entryPoints: [path.join(root, 'src/main/captions/whisper-service.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  plugins: [{ name: 'cache-only', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'cache-only' }));
    builder.onLoad({ filter: /.*/, namespace: 'cache-only' }, () => ({ contents: 'export const app={getPath:()=>globalThis.__captionNativeProfile};' }));
  } }] }); return require(bundle); }
const spoken = 'السلام عليكم أعزائي المشاهدين أهلا بكم في فيديو جديد هنا على قناة من غير مونتاج. الواحد حاسس بإحساس حبتين من ساعة لما السنة بدأت. الأفلام دي بتديني شعور بالدفا.';
const words = text => text.normalize('NFKC').replace(/[\u064b-\u065f\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/);
function distance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < right.length; j++) row[j + 1] = Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (left[i] === right[j] ? 0 : 1));
    previous = row;
  }
  return previous[right.length];
}
(async () => {
  const api = await prepare();
  if (process.env.SMOOTHY_TEST_AUDIO) {
    await api.loadModel('ggml-large-v3-turbo.bin');
    const result = await api.transcribe(process.env.SMOOTHY_TEST_AUDIO, progress => console.log(progress.status), undefined, 'ar');
    const formatterBundle = path.join(profile, 'formatter.cjs');
    await build({ entryPoints: [path.join(root, 'src/main/captions/caption-formatter.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: formatterBundle });
    const { formatCaptions, toSRT, toVTT } = require(formatterBundle);
    const captions = formatCaptions(result, { maxCharsPerLine: 42, maxLines: 1, maxDurationSeconds: 7 });
    assert.ok(captions.length > 0);
    assert.ok(captions.every((cue, index) => cue.endTime > cue.startTime && (!index || cue.startTime >= captions[index - 1].endTime)));
    fs.writeFileSync(path.join(review, 'captions-arabic-turbo.srt'), toSRT(captions));
    fs.writeFileSync(path.join(review, 'captions-arabic-turbo.vtt'), toVTT(captions));
    fs.writeFileSync(path.join(review, 'owner-turbo-transcription.json'), JSON.stringify(result));
    console.log(JSON.stringify({ ownerAudio: true, language: result.language, words: result.chunks.length, captions: captions.length, endSeconds: captions.at(-1).endTime, telemetry: 'none' }));
    return;
  }
  const samples = [];
  const before = JSON.parse(fs.readFileSync('/tmp/smoothy-caption-before.json', 'utf8'));
  samples.push({ model: 'Base, previous token splitting', text: before.transcription.map(s => s.text.trim()).join(' ') });
  for (const model of ['ggml-base.bin', 'ggml-large-v3-turbo.bin']) {
    await api.loadModel(model);
    const result = await api.transcribe('/tmp/smoothy-caption-arabic.wav', undefined, model, 'ar');
    assert.equal(result.language, 'ar'); assert.ok(result.chunks.length > 0);
    assert.ok(result.chunks.some(chunk => chunk.text === 'جديد'));
    assert.ok(!result.text.includes('ج ديد')); assert.ok(!result.text.includes('\uFFFD'));
    assert.ok(result.chunks.every((chunk, index) => chunk.timestamp[1] > chunk.timestamp[0] && (!index || chunk.timestamp[0] >= result.chunks[index - 1].timestamp[1])));
    samples.push({ model, text: result.text });
  }
  const controller = new AbortController();
  const canceled = api.transcribe('/tmp/smoothy-caption-arabic.wav', undefined, undefined, 'ar', controller.signal); controller.abort();
  await assert.rejects(canceled, /TRANSCRIPTION_CANCELLED/); assert.equal(api.isTranscribing(), false);
  await assert.rejects(api.transcribe(path.join(profile, 'missing.wav')), /exited/); assert.equal(api.isTranscribing(), false);
  const reference = words(spoken);
  for (const sample of samples) { sample.wordEdits = distance(reference, words(sample.text)); sample.referenceWords = reference.length; }
  const report = { source: 'macOS Majed synthetic Arabic speech, 18.89 seconds; NOT the owner recording or a dialect benchmark', spoken, samples, cancellation: 'passed', failure: 'passed', telemetry: 'none' };
  if (review) fs.writeFileSync(path.join(review, 'native-comparison.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(profile, { recursive: true, force: true }));
