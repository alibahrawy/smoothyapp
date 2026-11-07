import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const electronStub = `
export const app = { getVersion: () => '3.0.0-test', on() {}, getPath: () => '/tmp' };
export const ipcMain = { handle() {} };
export const clipboard = { writeText() {} };
export const dialog = {};
export const shell = { showItemInFolder() {} };
export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };
export class BrowserWindow {}
`;

const websocketStub = `
export const getShortsCutsCatalog = async () => ({ videoEffects: ['Gaussian Blur'], audioEffects: [], videoTransitions: [], audioTransitions: [] });
`;

const output = await build({
  entryPoints: [path.join(root, 'src/main/agent/agent-service.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['sharp'],
  plugins: [{
    name: 'agent-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'agent-stub' }));
      builder.onResolve({ filter: /^\.\/websocket-server$/ }, () => ({ path: 'websocket', namespace: 'agent-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'agent-stub' }, args => ({
        contents: args.path === 'electron' ? electronStub : websocketStub,
        loader: 'js'
      }));
    }
  }]
});

const module = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', output.outputFiles[0].text)(
  module,
  module.exports,
  require,
  path.join(root, 'src/main/agent'),
  path.join(root, 'src/main/agent/agent-service.ts')
);
const { AgentService } = module.exports;

const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-agent-test-'));
  const image = path.join(dir, 'frame.png');
  await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 40, g: 70, b: 130 } } }).png().toFile(image);
  const sequence = {
    hasSequence: true,
    name: 'Fixture sequence',
    id: 'seq-fixture',
    duration: 10,
    fps: 30,
    width: 640,
    height: 360,
    markerCount: 0,
    timelineRevision: 7,
    videoTracks: [{ index: 0, name: 'V1', clips: [{ name: 'frame', path: image, start: 0, end: 10, inPoint: 0, outPoint: 10, disabled: false }] }],
    audioTracks: []
  };
  return { dir, image, sequence };
}

