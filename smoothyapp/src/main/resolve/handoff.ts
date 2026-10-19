import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { snapshotLua, snapshotToXml, SNAPSHOT_LIMIT } from './snapshot';

const SIGNATURE = '-- SmoothyEdit Send to Smoothy';
export interface ResolveHandoffStatus { installed: boolean; watching: boolean; error: string; received: boolean; menu: string; scriptPath: string; phase?: string }
export function luaString(value: string): string {
  let delimiter = '';
  while (value.includes(`]${delimiter}]`)) delimiter += '=';
  return `[${delimiter}[${value}]${delimiter}]`;
}

/** Uses the in-app Resolve export API; no Lua io/require/socket/process access. */
export function sendToSmoothyScript(destination: string) {
  return `${SIGNATURE} v4
-- Open SmoothyApp before choosing Workspace > Scripts > Send to Smoothy.
-- Exports the current timeline only; does not edit or save the Resolve project.
local destination = ${luaString(destination.replace(/\\/g, '/'))}
local function attempt(fn)
  local ok, value = pcall(fn)
  if ok then return value end
end
local host = resolve
local manager = attempt(function() return host:GetProjectManager() end)
if not manager then
  host = attempt(function() return Resolve() end)
  manager = attempt(function() return host:GetProjectManager() end)
end
if not manager then
  host = attempt(function() return (fusion or fu):GetResolve() end)
  manager = attempt(function() return host:GetProjectManager() end)
end
local preferences = fusion or fu or attempt(function() return host:Fusion() end) or attempt(function() return Fusion() end)
local previous = attempt(function() return preferences:GetPrefs("Global.SmoothyEditHandoffV2") end)
local serial = (tonumber(type(previous) == "string" and previous:match("^2|(%d+)|") or nil) or 0) + 1
local function report(phase, code)
  attempt(function()
    preferences:SetPrefs("Global.SmoothyEditHandoffV2", "2|" .. serial .. "|" .. phase .. "|" .. code)
    return preferences:SavePrefs()
  end)
  if print then print("[Smoothy] " .. phase .. ": " .. code) end
end
report("started", "ok")
${snapshotLua}
local ok, failure = pcall(function()
  if not manager then report("failed", "noResolve"); return end
  local project = manager:GetCurrentProject()
  if not project then report("failed", "noProject"); return end
  local timeline = project:GetCurrentTimeline()
  if not timeline then report("failed", "noTimeline"); return end
  report("exporting", "ok")
  -- Resolve's own examples use slash-separated paths. Try both documented
  -- argument forms; XML ignores the subtype, but some native bindings need it.
  local exportOK, exported = pcall(function() return timeline:Export(destination, host.EXPORT_FCP_7_XML) end)
  if (not exportOK or not exported) and host.EXPORT_NONE ~= nil then
    exportOK, exported = pcall(function() return timeline:Export(destination, host.EXPORT_FCP_7_XML, host.EXPORT_NONE) end)
  end
  if not exportOK or not exported then
    if print then print("[Smoothy] Native XML export refused; reading a source-only timeline snapshot.") end
    report("reading", "ok")
    local captured, problem = pcall(function() captureTimeline(timeline) end)
    if not captured then
      report("failed", "snapshotFailed")
      if print then print("[Smoothy] " .. tostring(problem)) end
      return
    end
    report("snapshot", "ok")
    return
  end
  report("exported", "ok")
end)
if not ok then
  report("failed", "runtimeError")
  if print then print("[Smoothy] " .. tostring(failure)) end
end
`;
}

export function readHandoffReceipt(profiles: string): { value: string; phase: string; code: string; file: string } | null {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(profiles, { withFileTypes: true }); } catch { return null; }
  let newest: { time: number; value: string; phase: string; code: string; file: string } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const file = path.join(profiles, entry.name, 'Fusion.prefs');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
      // Read only our fixed ASCII receipt. Never evaluate or expose the prefs file.
      const matches = [...fs.readFileSync(file, 'utf8').matchAll(/\bSmoothyEditHandoffV2\s*=\s*"(2\|\d+\|(started|exporting|exported|failed|reading|snapshot)\|([A-Za-z]+))"/g)];
      const match = matches.at(-1);
      if (match && (!newest || stat.mtimeMs > newest.time)) newest = { time: stat.mtimeMs, value: match[1], phase: match[2], code: match[3], file };
    } catch {}
  }
  return newest;
}

