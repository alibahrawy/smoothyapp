import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

async function load(entry) {
  const output = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['sharp'],
    plugins: [{
      name: 'stubs',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        builder.onResolve({ filter: /^\.\.\/websocket-server$/ }, () => ({ path: 'websocket', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: args.path === 'electron'
            ? `export const app={getVersion:()=>'t',on(){},getPath:()=>'/tmp'};export const ipcMain={handle(){}};export const clipboard={writeText(){}};export const dialog={};export const shell={};export const protocol={registerSchemesAsPrivileged(){},handle(){}};export class BrowserWindow{}`
            : `export const getShortsCutsCatalog=async()=>({videoEffects:[],audioEffects:[],videoTransitions:[],audioTransitions:[]});`,
          loader: 'js'
        }));
      }
    }]
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', output.outputFiles[0].text)(module, module.exports, require, path.join(root, path.dirname(entry)), path.join(root, entry));
  return module.exports;
}

const engine = await load('src/main/agent/engine.ts');
const results = await load('src/main/agent/results.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');

const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('engine guard refuses network, plugins and reads outside the roots', async () => {
  const base = await tempDir('smoothy-guard-');
  const readRoots = [base];
  const writeRoots = [path.join(base, 'work')];
  await fs.mkdir(writeRoots[0], { recursive: true });
  const ctx = { cwd: writeRoots[0], home: base, readRoots, writeRoots, readText: file => fs.readFile(file, 'utf8') };
  const denied = async (tool, args, pattern) => {
    await assert.rejects(engine.guardArgs(tool, args, ctx), error => error instanceof engine.EngineGuardError && pattern.test(error.message), JSON.stringify(args));
  };
  try {
    await denied('ffmpeg', ['-i', 'https://example.com/a.mp4', 'out.wav'], /network/);
    await denied('ffmpeg', ['-i', 'concat:a.wav|b.wav', 'out.wav'], /concat: protocol/);
    await denied('ffmpeg', ['-f', 'lavfi', '-i', 'movie=/etc/passwd', 'out.mp4'], /outside the folders/);
    await denied('ffmpeg', ['-i', 'in.wav', '-af', 'ladspa=f=amp', 'out.wav'], /ladspa/);
    await denied('ffmpeg', ['-i', '/etc/hosts', 'out.wav'], /outside the folders/);
    await denied('ffprobe', ['-i', 'tcp://127.0.0.1:9/x'], /network/);
    await denied('whisper', ['-m', path.join(base, 'm.bin'), '-f', path.join(base, 'a.wav'), '-oj'], /-of/);

    const list = path.join(writeRoots[0], 'list.txt');
    await fs.writeFile(list, "file '/etc/hosts'\n");
    await denied('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', 'joined.wav'], /outside the folders/);

    const ok = await engine.guardArgs('ffmpeg', [
      '-i', path.join(base, 'in.mp4'),
      '-r', '30000/1001',
      '-metadata', 'comment=/not/a/path',
      '-af', 'asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms/rms10ms.txt',
      '-vf', `subtitles=${path.join(base, 'captions.srt')}`,
      'out.wav'
    ], ctx);
    const byRole = role => ok.paths.filter(item => item.role === role).map(item => path.basename(item.path)).sort();
    assert.deepEqual(byRole('read'), ['captions.srt', 'in.mp4']);
    assert.deepEqual(byRole('write'), ['out.wav', 'rms10ms.txt']);
    assert.deepEqual(ok.needsWrite, []);

    const outside = await engine.guardArgs('ffmpeg', ['-i', 'in.wav', path.join(base, 'elsewhere', 'out.wav')], ctx);
    assert.deepEqual(outside.needsWrite, [path.join(base, 'elsewhere')]);

    const whisper = await engine.guardArgs('whisper', ['-m', path.join(base, 'ggml-small.en.bin'), '-f', path.join(base, 'a.wav'), '-nfa', '-dtw', 'small.en', '-ojf', '-of', 'transcript/dtw', '--prompt', 'Um, uh. Visit smoothyedit.com/tools.'], ctx);
    assert.deepEqual(whisper.paths.map(item => `${item.role}:${path.basename(item.path)}`).sort(), ['read:a.wav', 'read:ggml-small.en.bin', 'write:dtw']);

    assert.deepEqual(engine.finalArgs('ffmpeg', ['-i', 'a']).slice(0, 2).sort(), ['-hide_banner', '-nostdin']);
    assert.equal(engine.dtwPreset('/m/ggml-small.en.bin'), 'small.en');
    assert.equal(engine.dtwPreset('/m/ggml-large-v3-turbo.bin'), 'large.v3.turbo');
    assert.equal(engine.dtwPreset('/m/ggml-medium.bin'), 'medium');
    assert.equal(engine.expectedSeconds(['-ss', '5', '-t', '00:01:30', '-i', 'x']), 90);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('large results are compacted into a preview plus a file', async () => {
  const dir = await tempDir('smoothy-compact-');
  try {
    const big = { action: 'x', words: Array.from({ length: 4000 }, (_, i) => ({ w: `word${i}`, a: i / 10, b: i / 10 + 0.08 })) };
    const small = await results.compactData({ a: 1 }, { limit: 16384, dir, name: 'small' });
    assert.equal(small.truncated, false);
    const compact = await results.compactData(big, { limit: 16384, dir, name: 'smoothy_engine' });
    assert.equal(compact.truncated, true);
    assert.ok(JSON.stringify(compact.data).length < 16384);
    assert.equal(compact.data.action, 'x');
    const full = JSON.parse(await fs.readFile(compact.data.resultFile, 'utf8'));
    assert.equal(full.words.length, 4000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeService(userData, options = {}) {
  const events = [];
  const tracked = [];
  const store = {
    values: { 'agent.port': 4830, 'agent.enabled': true, ...(options.store || {}) },
    get(key, fallback) { return key in this.values ? this.values[key] : fallback; },
    set(key, value) { this.values[key] = value; }
  };
  const service = new AgentService({
    store,
    appVersion: '3.1.0-test',
    userData,
    ffmpeg,
    ffprobe,
    getSequenceInfo: () => null,
    requestSequenceInfo: () => {},
    getActiveNLE: () => null,
    isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }),
    clearMarkers: async () => ({ success: false }),
    window: () => ({ isDestroyed: () => false, webContents: { send: (_channel, payload) => { events.push(payload); options.onEvent?.(payload, service); } } }),
    trackTool: id => tracked.push(id),
    tempWritable: options.tempWritable,
    engines: { whisper: () => ({ path: null, modelsDir: path.join(userData, 'models'), models: [] }), sfxDir: options.sfxDir || null }
  });
  return { service, events, tracked };
}

test('smoothy_engine runs bundled ffmpeg/ffprobe with jobs, ETA, cache and help topics', async () => {
  const userData = await tempDir('smoothy-engine-');
  const { service, tracked } = makeService(userData);
  try {
    const status = await service.callTool('smoothy_status', {}, 'mcp');
    assert.equal(status.ok, true);
    assert.match(status.data.engines.ffmpeg.version, /ffmpeg version/);
    assert.equal(status.data.engines.ffmpeg.filters.loudnorm, true);
    assert.equal(status.data.engines.ffmpeg.encoders.libx264, true);
    assert.equal(status.data.engines.whisper.installed, false);
    assert.ok(status.data.help.includes('gotchas'));

    const topic = await service.callTool('smoothy_help', { topic: 'gotchas' }, 'mcp');
    assert.match(topic.data.markdown, /−0\.15 s/);
    const unknown = await service.callTool('smoothy_help', { topic: 'nope' }, 'mcp');
    assert.equal(unknown.error.code, 'E_NOT_FOUND');

    const made = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', 'tone.wav'] }, 'mcp');
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(made.data.exitCode, 0);
    assert.equal(made.data.outputs.length, 1);
    const tone = made.data.outputs[0].path;
    assert.ok((await fs.stat(tone)).size > 1000);
    assert.ok(made.data.log);

    const probe = await service.callTool('smoothy_engine', { tool: 'ffprobe', args: ['-v', 'error', '-show_format', '-of', 'json', tone], cache: true }, 'mcp');
    assert.equal(probe.data.exitCode, 0);
    assert.equal(JSON.parse(probe.data.stdout).format.format_name, 'wav');
    const again = await service.callTool('smoothy_engine', { tool: 'ffprobe', args: ['-v', 'error', '-show_format', '-of', 'json', tone], cache: true }, 'mcp');
    assert.equal(again.data.cached, true);

    const exists = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=duration=1', 'tone.wav'] }, 'mcp');
    assert.notEqual(exists.data.exitCode, 0, 'ffmpeg must not overwrite without -y');
    assert.equal(exists.data.ok, false);

    const network = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-i', 'http://127.0.0.1:1/x.mp4', 'x.wav'] }, 'mcp');
    assert.equal(network.error.code, 'E_PATH_DENIED');

    const long = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-re', '-f', 'lavfi', '-i', 'sine=duration=30', '-f', 'null', '-'], expectedSeconds: 30, waitMs: 2500 }, 'mcp');
    assert.equal(long.data.status, 'running');
    assert.ok(long.data.progress > 0, JSON.stringify(long.data));
    assert.equal(typeof long.data.etaSeconds, 'number');
    const canceled = await service.callTool('smoothy_jobs', { action: 'cancel', id: long.data.jobId }, 'mcp');
    assert.ok(canceled.ok);
    const waited = await service.callTool('smoothy_jobs', { action: 'wait', id: long.data.jobId, timeoutMs: 5000 }, 'mcp');
    assert.equal(waited.data.job.status, 'canceled');
    assert.equal(typeof waited.data.job.elapsedSeconds, 'number');

    const stdoutBig = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-i', tone, '-af', 'astats=metadata=1:reset=1,ametadata=print:file=-', '-f', 'null', '-'] }, 'mcp');
    assert.equal(stdoutBig.data.exitCode, 0);
    assert.ok(stdoutBig.data.stdoutFile, 'big stdout goes to a file');
    assert.ok(JSON.stringify(stdoutBig.data).length < 16384);

    assert.ok(tracked.filter(id => id === 'agent_engine_run').length >= 5);
  } finally {
    await service.stop();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('writes outside writable roots need approval, and a session grant covers later runs', async () => {
  const userData = await tempDir('smoothy-grant-');
  const outside = path.join(userData, 'Videos', '02 Topic');
  await fs.mkdir(outside, { recursive: true });
  const decisions = [];
  const { service } = makeService(userData, {
    tempWritable: false,
    onEvent: (payload, svc) => {
      if (payload.type !== 'approval') return;
      const next = decisions.shift() || 'deny';
      setTimeout(() => svc.decideApproval(payload.data.id, next !== 'deny', next === 'session'), 5);
    }
  });
  try {
    const target = path.join(outside, 'tone.wav');
    decisions.push('deny');
    const denied = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=duration=0.2', target] }, 'mcp');
    assert.equal(denied.error.code, 'E_APPROVAL_TIMEOUT');

    decisions.push('session');
    const allowed = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=duration=0.2', target] }, 'mcp');
    assert.equal(allowed.data.exitCode, 0, JSON.stringify(allowed));
    assert.deepEqual(service.state().grants.folders, [outside]);

    const later = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=duration=0.2', path.join(outside, 'tone2.wav')] }, 'mcp');
    assert.equal(later.data.exitCode, 0, 'no second approval needed');

    service.revokeGrants();
    assert.deepEqual(service.state().grants.folders, []);

    decisions.push('once');
    const project = await service.callTool('smoothy_edit', { action: 'new', name: 'Video 02', folder: path.join(userData, 'Videos', '03 Next') }, 'mcp');
    assert.equal(project.ok, true, JSON.stringify(project));
    for (const name of ['Edit', 'Media', 'Graphics', 'Work']) assert.ok((await fs.stat(path.join(userData, 'Videos', '03 Next', name))).isDirectory());

    // The open project's folder is writable, and engine runs default to its Work folder.
    const inProject = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=duration=0.2', 'tone.wav'] }, 'mcp');
    assert.equal(inProject.data.exitCode, 0);
    assert.equal(inProject.data.outputs[0].path, path.join(userData, 'Videos', '03 Next', 'Work', 'tone.wav'));
  } finally {
    await service.stop();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('headless edit versions: snapshot, list and restore without overwriting', async () => {
  const userData = await tempDir('smoothy-versions-');
  const { service, tracked } = makeService(userData);
  try {
    const folder = path.join(userData, 'Project');
    const created = await service.callTool('smoothy_edit', { action: 'new', name: 'Versions', folder }, 'mcp');
    assert.equal(created.ok, true);
    const tone = await service.callTool('smoothy_engine', { tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=duration=2', 'Media/tone.wav'], cwd: folder }, 'mcp');
    assert.equal(tone.data.exitCode, 0, JSON.stringify(tone));
    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [path.join(folder, 'Media', 'tone.wav')] }, 'mcp');
    const asset = imported.data.assets[0].id;
    await service.callTool('smoothy_edit', { action: 'ops', ops: [{ op: 'add', asset, at: 0 }] }, 'mcp');
    const v1 = await service.callTool('smoothy_edit', { action: 'snapshot', label: 'first cut' }, 'mcp');
    assert.equal(v1.data.name, 'v1');
    assert.ok(v1.data.file.startsWith(path.join(folder, 'Edit', 'versions')));
    await service.callTool('smoothy_edit', { action: 'ops', ops: [{ op: 'cut', from: 0.5, to: 1.5 }] }, 'mcp');
    const v2 = await service.callTool('smoothy_edit', { action: 'snapshot' }, 'mcp');
    assert.equal(v2.data.version, 2);
    const listed = await service.callTool('smoothy_edit', { action: 'versions' }, 'mcp');
    assert.deepEqual(listed.data.versions.map(row => row.label), ['first cut', '']);
    const restored = await service.callTool('smoothy_edit', { action: 'restore', version: 'v1' }, 'mcp');
    assert.equal(restored.ok, true);
    assert.equal(Math.round(restored.data.duration), 2);
    const undone = await service.callTool('smoothy_edit', { action: 'undo' }, 'mcp');
    assert.equal(Math.round(undone.data.duration), 1);
    assert.ok(tracked.includes('agent_edit_snapshot') && tracked.includes('agent_edit_restore'));
  } finally {
    await service.stop();
    await fs.rm(userData, { recursive: true, force: true });
  }
});