test('audio setup is a job after the approval gate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-agent-audio-'));
  const state = { ready: false, busy: false, backend: 'cpu' };
  let setupCalls = 0;
  const audioService = {
    state: async () => ({ ...state }),
    setup: async progress => {
      setupCalls += 1;
      progress('Downloading audio runtime');
      await new Promise(resolve => setTimeout(resolve, 25));
      state.ready = true;
      return { ready: true, backend: 'cpu' };
    },
    cancel() {}
  };
  const store = {
    values: { 'agent.port': 4802, 'agent.enabled': true, 'agent.autoApprove': true },
    get(key, fallback) { return key in this.values ? this.values[key] : fallback; },
    set(key, value) { this.values[key] = value; }
  };
  const service = new AgentService({
    store,
    appVersion: '3.0.0-test',
    userData: dir,
    ffmpeg,
    ffprobe,
    getSequenceInfo: () => null,
    requestSequenceInfo: () => {},
    getActiveNLE: () => null,
    isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }),
    clearMarkers: async () => ({ success: false }),
    audioService,
    window: () => null
  });
  try {
    const started = await service.callTool('smoothy_audio', { action: 'setup' }, 'mcp');
    assert.equal(started.ok, true);
    assert.ok(started.data.jobId);
    const waited = await service.callTool('smoothy_jobs', { action: 'wait', id: started.data.jobId, timeoutMs: 5000 }, 'mcp');
    assert.equal(waited.data.job.status, 'done');
    assert.equal(waited.data.job.result.ready, true);
    assert.equal(setupCalls, 1);
    const again = await service.callTool('smoothy_audio', { action: 'setup' }, 'mcp');
    assert.equal(again.data.alreadyReady, true);
    assert.equal(setupCalls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('agent bridge status, MCP, project, media and review work over loopback', async () => {
  const { dir, image, sequence } = await fixture();
  const values = { 'agent.port': 4801, 'agent.enabled': true };
  const store = {
    get(key, fallback) { return key in values ? values[key] : fallback; },
    set(key, value) { values[key] = value; }
  };
  const markers = [];
  const tracked = [];
  const service = new AgentService({
    store,
    trackTool: id => tracked.push(id),
    appVersion: '3.0.0-test',
    userData: dir,
    ffmpeg,
    ffprobe,
    getSequenceInfo: () => sequence,
    requestSequenceInfo: () => {},
    getActiveNLE: () => 'premiere',
    isEditorConnected: () => true,
    addMarkers: async items => { markers.push(...items); return { success: true }; },
    clearMarkers: async () => ({ success: true }),
    audioService: null,
    window: () => null
  });
  try {
    await service.start();
    const state = service.state();
    assert.equal(state.running, true);
    assert.equal(state.enabled, true);
    const token = state.token;
    const base = `http://127.0.0.1:${state.port}`;

    const unauthorized = await fetch(`${base}/status`);
    assert.equal(unauthorized.status, 401);

    const health = await fetch(`${base}/health`).then(response => response.json());
    assert.equal(health.ok, true);

    const initialize = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    }).then(response => response.json());
    assert.equal(initialize.result.serverInfo.name, 'smoothyedit-agent');
    assert.equal(initialize.result.protocolVersion, '2025-06-18');

    const tools = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    }).then(response => response.json());
    assert.ok(tools.result.tools.some(tool => tool.name === 'smoothy_media'));
    assert.ok(tools.result.tools.some(tool => tool.name === 'smoothy_review'));

    const status = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'smoothy_status', arguments: {} } })
    }).then(response => response.json());
    assert.equal(status.result.isError, false);
    assert.equal(status.result.structuredContent.data.editor.sequence.name, 'Fixture sequence');

    const project = await service.callTool('smoothy_project', { action: 'inspect' }, 'mcp');
    assert.equal(project.ok, true);
    assert.equal(project.data.sequence.videoTracks[0].clips[0].ref, 'v0c0');

    const frame = await service.callTool('smoothy_media', { action: 'frame', time: 2, width: 320 }, 'mcp');
    assert.equal(frame.ok, true);
    assert.match(frame.imageDataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(frame.data.width, 320);

    // agent_session_start: status discovery adds none; the first working call
    // of a session counts once, later calls in that session add none.
    const sessions = () => tracked.filter(id => id === 'agent_session_start').length;
    assert.equal(sessions(), 1);
    const mcpCall = (session, name, args = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })
    }).then(response => response.json());
    assert.equal((await mcpCall('second', 'smoothy_status')).result.isError, false);
    assert.equal(sessions(), 1);
    assert.equal((await mcpCall('second', 'smoothy_nope')).result.isError, true);
    assert.equal(sessions(), 1);
    assert.equal((await mcpCall('second', 'smoothy_project', { action: 'inspect' })).result.isError, false);
    assert.equal((await mcpCall('second', 'smoothy_project', { action: 'inspect' })).result.isError, false);
    assert.equal(sessions(), 2);
    await service.callTool('smoothy_project', { action: 'inspect' }, 'ui');
    assert.equal(sessions(), 2);

    const preview = await service.callTool('smoothy_review', { action: 'preview', path: image, name: 'Headless cut', time: 1 }, 'mcp');
    assert.equal(preview.ok, true);
    assert.equal(preview.data.preview.name, 'Headless cut');
    assert.equal(preview.data.preview.width, 640);
    assert.equal(service.state().preview.path, await fs.realpath(image));
    const opened = await service.callTool('smoothy_review', { action: 'open', time: 2 }, 'mcp');
    assert.equal(opened.data.timecode, '00:00:02:00');

    // Agents cannot write notes or mark them fixed; the editor (ui) does.
    const refusedAdd = await service.callTool('smoothy_review', { action: 'add', time: 1, body: 'Agent note' }, 'mcp');
    assert.equal(refusedAdd.ok, false);
    assert.match(refusedAdd.error.message, /written by the editor/);

    const note = await service.callTool('smoothy_review', { action: 'add', time: 3.5, body: 'Cut this pause', capture: true }, 'ui');
    assert.equal(note.ok, true);
    assert.ok(note.data.thread.screenshot?.path);
    assert.ok(String(note.data.thread.screenshot.path).endsWith('.jpg'));
    assert.equal(note.data.thread.timecode, '00:00:03:15');
    assert.equal(note.data.thread.author, 'user');
    const list = await service.callTool('smoothy_review', { action: 'list' }, 'mcp');
    assert.equal(list.data.threads.length, 1);
    assert.equal(list.data.threads[0].body, 'Cut this pause');

    const reply = await service.callTool('smoothy_review', { action: 'reply', id: note.data.thread.id, body: 'Trimmed 0.4s' }, 'mcp');
    assert.equal(reply.ok, true);
    assert.equal(reply.data.thread.replies.at(-1).author, 'agent');
    const refusedResolve = await service.callTool('smoothy_review', { action: 'resolve', id: note.data.thread.id, resolved: true }, 'mcp');
    assert.equal(refusedResolve.ok, false);
    const resolved = await service.callTool('smoothy_review', { action: 'resolve', id: note.data.thread.id, resolved: true }, 'ui');
    assert.equal(resolved.data.thread.status, 'resolved');

    assert.equal(markers.length, 0);
    const probe = await service.callTool('smoothy_media', { action: 'probe', path: image }, 'mcp');
    assert.equal(probe.ok, true);
    assert.equal(probe.data.probe.video.width, 640);
  } finally {
    await service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('agent tools are refused for accounts without Pro, and work once Pro is active', async () => {
  const { dir } = await fixture();
  let pro = false;
  const store = { values: {}, get(key, fallback) { return key in this.values ? this.values[key] : fallback; }, set(key, value) { this.values[key] = value; } };
  const service = new AgentService({
    store,
    appVersion: '3.0.0-test',
    userData: dir,
    ffmpeg,
    ffprobe,
    getSequenceInfo: () => null,
    requestSequenceInfo: () => {},
    getActiveNLE: () => null,
    isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }),
    clearMarkers: async () => ({ success: false }),
    audioService: null,
    window: () => null,
    allowed: () => pro
  });
  try {
    assert.equal(service.state().locked, true);
    const blocked = await service.callTool('smoothy_status', {}, 'mcp');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'E_PRO_REQUIRED');
    assert.match(blocked.error.next, /pricing/);
    pro = true;
    assert.equal(service.state().locked, false);
    assert.equal((await service.callTool('smoothy_status', {}, 'mcp')).ok, true);
  } finally {
    await service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