export function readSnapshotPacket(file: string, serial: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid Resolve handoff preferences.');
  const match = /\bSmoothyEditSnapshotV1\s*=\s*"(\d+)\|([0-9a-f]+)"/.exec(fs.readFileSync(file, 'utf8'));
  if (!match || match[1] !== serial || match[2].length % 2 || match[2].length > SNAPSHOT_LIMIT * 2) throw new Error('Resolve did not provide a complete matching timeline snapshot. Send it again.');
  const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match[2], 'hex'));
  return JSON.parse(json);
}

const RECEIPT_ERRORS: Record<string, string> = {
  noResolve: 'The script ran, but Resolve did not provide its internal API on this build.',
  noProject: 'The script ran, but no Resolve project is open.',
  noTimeline: 'The script ran, but no timeline is open in Resolve. Open the synced timeline and send again.',
  noExportAPI: 'The script ran, but this Resolve build does not expose the XML-export API.',
  exportRejected: 'Resolve rejected the XML export. Use File → Export → Timeline → Final Cut Pro 7 XML as the fallback.',
  snapshotFailed: 'Resolve refused XML export and could not read a source timeline snapshot. Check the [Smoothy] error in its Lua Console, or use manual XML handoff.',
  runtimeError: 'The script encountered a Resolve API error. Open Workspace → Console → Lua to read the [Smoothy] error.'
};

export function resolveScriptDirectory(platform: string, appData: string, home: string) {
  if (platform === 'win32') return path.join(appData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility');
  if (platform === 'darwin') return path.join(appData, 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts', 'Utility');
  return path.join(home, '.local', 'share', 'DaVinciResolve', 'Fusion', 'Scripts', 'Utility');
}

export function createResolveHandoff(options: {
  directory: string; scriptDirectory: string;
  receive: (file: string, source?: 'script' | 'snapshot') => boolean;
  changed?: (status: ResolveHandoffStatus) => void;
  delay?: number;
  preferencesDirectory?: string;
  receiptInterval?: number;
  responseTimeout?: number;
}) {
  const incoming = path.join(options.directory, 'timeline.xml');
  const script = path.join(options.scriptDirectory, 'Send to Smoothy.lua');
  const delay = options.delay ?? 600;
  let watcher: fs.FSWatcher | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let fingerprint = '', previousStat = '', error = '', received = false, attempts = 0;
  let closed = false;
  let phase = '', receipt = '';
  let pendingSnapshot: { file: string; serial: string } | null = null;
  let receiptTimer: ReturnType<typeof setInterval> | null = null, responseTimer: ReturnType<typeof setTimeout> | null = null;
  const profiles = options.preferencesDirectory || path.resolve(options.scriptDirectory, '..', '..', 'Profiles');
  function statusShape() {
    let installed = false;
    try { installed = fs.readFileSync(script, 'utf8') === sendToSmoothyScript(incoming); } catch {}
    return { installed, watching: !!watcher, error, received, phase, menu: 'Workspace → Scripts → Send to Smoothy', scriptPath: script };
  }
  function publish() { options.changed?.(statusShape()); }
  function clearResponseTimer() { if (responseTimer) clearTimeout(responseTimer); responseTimer = null; }
  function pollReceipt() {
    const next = readHandoffReceipt(profiles);
    if (pendingSnapshot) {
      // A newer send supersedes a queued source. Never import it after a new failure.
      if (next && next.value !== receipt) pendingSnapshot = null;
      else {
        try {
          const xml = snapshotToXml(readSnapshotPacket(pendingSnapshot.file, pendingSnapshot.serial));
          const destination = path.join(options.directory, 'source-snapshot.xml');
          const temporary = path.join(options.directory, `.snapshot-${randomUUID()}.tmp`);
          try { fs.writeFileSync(temporary, xml, { flag: 'wx' }); fs.renameSync(temporary, destination); }
          finally { fs.rmSync(temporary, { force: true }); }
          if (!options.receive(destination, 'snapshot')) return;
          pendingSnapshot = null; received = true; phase = 'received'; error = ''; clearResponseTimer(); publish();
        } catch (cause) {
          pendingSnapshot = null; phase = 'failed'; error = cause instanceof Error ? cause.message : 'Could not read the Resolve source snapshot.'; clearResponseTimer(); publish();
        }
        return;
      }
    }
    if (!next || next.value === receipt) return;
    receipt = next.value;
    if (next.phase === 'started') received = false;
    if (next.phase === 'snapshot') {
      pendingSnapshot = { file: next.file, serial: next.value.split('|')[1] };
      phase = 'reading'; error = ''; clearResponseTimer(); publish(); return;
    }
    if (next.phase !== 'exported' || phase !== 'received') phase = next.phase;
    error = next.phase === 'failed' ? RECEIPT_ERRORS[next.code] || 'The Resolve helper reported an unsupported error.' : '';
    clearResponseTimer(); publish();
  }
  function schedule() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(receive, delay); timer.unref?.();
  }
  function receive() {
    timer = null;
    try {
      const info = fs.lstatSync(incoming);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024) throw new Error('The incoming Resolve XML must be a regular file smaller than 25 MB.');
      const stat = `${info.size}:${info.mtimeMs}`;
      if (stat !== previousStat) { previousStat = stat; attempts = 0; schedule(); return; }
      const hash = createHash('sha256').update(fs.readFileSync(incoming)).digest('hex');
      if (hash === fingerprint) {
        // Keep the export destination free even if Resolve refuses overwrites.
        try { fs.renameSync(incoming, path.join(options.directory, 'received.xml')); } catch { schedule(); }
        clearResponseTimer(); phase = 'received'; error = ''; publish();
        return;
      }
      if (!options.receive(incoming, 'script')) { schedule(); return; } // Queue while Multicam owns its captured source.
      fingerprint = hash; error = ''; received = true; phase = 'received'; attempts = 0; clearResponseTimer(); publish();
      try { fs.renameSync(incoming, path.join(options.directory, 'received.xml')); } catch { schedule(); }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (++attempts < 4) { schedule(); return; }
      error = cause instanceof Error ? cause.message : 'Could not receive the Resolve timeline.';
      publish();
    }
  }
  return {
    snapshot: statusShape,
    start() {
      closed = false;
      if (watcher) return;
      fs.mkdirSync(options.directory, { recursive: true });
      watcher = fs.watch(options.directory, (_event, filename) => { if (!filename || String(filename) === 'timeline.xml') schedule(); });
      watcher.on('error', cause => { error = cause.message; publish(); });
      receipt = readHandoffReceipt(profiles)?.value || '';
      receiptTimer = setInterval(pollReceipt, options.receiptInterval ?? 500); receiptTimer.unref?.();
      // A file sent while Smoothy was closed can be received on startup.
      schedule();
    },
    install() {
      fs.mkdirSync(options.scriptDirectory, { recursive: true });
      if (fs.existsSync(script) && !fs.readFileSync(script, 'utf8').startsWith(SIGNATURE)) throw new Error('A different Send to Smoothy.lua already exists. Rename it in your Resolve Scripts folder before installing this helper.');
      const temporary = path.join(options.scriptDirectory, `.smoothy-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, sendToSmoothyScript(incoming), { flag: 'wx' });
        fs.renameSync(temporary, script);
      } finally { fs.rmSync(temporary, { force: true }); }
      error = ''; publish(); return statusShape();
    },
    waitForHelper() {
      clearResponseTimer(); phase = 'waiting'; error = '';
      // Ignore any old receipt already present before this explicit test.
      receipt = readHandoffReceipt(profiles)?.value || '';
      responseTimer = setTimeout(() => {
        phase = 'unresponsive'; error = 'No response came from Resolve. Open Workspace → Console → Lua and run the copied command; then check for a [Smoothy] error. Manual XML export is still available.';
        responseTimer = null; publish();
      }, options.responseTimeout ?? 30000);
      responseTimer.unref?.(); publish(); return statusShape();
    },
    close() { closed = true; if (timer) clearTimeout(timer); timer = null; clearResponseTimer(); if (receiptTimer) clearInterval(receiptTimer); receiptTimer = null; watcher?.close(); watcher = null; }
  };
}
