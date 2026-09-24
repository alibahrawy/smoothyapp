const ppro = require('premierepro');

// New desktop listens on 3457; the released Electron app still listens on 3456.
// Trying both keeps one plugin compatible during the transition.
const BRIDGE_URLS = ['ws://localhost:3457', 'ws://localhost:3456'];
const BRIDGE_VERSION = 'uxp-20260916-transcript-shorts-v1';
const STATE_PUSH_INTERVAL_MS = 500; // 2 Hz cap — Adobe-recommended stutter-safe ceiling.
const state = {
  socket: null,
  bridgeUrlIndex: 0,
  reconnectTimer: null,
  connected: false,
  // Coalesced state push — only send on diff.
  lastSeqId: null,
  lastPlayheadSec: -1,
  lastHasSelection: null,
  // DVATA-1118 workaround: the first 2 getPlayerPosition reads after an
  // activeSequenceChanged event return stale values until Premiere 26.2.
  staleReadsRemaining: 0,
  pollTimer: null,
  eventSubscribed: false,
  subscribedSequenceId: null
};

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const sequenceText = document.getElementById('sequenceText');
const detailText = document.getElementById('detailText');
const reconnectButton = document.getElementById('reconnectButton');
const refreshButton = document.getElementById('refreshButton');
const logPanel = document.getElementById('logPanel');

function setStatus(connected, message, detail) {
  state.connected = connected;
  statusDot.className = `status-dot${connected ? ' connected' : ''}`;
  statusText.textContent = message;
  if (detail) detailText.textContent = `${detail} (${BRIDGE_VERSION})`;
}

function log(level, message) {
  const timestamp = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${timestamp}] ${message}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
  // Also log to UXP console for DevTools debugging
  console.log(`[SmoothyEdit ${level.toUpperCase()}] ${message}`);
}

function send(message) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    // Default to 'reply' — identify and state pushes set `kind` explicitly.
    const envelope = { kind: 'reply', bridgeVersion: BRIDGE_VERSION, ...message };
    state.socket.send(JSON.stringify(envelope));
    return true;
  }
  return false;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setInterval(connect, 3000);
}

function clearReconnect() {
  if (!state.reconnectTimer) return;
  clearInterval(state.reconnectTimer);
  state.reconnectTimer = null;
}

function connect() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) return;

  try {
    const bridgeUrl = BRIDGE_URLS[state.bridgeUrlIndex];
    state.socket = new WebSocket(bridgeUrl);
    setStatus(false, 'Connecting...', bridgeUrl);
    log('info', 'Connecting to SmoothyEdit app...');

    state.socket.onopen = async () => {
      clearReconnect();
      setStatus(true, 'Connected to SmoothyEdit', 'UXP bridge is online.');
      log('success', 'WebSocket connected');
      // Identify ourselves so nle-router sets activeNleApp=premiere. The legacy
      // `type: 'pluginConnected'` is kept for older smoothyedit-app listeners.
      send({
        kind: 'identify',
        type: 'pluginConnected',
        nle: 'premiere',
        pluginType: 'uxp',
        bridgeVersion: BRIDGE_VERSION
      });
      logSequenceEventConstants();
      await sendSequenceInfo();
      await subscribeToSequenceEvents();
      startStatePushLoop();
    };

    state.socket.onclose = () => {
      state.bridgeUrlIndex = (state.bridgeUrlIndex + 1) % BRIDGE_URLS.length;
      setStatus(false, 'Disconnected - reconnecting...', 'Start SmoothyEdit desktop app, then keep this panel open.');
      log('warn', 'WebSocket disconnected, will retry...');
      stopStatePushLoop();
      scheduleReconnect();
    };

    state.socket.onerror = (err) => {
      setStatus(false, 'Connection failed', `Waiting for SmoothyEdit desktop app (${BRIDGE_URLS.join(' or ')}).`);
      log('error', 'WebSocket error: ' + (err && err.message ? err.message : 'unknown'));
    };

    state.socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        log('info', `RX: ${data.type}`);
        await handleMessage(data);
      } catch (error) {
        log('error', 'Message handler error: ' + error.message);
        sendError('bridgeError', error);
      }
    };
  } catch (error) {
    setStatus(false, 'Failed to connect', error.message);
    log('error', 'Connection exception: ' + error.message);
    scheduleReconnect();
  }
}

async function handleMessage(data) {
  switch (data.type) {
    case 'welcome':
      return;
    case 'getSequenceInfo':
      return sendSequenceInfo(data.requestId);
    case 'importXML':
      return importXML(data.xmlPath, data.requestId);
    case 'addMarkers':
      log('info', `addMarkers received: ${Array.isArray(data.markers) ? data.markers.length : 0} markers`);
      return addMarkersToSequence(data.markers);
    case 'clearMarkers':
      return clearAllMarkers();
    case 'exportSubtitles':
      return exportSubtitles();
    case 'importCaptions':
      return importCaptions(data.captions);
    case 'exportAudio':
      return sendUnsupported('audioExported', 'Audio export is not exposed by the Premiere UXP API yet. Use SmoothyEdit desktop audio extraction from source media instead.');
    case 'createShortsAssembly':
      return createShortsAssembly(data);
    case 'removeSilence':
      return removeSilence(data);
    case 'applyMulticamCuts':
      return applyMulticamCuts(data);
    case 'cutMarkedShorts':
      return sendUnsupported('markedShortsCut', 'Cutting marked shorts requires timeline extraction APIs that are not available in Premiere UXP yet.');
    default:
      log('warn', `Unknown message type: ${data.type}`);
      return;
  }
}

async function getActiveProjectAndSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) return { error: 'No project open' };
  const sequence = await project.getActiveSequence();
  if (!sequence) return { project, error: 'No active sequence' };
  return { project, sequence };
}

// `requestId` (optional) makes the reply awaitable through the desktop's
// ctrl/reply correlation \u2014 legacy senders that omit it still get the old
// broadcast shape.
async function sendSequenceInfo(requestId) {
  const reply = (payload) =>
    send(requestId ? { kind: 'reply', requestId, ok: true, ...payload } : payload);
  try {
    const { sequence, error } = await getActiveProjectAndSequence();
    if (error) {
      sequenceText.textContent = error;
      reply({ type: 'sequenceInfo', hasSequence: false, error });
      log('warn', 'Sequence info: ' + error);
      return;
    }

    const info = await buildSequenceInfo(sequence);
    sequenceText.textContent = `${info.name} \u2022 ${info.videoTracks.length} video / ${info.audioTracks.length} audio tracks`;
    reply({ type: 'sequenceInfo', ...info });
    log('info', `Sequence: ${info.name}, ${info.duration.toFixed(1)}s`);
  } catch (error) {
    sequenceText.textContent = 'Failed to read active sequence.';
    reply({ type: 'sequenceInfo', hasSequence: false, error: error.message });
    log('error', 'sendSequenceInfo failed: ' + error.message);
  }
}

async function buildSequenceInfo(sequence) {
  const frameSize = await safeCall(sequence, 'getFrameSize', null);
  const fps = await getSequenceFps(sequence);

  return {
    hasSequence: true,
    name: await readValue(sequence, 'name', 'Active Sequence'),
    id: await readValue(sequence, 'guid', await readValue(sequence, 'sequenceID', '')),
    duration: await secondsFromTime(await safeCall(sequence, 'getEndTime', null)),
    fps,
    width: frameSize && (frameSize.width || frameSize.horizontal) ? frameSize.width || frameSize.horizontal : 1920,
    height: frameSize && (frameSize.height || frameSize.vertical) ? frameSize.height || frameSize.vertical : 1080,
    audioTracks: await readTracks(sequence, 'audio'),
    videoTracks: await readTracks(sequence, 'video')
  };
}

async function readTracks(sequence, kind) {
  const countMethod = kind === 'audio' ? 'getAudioTrackCount' : 'getVideoTrackCount';
  const trackMethod = kind === 'audio' ? 'getAudioTrack' : 'getVideoTrack';
  const fallbackProp = kind === 'audio' ? 'audioTracks' : 'videoTracks';
  const tracks = [];
  const count = await getTrackCount(sequence, countMethod, fallbackProp);

  for (let index = 0; index < count; index++) {
    const track = await getTrack(sequence, trackMethod, fallbackProp, index);
    if (!track) continue;

    const clips = await readTrackItems(track);
    if (clips.length > 0) {
      tracks.push({
        index,
        name: await readValue(track, 'name', `${kind === 'audio' ? 'Audio' : 'Video'} ${index + 1}`),
        clips
      });
    }
  }

  return tracks;
}

async function getTrackCount(sequence, methodName, fallbackProp) {
  const apiCount = await safeCall(sequence, methodName, null);
  if (typeof apiCount === 'number') return apiCount;

  const collection = sequence[fallbackProp];
  if (!collection) return 0;
  return collection.numTracks || collection.length || 0;
}

async function getTrack(sequence, methodName, fallbackProp, index) {
  const apiTrack = await safeCall(sequence, methodName, null, index);
  if (apiTrack) return apiTrack;

  const collection = sequence[fallbackProp];
  if (!collection) return null;
  return collection[index] || null;
}

async function readTrackItems(track) {
  const items = await safeCall(track, 'getTrackItems', null, 1, false);
  const clips = normalizeCollection(items || track.clips);
  const output = [];

  for (const clip of clips) {
    const projectItem = await readValue(clip, 'projectItem', null);
    output.push({
      name: await readValue(clip, 'name', 'Clip'),
      path: await getMediaPath(projectItem),
      start: await secondsFromTime(await readValue(clip, 'start', await safeCall(clip, 'getStartTime', null))),
      end: await secondsFromTime(await readValue(clip, 'end', await safeCall(clip, 'getEndTime', null)))
    });
  }

  return output;
}

function normalizeCollection(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  const count = collection.numItems || collection.length || 0;
  const items = [];
  for (let i = 0; i < count; i++) {
    if (collection[i]) items.push(collection[i]);
  }
  return items;
}

async function getMediaPath(projectItem) {
  if (!projectItem) return '';
  return await safeCall(projectItem, 'getMediaPath', '') || await readValue(projectItem, 'mediaPath', '');
}

async function getSequenceFps(sequence) {
  const settings = await safeCall(sequence, 'getSettings', null);
  const frameRate = settings && (settings.videoFrameRate || settings.frameRate);
  const seconds = frameRate && (frameRate.seconds || frameRate.value);
  return seconds ? 1 / Number(seconds) : 30;
}

async function importXML(xmlPath, requestId) {
  const reply = (payload) =>
    send(requestId ? { kind: 'reply', requestId, ok: Boolean(payload.success), ...payload } : payload);
  try {
    const { project, error } = await getActiveProjectAndSequence();
    if (error && !project) {
      reply({ type: 'xmlImported', success: false, error: { message: error } });
      return;
    }

    const root = await safeCall(project, 'getRootItem', null);
    const imported = await safeCall(project, 'importFiles', false, [xmlPath], true, root, false);
    reply({
      type: 'xmlImported',
      success: Boolean(imported),
      error: imported ? undefined : { message: 'Premiere did not import the XML file.' }
    });
    log('info', `XML import: ${imported ? 'success' : 'failed'} (${xmlPath})`);
  } catch (error) {
    reply({ type: 'xmlImported', success: false, error: { message: error.message } });
    log('error', 'XML import failed: ' + error.message);
  }
}

async function addMarkersToSequence(markers) {
  const debug = {
    bridgeVersion: BRIDGE_VERSION,
    markerCount: Array.isArray(markers) ? markers.length : 0,
    steps: []
  };

  try {
    const { project, sequence, error } = await getActiveProjectAndSequence();
    if (error) {
      debug.steps.push({ step: 'active-sequence', error });
      log('error', 'addMarkers: no active sequence');
      send({ type: 'markersAdded', success: false, error, debug });
      return;
    }
    debug.steps.push({ step: 'active-sequence', ok: true });

    if (!markers || markers.length === 0) {
      debug.steps.push({ step: 'input-markers', error: 'empty' });
      send({ type: 'markersAdded', success: false, error: 'No markers were provided.', debug });
      return;
    }

    const seqMarkers = await getSequenceMarkers(sequence);
    const hasMarkerApi = seqMarkers && typeof seqMarkers.createAddMarkerAction === 'function';
    debug.steps.push({ step: 'sequence-markers', hasMarkerApi });
    log('info', `Marker API available: ${hasMarkerApi}`);

    if (!hasMarkerApi) {
      // UXP marker API not available - create a shorts sequence via XML instead
      log('warn', 'UXP marker API not available, creating shorts sequence via XML...');
      await createShortsSequenceViaXML(project, sequence, markers, debug);
      return;
    }

    const sequenceDuration = await secondsFromTime(await safeCall(sequence, 'getEndTime', null));
    debug.sequenceDuration = sequenceDuration;
    const actions = [];
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const start = clampMarkerTime(parseTimeValue(marker.time || marker.startTime || marker.start), sequenceDuration);
      const name = sanitizeText(marker.name || marker.title || `Short ${i + 1}`, `Short ${i + 1}`);
      const comments = sanitizeText(marker.comment || marker.comments || marker.description || name, name);
      const action = await createMarkerAction(seqMarkers, name, start, 0, comments, debug);
      debug.steps.push({
        step: 'create-marker-action',
        index: i + 1,
        name,
        start,
        hasAction: Boolean(action),
        actionType: action && action.constructor ? action.constructor.name : typeof action
      });
      if (action) actions.push(action);
    }

    if (actions.length === 0) {
      send({ type: 'markersAdded', success: false, error: 'Premiere did not create any marker actions.', debug });
      return;
    }

    debug.steps.push({ step: 'execute-transaction-start', actions: actions.length });
    const executed = project.executeTransaction((compound) => {
      for (const action of actions) {
        const added = compound.addAction(action);
        if (!added) {
          debug.steps.push({ step: 'compound-add-action', warning: 'compound.addAction returned false' });
        }
      }
    }, `SmoothyEdit · Add ${actions.length} markers`);
    debug.steps.push({ step: 'execute-transaction-end', executed: Boolean(executed) });

    if (!executed) {
      send({
        type: 'markersAdded',
        success: false,
        error: 'Premiere rejected the UXP marker transaction.',
        debug
      });
      return;
    }

    send({
      type: 'markersAdded',
      success: true,
      count: actions.length,
      debug
    });
    log('success', `Added ${actions.length} markers via UXP`);
  } catch (error) {
    debug.steps.push({ step: 'exception', error: formatError(error) });
    log('error', 'addMarkers exception: ' + error.message);
    send({ type: 'markersAdded', success: false, error: error.message, debug });
  }
}

// ---------------------------------------------------------------------------
// Phase 1: remove silence — apply cuts directly to the active sequence.
//
// Accepts { segments: [{startSec, endSec}], mode: 'razor'|'delete'|'disable',
//          tracks?: { video: boolean, audio: boolean }, requestId? }
//
// Reply shape (kind: 'reply', type: 'silenceRemoved'):
//   { ok, requestId?, count, mode, backupSequenceName?, error? }
// ---------------------------------------------------------------------------

async function removeSilence(request) {
  const requestId = request && request.requestId;
  const mode = request && (request.mode === 'delete' || request.mode === 'disable')
    ? request.mode
    : 'razor';
  const segments = sanitizeSegments(request && request.segments);
  const tracks = {
    video: request && request.tracks ? request.tracks.video !== false : true,
    audio: request && request.tracks ? request.tracks.audio !== false : true,
  };

  if (segments.length === 0) {
    send({
      type: 'silenceRemoved',
      requestId,
      ok: false,
      error: { code: 'no-segments', message: 'No silence segments were provided.' },
    });
    return;
  }

  try {
    const { project, sequence, error } = await getActiveProjectAndSequence();
    if (error || !sequence) {
      send({
        type: 'silenceRemoved',
        requestId,
        ok: false,
        error: { code: 'no-active-sequence', message: error || 'No active sequence.' },
      });
      return;
    }

    const backupSequenceName = await cloneSequenceForBackup(project, sequence, 'BeforeSilenceRemoval');

    const editor = await safeCall(sequence, 'getEditor', null);
    const sequenceEditorAvailable = editor && typeof editor === 'object';
    if (!sequenceEditorAvailable) {
      send({
        type: 'silenceRemoved',
        requestId,
        ok: false,
        error: {
          code: 'sequence-editor-missing',
          message: 'sequence.getEditor() not available in this Premiere build.',
          suggestion: 'Update Premiere to 25.6 or later; or use the XML export path.',
        },
        backupSequenceName,
      });
      return;
    }

    const applied = await applyCutPlanInTransaction({
      project,
      sequence,
      editor,
      segments,
      mode,
      tracks,
      label: `SmoothyEdit · Remove silence (${segments.length} segments, ${mode})`,
    });

    if (!applied.ok) {
      send({
        type: 'silenceRemoved',
        requestId,
        ok: false,
        error: applied.error,
        backupSequenceName,
      });
      return;
    }

    send({
      type: 'silenceRemoved',
      requestId,
      ok: true,
      count: segments.length,
      mode,
      backupSequenceName,
    });
    log('success', `Removed ${segments.length} silences via UXP (${mode}); backup: ${backupSequenceName || 'none'}`);
  } catch (error) {
    log('error', `removeSilence exception: ${error.message}`);
    send({
      type: 'silenceRemoved',
      requestId,
      ok: false,
      error: { code: 'exception', message: error.message },
    });
  }
}

function sanitizeSegments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const seg of input) {
    if (!seg) continue;
    const startSec = Number(seg.startSec ?? seg.start);
    const endSec = Number(seg.endSec ?? seg.end);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    if (endSec <= startSec) continue;
    out.push({ startSec: Math.max(0, startSec), endSec });
  }
  // Sort ascending by start; merge overlaps to keep edits deterministic.
  out.sort((a, b) => a.startSec - b.startSec);
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, s.endSec);
    } else {
      merged.push({ startSec: s.startSec, endSec: s.endSec });
    }
  }
  return merged;
}

async function cloneSequenceForBackup(project, sequence, suffix) {
  try {
    const original = await readValue(sequence, 'name', 'Sequence');
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, '')
      .slice(2, 12); // YYMMDDHHMM
    const name = `${original}_${suffix}_${stamp}`.slice(0, 96);
    // Premiere exposes Sequence.clone() in UXP 25.0+; fall back to project-level clone if missing.
    if (typeof sequence.clone === 'function') {
      const cloned = await sequence.clone();
      if (cloned && typeof cloned.setName === 'function') {
        try { await cloned.setName(name); } catch { /* leave default name */ }
      }
      log('info', `Backup sequence created: ${name}`);
      return name;
    }
    if (project && typeof project.cloneSequence === 'function') {
      await project.cloneSequence(sequence, name);
      log('info', `Backup sequence created via project.cloneSequence: ${name}`);
      return name;
    }
    log('warn', 'No sequence.clone() or project.cloneSequence() available — skipping backup.');
    return null;
  } catch (error) {
    log('warn', `cloneSequenceForBackup failed: ${error.message}`);
    return null;
  }
}

// Single transaction: insert razor edits at every silence boundary across the
// requested tracks, then optionally delete or disable the resulting silent
// items. The editor exposes (verified in UXP 26.x types.d.ts):
//   createAddEditAction(time, videoTracks?, audioTracks?)
//   createRemoveItemsAction(itemIds, rippleEdit, alignToVideo)
//   createSetEnabledAction(itemId, enabled)  // or per-clip disabled prop
// We feature-detect each one; absence of any of them is reported back to the
// renderer instead of silently skipping.
async function applyCutPlanInTransaction({ project, sequence, editor, segments, mode, tracks, label }) {
  const addEdit = pickEditorMethod(editor, ['createAddEditAction', 'createInsertEditAction', 'createAddEditPointAction']);
  if (!addEdit) {
    return {
      ok: false,
      error: {
        code: 'editor-missing-add-edit',
        message: 'SequenceEditor has no add-edit action exposed.',
        suggestion: 'Premiere 25.6+ is required for direct silence apply. Use XML export instead.',
      },
    };
  }

  const trackTargets = await collectTrackTargets(sequence, tracks);
  const cutTimes = collectCutTimes(segments);

  // Pre-compute TickTimes (async) outside the transaction to keep the
  // transaction body synchronous-friendly (executeTransaction's callback
  // expects synchronous addAction calls).
  const cutTickTimes = [];
  for (const t of cutTimes) {
    cutTickTimes.push(await ppro.TickTime.createWithSeconds(t));
  }

  // Build razor (add-edit) actions for every cut time on every selected track.
  const editActions = [];
  for (const t of cutTickTimes) {
    try {
      const action = editor[addEdit](t, trackTargets.video, trackTargets.audio);
      if (action) editActions.push(action);
    } catch (err) {
      log('warn', `${addEdit} failed at ${t.seconds}s: ${err.message}`);
    }
  }

  const executed = project.executeTransaction((compound) => {
    for (const a of editActions) compound.addAction(a);
  }, label + ' · razor');

  if (!executed) {
    return {
      ok: false,
      error: {
        code: 'razor-transaction-rejected',
        message: 'Premiere rejected the razor-cuts transaction.',
      },
    };
  }

  if (mode === 'razor') return { ok: true };

  // After razor, the silent regions are now their own track items. Find them
  // and either remove or disable them in a second transaction.
  const silentItemIds = await findItemIdsCoveringSegments(sequence, segments, trackTargets);
  if (silentItemIds.length === 0) {
    return {
      ok: true,
      warning: 'Razor cuts applied but no items matched the silent regions for ' + mode + '.',
    };
  }

  if (mode === 'delete') {
    const removeAction = pickEditorMethod(editor, ['createRemoveItemsAction']);
    if (!removeAction) {
      return {
        ok: false,
        error: {
          code: 'editor-missing-remove',
          message: 'SequenceEditor.createRemoveItemsAction not exposed.',
        },
      };
    }
    let actionRef = null;
    try {
      actionRef = editor[removeAction](silentItemIds, true /* ripple */, true /* align to video */);
    } catch (err) {
      return { ok: false, error: { code: 'remove-action-create-failed', message: err.message } };
    }
    const ok = project.executeTransaction((compound) => {
      if (actionRef) compound.addAction(actionRef);
    }, label + ' · delete');
    return ok ? { ok: true } : { ok: false, error: { code: 'remove-transaction-rejected', message: 'Premiere rejected delete transaction.' } };
  }

  if (mode === 'disable') {
    const setEnabledMethod = pickEditorMethod(editor, ['createSetEnabledAction', 'createSetItemEnabledAction']);
    if (!setEnabledMethod) {
      // Per-clip setDisabled fallback (no transaction wrapping possible if the API isn't action-shaped).
      let disabled = 0;
      const allItems = await collectItemsByIds(sequence, silentItemIds, trackTargets);
      for (const item of allItems) {
        try {
          if (typeof item.setDisabled === 'function') {
            await item.setDisabled(true);
            disabled++;
          } else if (typeof item.setEnabled === 'function') {
            await item.setEnabled(false);
            disabled++;
          }
        } catch (err) {
          log('warn', `setDisabled failed: ${err.message}`);
        }
      }
      return disabled > 0
        ? { ok: true, warning: 'Disabled per-clip (no transactional disable action available).' }
        : {
            ok: false,
            error: {
              code: 'no-disable-mechanism',
              message: 'Neither createSetEnabledAction nor clip.setDisabled were exposed.',
              suggestion: 'Try mode: "delete" or use XML export.',
            },
          };
    }
    const disableActions = [];
    for (const id of silentItemIds) {
      try {
        const a = editor[setEnabledMethod](id, false);
        if (a) disableActions.push(a);
      } catch (err) {
        log('warn', `${setEnabledMethod} failed for ${id}: ${err.message}`);
      }
    }
    const ok = project.executeTransaction((compound) => {
      for (const a of disableActions) compound.addAction(a);
    }, label + ' · disable');
    return ok ? { ok: true } : { ok: false, error: { code: 'disable-transaction-rejected', message: 'Premiere rejected disable transaction.' } };
  }

  return { ok: true };
}

function pickEditorMethod(editor, candidates) {
  for (const name of candidates) {
    if (editor && typeof editor[name] === 'function') return name;
  }
  return null;
}

async function collectTrackTargets(sequence, tracks) {
  // Returns plain arrays of track indices the razor action should hit.
  const videoIndices = [];
  const audioIndices = [];
  if (tracks.video) {
    const vCount = await getTrackCount(sequence, 'getVideoTrackCount', 'videoTracks');
    for (let i = 0; i < vCount; i++) videoIndices.push(i);
  }
  if (tracks.audio) {
    const aCount = await getTrackCount(sequence, 'getAudioTrackCount', 'audioTracks');
    for (let i = 0; i < aCount; i++) audioIndices.push(i);
  }
  return { video: videoIndices, audio: audioIndices };
}

function collectCutTimes(segments) {
  const times = new Set();
  for (const s of segments) {
    times.add(s.startSec);
    times.add(s.endSec);
  }
  return Array.from(times).sort((a, b) => a - b);
}

async function findItemIdsCoveringSegments(sequence, segments, trackTargets) {
  const ids = new Set();
  const sequenceFps = await getSequenceFps(sequence);
  const tolerance = 0.5 / (sequenceFps || 30); // half a frame

  const collectFromTrack = async (track) => {
    if (!track) return;
    const trackItems = normalizeCollection(await safeCall(track, 'getTrackItems', null, 1, false) || track.clips);
    for (const item of trackItems) {
      const startSec = await secondsFromTime(await readValue(item, 'start', await safeCall(item, 'getStartTime', null)));
      const endSec = await secondsFromTime(await readValue(item, 'end', await safeCall(item, 'getEndTime', null)));
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
      for (const seg of segments) {
        if (startSec >= seg.startSec - tolerance && endSec <= seg.endSec + tolerance) {
          const id = await readValue(item, 'nodeId', await readValue(item, 'id', null));
          if (id !== null && id !== undefined) ids.add(id);
          break;
        }
      }
    }
  };

  for (const idx of trackTargets.video) {
    const t = await getTrack(sequence, 'getVideoTrack', 'videoTracks', idx);
    await collectFromTrack(t);
  }
  for (const idx of trackTargets.audio) {
    const t = await getTrack(sequence, 'getAudioTrack', 'audioTracks', idx);
    await collectFromTrack(t);
  }
  return Array.from(ids);
}

async function collectItemsByIds(sequence, ids, trackTargets) {
  const wanted = new Set(ids.map(String));
  const items = [];
  const visit = async (track) => {
    if (!track) return;
    const trackItems = normalizeCollection(await safeCall(track, 'getTrackItems', null, 1, false) || track.clips);
    for (const item of trackItems) {
      const id = await readValue(item, 'nodeId', await readValue(item, 'id', null));
      if (id !== null && id !== undefined && wanted.has(String(id))) items.push(item);
    }
  };
  for (const idx of trackTargets.video) {
    await visit(await getTrack(sequence, 'getVideoTrack', 'videoTracks', idx));
  }
  for (const idx of trackTargets.audio) {
    await visit(await getTrack(sequence, 'getAudioTrack', 'audioTracks', idx));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Phase 2: applyMulticamCuts — razor all video tracks at every shot boundary,
// then enable the chosen camera's track item and disable the others.
//
// Accepts { shots: [{startSec, endSec, trackIndex}], requestId }
// Reply: { kind: 'reply', type: 'multicamApplied', ok, count, backupSequenceName, error? }
//
// Caveat: the user's camera tracks must already exist on the sequence's video
// tracks (Vn → cameraIndex n). We don't move clips between tracks; we only
// toggle their enabled state. This is the same model as AutoPod's
// non-destructive disable mode.
// ---------------------------------------------------------------------------

async function applyMulticamCuts(request) {
  const requestId = request && request.requestId;
  const shots = sanitizeShots(request && request.shots);
  if (shots.length === 0) {
    send({
      type: 'multicamApplied',
      requestId,
      ok: false,
      error: { code: 'no-shots', message: 'No multicam shots were provided.' },
    });
    return;
  }

  try {
    const { project, sequence, error } = await getActiveProjectAndSequence();
    if (error || !sequence) {
      send({
        type: 'multicamApplied',
        requestId,
        ok: false,
        error: { code: 'no-active-sequence', message: error || 'No active sequence.' },
      });
      return;
    }

    const backupSequenceName = await cloneSequenceForBackup(project, sequence, 'BeforeMulticam');

    const editor = await safeCall(sequence, 'getEditor', null);
    if (!editor) {
      send({
        type: 'multicamApplied',
        requestId,
        ok: false,
        error: {
          code: 'sequence-editor-missing',
          message: 'sequence.getEditor() not available in this Premiere build.',
        },
        backupSequenceName,
      });
      return;
    }

    const addEditMethod = pickEditorMethod(editor, [
      'createAddEditAction', 'createInsertEditAction', 'createAddEditPointAction',
    ]);
    if (!addEditMethod) {
      send({
        type: 'multicamApplied',
        requestId,
        ok: false,
        error: { code: 'editor-missing-add-edit', message: 'SequenceEditor has no add-edit action.' },
        backupSequenceName,
      });
      return;
    }

    // Collect unique cut times (start of every shot + end of last) across all video tracks.
    const cutTimes = new Set();
    for (const s of shots) {
      cutTimes.add(s.startSec);
      cutTimes.add(s.endSec);
    }
    const sortedTimes = Array.from(cutTimes).sort((a, b) => a - b);

    const videoCount = await getTrackCount(sequence, 'getVideoTrackCount', 'videoTracks');
    const audioCount = await getTrackCount(sequence, 'getAudioTrackCount', 'audioTracks');
    const allVideoIndices = [];
    for (let i = 0; i < videoCount; i++) allVideoIndices.push(i);
    const allAudioIndices = [];
    for (let i = 0; i < audioCount; i++) allAudioIndices.push(i);

    // Pre-build TickTimes (async) before the transaction.
    const tickTimes = [];
    for (const t of sortedTimes) tickTimes.push(await ppro.TickTime.createWithSeconds(t));

    const razorActions = [];
    for (const tt of tickTimes) {
      try {
        const a = editor[addEditMethod](tt, allVideoIndices, allAudioIndices);
        if (a) razorActions.push(a);
      } catch (err) {
        log('warn', `multicam razor at ${tt.seconds}s failed: ${err.message}`);
      }
    }

    const razorOk = project.executeTransaction((compound) => {
      for (const a of razorActions) compound.addAction(a);
    }, `SmoothyEdit · Multicam razor (${sortedTimes.length} edits)`);
    if (!razorOk) {
      send({
        type: 'multicamApplied',
        requestId,
        ok: false,
        error: { code: 'razor-transaction-rejected', message: 'Premiere rejected the razor transaction.' },
        backupSequenceName,
      });
      return;
    }

    // Now find every track item covering each shot per video track, then
    // enable/disable based on whether its trackIndex matches shot.trackIndex.
    const enableTargets = []; // [{itemId, enable: bool}]
    for (let v = 0; v < videoCount; v++) {
      const track = await getTrack(sequence, 'getVideoTrack', 'videoTracks', v);
      if (!track) continue;
      const items = normalizeCollection(
        (await safeCall(track, 'getTrackItems', null, 1, false)) || track.clips,
      );
      for (const item of items) {
        const startSec = await secondsFromTime(await readValue(item, 'start', await safeCall(item, 'getStartTime', null)));
        const endSec = await secondsFromTime(await readValue(item, 'end', await safeCall(item, 'getEndTime', null)));
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
        const itemId = await readValue(item, 'nodeId', await readValue(item, 'id', null));
        if (itemId === null || itemId === undefined) continue;

        // Find the shot that contains this item's midpoint.
        const mid = (startSec + endSec) / 2;
        const shot = shots.find((s) => mid >= s.startSec - 0.001 && mid <= s.endSec + 0.001);
        if (!shot) continue;
        enableTargets.push({
          itemId,
          enable: v === shot.trackIndex,
          item, // for fallback path
        });
      }
    }

    const setEnabledMethod = pickEditorMethod(editor, ['createSetEnabledAction', 'createSetItemEnabledAction']);
    if (setEnabledMethod) {
      const enableActions = [];
      for (const t of enableTargets) {
        try {
          const a = editor[setEnabledMethod](t.itemId, t.enable);
          if (a) enableActions.push(a);
        } catch (err) {
          log('warn', `${setEnabledMethod} failed for ${t.itemId}: ${err.message}`);
        }
      }
      const ok = project.executeTransaction((compound) => {
        for (const a of enableActions) compound.addAction(a);
      }, `SmoothyEdit · Multicam enable/disable (${enableTargets.length} items)`);
      if (!ok) {
        send({
          type: 'multicamApplied',
          requestId,
          ok: false,
          error: { code: 'enable-transaction-rejected', message: 'Premiere rejected the enable/disable transaction.' },
          backupSequenceName,
        });
        return;
      }
    } else {
      // Per-item fallback — no transaction wrapping is possible without the
      // action factory. Cmd-Z will undo each toggle individually.
      let toggled = 0;
      for (const t of enableTargets) {
        try {
          if (typeof t.item.setDisabled === 'function') {
            await t.item.setDisabled(!t.enable);
            toggled++;
          } else if (typeof t.item.setEnabled === 'function') {
            await t.item.setEnabled(t.enable);
            toggled++;
          }
        } catch (err) {
          log('warn', `multicam per-item toggle failed: ${err.message}`);
        }
      }
      if (toggled === 0) {
        send({
          type: 'multicamApplied',
          requestId,
          ok: false,
          error: {
            code: 'no-enable-mechanism',
            message: 'Neither createSetEnabledAction nor clip.setDisabled were available.',
          },
          backupSequenceName,
        });
        return;
      }
    }

    send({
      type: 'multicamApplied',
      requestId,
      ok: true,
      count: shots.length,
      backupSequenceName,
    });
    log('success', `Applied ${shots.length} multicam shots; backup: ${backupSequenceName || 'none'}`);
  } catch (error) {
    log('error', `applyMulticamCuts exception: ${error.message}`);
    send({
      type: 'multicamApplied',
      requestId,
      ok: false,
      error: { code: 'exception', message: error.message },
    });
  }
}

function sanitizeShots(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const s of input) {
    if (!s) continue;
    const startSec = Number(s.startSec ?? s.start);
    const endSec = Number(s.endSec ?? s.end);
    const trackIndex = Number(s.trackIndex);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    if (!Number.isFinite(trackIndex) || trackIndex < 0) continue;
    if (endSec <= startSec) continue;
    out.push({ startSec: Math.max(0, startSec), endSec, trackIndex });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

async function createShortsSequenceViaXML(project, sequence, markers, debug) {
  try {
    debug.steps.push({ step: 'fallback-to-xml-sequence', reason: 'marker-api-unavailable' });

    const seqName = await readValue(sequence, 'name', 'Sequence');
    const fps = await getSequenceFps(sequence);
    const frameSize = await safeCall(sequence, 'getFrameSize', null);
    const width = frameSize && (frameSize.width || frameSize.horizontal) ? frameSize.width || frameSize.horizontal : 1920;
    const height = frameSize && (frameSize.height || frameSize.vertical) ? frameSize.height || frameSize.vertical : 1080;

    // Generate FCP7 XML with sequence markers
    const xml = generateMarkerXML(seqName, markers, fps, width, height);
    const { localFileSystem: lfs } = require('uxp').storage;
    const dataFolder = await lfs.getDataFolder();
    const xmlFile = await dataFolder.createEntry('SmoothyEdit_Shorts_Markers.xml', { overwrite: true });
    await xmlFile.write(xml);

    log('info', `Marker XML written to: ${xmlFile.nativePath}`);

    // Import the XML
    const imported = await safeCall(project, 'importFiles', false, [xmlFile.nativePath], true, await safeCall(project, 'getRootItem', null), false);

    if (imported) {
      log('success', 'Shorts sequence imported successfully');
      send({
        type: 'markersAdded',
        success: true,
        count: markers.length,
        message: `Created sequence "${seqName}_Shorts" with ${markers.length} markers. UXP marker API is unavailable in this Premiere version.`,
        debug,
        fallbackMethod: 'xml-sequence'
      });
    } else {
      log('error', 'XML import failed');
      send({
        type: 'markersAdded',
        success: false,
        error: 'Premiere did not import the marker XML. You may need to create markers manually.',
        debug
      });
    }
  } catch (error) {
    debug.steps.push({ step: 'xml-sequence-exception', error: formatError(error) });
    log('error', 'createShortsSequenceViaXML failed: ' + error.message);
    send({
      type: 'markersAdded',
      success: false,
      error: 'Failed to create shorts sequence: ' + error.message,
      debug
    });
  }
}

function generateMarkerXML(originalName, markers, fps, width, height) {
  const TICKS_PER_SECOND = 254016000000;
  const timebase = fps.toFixed(3);
  const duration = Math.ceil((markers[markers.length - 1].end || markers[markers.length - 1].time || 60) + 10);
  const durationTicks = Math.floor(duration * TICKS_PER_SECOND);

  let markerXML = '';
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const start = parseTimeValue(m.time || m.startTime || m.start || 0);
    const end = parseTimeValue(m.endTime || m.end || m.outTime || m.out || (start + 60));
    const name = sanitizeText(m.name || m.title || `Short ${i + 1}`, `Short ${i + 1}`);
    const comment = sanitizeText(m.comment || m.comments || m.description || name, name);
    const startTicks = Math.floor(start * TICKS_PER_SECOND);
    const endTicks = Math.floor(end * TICKS_PER_SECOND);

    markerXML += `    <marker>\n      <name>${escapeXml(name)}</name>\n      <in>${startTicks}</in>\n      <out>${endTicks}</out>\n      <comment>${escapeXml(comment)}</comment>\n    </marker>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Xmeml version="4">\n  <sequence>\n    <name>${escapeXml(originalName)}_Shorts</name>\n    <duration>${durationTicks}</duration>\n    <rate>\n      <timebase>${timebase}</timebase>\n      <ntsc>${Math.abs(fps - 29.97) < 0.1 ? 'TRUE' : 'FALSE'}</ntsc>\n    </rate>\n    <media>\n      <video>\n        <format>\n          <samplecharacteristics>\n            <width>${width}</width>\n            <height>${height}</height>\n          </samplecharacteristics>\n        </format>\n        <track/>\n      </video>\n      <audio>\n        <track/>\n      </audio>\n    </media>\n${markerXML}  </sequence>\n</Xmeml>`;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getSequenceMarkers(sequence) {
  if (ppro.Markers && typeof ppro.Markers.getMarkers === 'function') {
    return await ppro.Markers.getMarkers(sequence);
  }
  return await safeCall(sequence, 'getMarkers', null);
}

async function createMarkerAction(markers, name, startSeconds, durationSeconds, comments, debug) {
  const startTime = await ppro.TickTime.createWithSeconds(startSeconds);
  const durationTime = await ppro.TickTime.createWithSeconds(Math.max(0, Number(durationSeconds) || 0));
  const commentText = sanitizeText(comments, name);
  const markerTypes = ['Cue'];
  let lastError = null;

  for (const markerType of markerTypes) {
    try {
      const action = markers.createAddMarkerAction(name, markerType, startTime, durationTime, commentText);
      if (debug && debug.steps) {
        debug.steps.push({ step: 'create-marker-action-candidate', markerType, ok: true });
      }
      return action;
    } catch (error) {
      lastError = error;
      if (debug && debug.steps) {
        debug.steps.push({ step: 'create-marker-action-candidate', markerType, error: formatError(error) });
      }
    }
  }

  throw lastError || new Error('Premiere rejected all marker action parameter variants.');
}

function clampMarkerTime(value, sequenceDuration) {
  const seconds = Number.isFinite(value) && value > 0 ? value : 0;
  if (sequenceDuration && sequenceDuration > 0) {
    return Math.min(seconds, Math.max(0, sequenceDuration - 0.001));
  }
  return seconds;
}

function sanitizeText(value, fallback) {
  const sanitized = String(value || fallback || 'Marker')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return sanitized || fallback || 'Marker';
}

function formatError(error) {
  return {
    message: error && error.message ? error.message : String(error),
    name: error && error.name ? error.name : undefined,
    stack: error && error.stack ? String(error.stack).slice(0, 1000) : undefined
  };
}

async function clearAllMarkers() {
  sendUnsupported('markersCleared', 'Clearing existing sequence markers is not reliably exposed in Premiere UXP yet.');
}

async function exportSubtitles() {
  const debug = { bridgeVersion: BRIDGE_VERSION, clipsScanned: 0, clipsWithTranscript: 0, skipped: [] };
  try {
    const { sequence, error } = await getActiveProjectAndSequence();
    if (error) throw new Error(error);
    if (!ppro.Transcript || typeof ppro.Transcript.exportToJSON !== 'function') {
      throw new Error('Direct transcript access requires Premiere Pro 25.6 or newer.');
    }

    const transcriptCache = new Map();
    const captions = [];
    const videoTrackCount = await getTrackCount(sequence, 'getVideoTrackCount', 'videoTracks');

    for (let trackIndex = 0; trackIndex < videoTrackCount; trackIndex++) {
      const track = await getTrack(sequence, 'getVideoTrack', 'videoTracks', trackIndex);
      if (!track) continue;
      const items = normalizeCollection(await safeCall(track, 'getTrackItems', null, 1, false) || track.clips);

      for (const item of items) {
        debug.clipsScanned++;
        if (await safeCall(item, 'isDisabled', false)) continue;
        const rawProjectItem = await safeCall(item, 'getProjectItem', null) || await readValue(item, 'projectItem', null);
        if (!rawProjectItem) continue;
        if (await safeCall(rawProjectItem, 'isSequence', false)) {
          debug.skipped.push('Nested sequence');
          continue;
        }
        const projectItem = ppro.ClipProjectItem && typeof ppro.ClipProjectItem.cast === 'function'
          ? ppro.ClipProjectItem.cast(rawProjectItem)
          : rawProjectItem;
        if (!projectItem) continue;

        const itemId = String(await safeCall(projectItem, 'getId', '') || await readValue(projectItem, 'id', ''));
        let transcript = transcriptCache.get(itemId);
        if (transcript === undefined) {
          try {
            const raw = await ppro.Transcript.exportToJSON(projectItem);
            transcript = typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch (transcriptError) {
            transcript = null;
            debug.skipped.push(transcriptError.message || 'Clip has no transcript');
          }
          transcriptCache.set(itemId, transcript);
        }
        if (!transcript || !Array.isArray(transcript.segments)) continue;
        debug.clipsWithTranscript++;
        captions.push(...await mapTranscriptToTimeline(transcript, item));
      }
    }

    const cleanCaptions = dedupeAndSortCaptions(captions);
    if (cleanCaptions.length === 0) {
      throw new Error('No usable Premiere transcripts were found on the active timeline. SmoothyEdit will try the audio fallback.');
    }
    const srt = captionsToSrt(cleanCaptions);
    send({
      type: 'subtitlesExported',
      success: true,
      subtitles: srt,
      srt,
      count: cleanCaptions.length,
      sequenceName: await readValue(sequence, 'name', 'sequence'),
      source: 'premiere-transcript',
      debug
    });
    log('success', `Read ${cleanCaptions.length} transcript segments directly from Premiere`);
  } catch (error) {
    debug.error = formatError(error);
    send({ type: 'subtitlesExported', success: false, error: error.message, pluginType: 'uxp', debug });
    log('warn', `Direct transcript unavailable: ${error.message}`);
  }
}

async function mapTranscriptToTimeline(transcript, trackItem) {
  const timelineStart = await secondsFromTime(await safeCall(trackItem, 'getStartTime', null) || await readValue(trackItem, 'start', 0));
  const sourceIn = await secondsFromTime(await safeCall(trackItem, 'getInPoint', null) || await readValue(trackItem, 'inPoint', 0));
  const sourceOut = await secondsFromTime(await safeCall(trackItem, 'getOutPoint', null) || await readValue(trackItem, 'outPoint', Number.MAX_SAFE_INTEGER));
  let speed = Math.abs(Number(await safeCall(trackItem, 'getSpeed', 1))) || 1;
  if (speed > 10) speed /= 100;
  const reversed = Boolean(await safeCall(trackItem, 'isSpeedReversed', false));
  const mapped = [];

  for (const segment of transcript.segments) {
    const words = Array.isArray(segment.words) ? segment.words : [];
    const visible = words.filter((word) => {
      const start = Number(word.start ?? segment.start ?? 0);
      const end = start + Number(word.duration ?? 0);
      return end >= sourceIn && start <= sourceOut;
    });
    if (visible.length === 0) continue;
    const firstStart = Number(visible[0].start ?? segment.start ?? 0);
    const last = visible[visible.length - 1];
    const lastEnd = Number(last.start ?? firstStart) + Number(last.duration ?? 0.2);
    const mapTime = (sourceTime) => reversed
      ? timelineStart + Math.max(0, sourceOut - sourceTime) / speed
      : timelineStart + Math.max(0, sourceTime - sourceIn) / speed;
    const a = mapTime(firstStart);
    const b = mapTime(lastEnd);
    const text = visible.map((word) => String(word.text ?? word.word ?? '').trim()).filter(Boolean).join(' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();
    if (text) mapped.push({ start: Math.min(a, b), end: Math.max(a, b, Math.min(a, b) + 0.15), text });
  }
  return mapped;
}

function dedupeAndSortCaptions(captions) {
  const seen = new Set();
  return captions
    .filter((caption) => caption.text && Number.isFinite(caption.start) && Number.isFinite(caption.end))
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((caption) => {
      const key = `${Math.round(caption.start * 10)}:${caption.text.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function captionsToSrt(captions) {
  return captions.map((caption, index) =>
    `${index + 1}\n${formatSrtTime(caption.start)} --> ${formatSrtTime(caption.end)}\n${caption.text}`
  ).join('\n\n');
}

function formatSrtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

async function createShortsAssembly(request) {
  const markerRanges = ((request && request.markers) || []).map((marker) => ({
    startSec: marker.startSec ?? marker.start ?? marker.time,
    endSec: marker.endSec ?? marker.end ?? marker.endTime
  }));
  const ranges = sanitizeSegments(markerRanges).map((range, index) => ({ ...range, index }));
  const gapSeconds = Math.max(0, Number(request && request.gapSeconds) || 2);
  try {
    if (ranges.length === 0) throw new Error('No short ranges were provided.');
    const { project, sequence, error } = await getActiveProjectAndSequence();
    if (error) throw new Error(error);
    if (typeof sequence.createSubsequence !== 'function' || typeof project.createSequence !== 'function') {
      throw new Error('Shorts assembly requires Premiere Pro 25.6 or newer.');
    }

    const originalIn = await safeCall(sequence, 'getInPoint', null);
    const originalOut = await safeCall(sequence, 'getOutPoint', null);
    const subsequences = [];
    try {
      for (const range of ranges) {
        const inTime = await ppro.TickTime.createWithSeconds(range.startSec);
        const outTime = await ppro.TickTime.createWithSeconds(range.endSec);
        const setIn = sequence.createSetInPointAction(inTime);
        const setOut = sequence.createSetOutPointAction(outTime);
        const setRange = project.executeTransaction((compound) => {
          compound.addAction(setIn);
          compound.addAction(setOut);
        }, `SmoothyEdit · Select Short ${range.index + 1}`);
        if (!setRange) throw new Error(`Premiere rejected range ${range.index + 1}.`);
        const subsequence = await sequence.createSubsequence(true);
        if (!subsequence) throw new Error(`Premiere could not create Short ${range.index + 1}.`);
        subsequences.push({ sequence: subsequence, duration: range.endSec - range.startSec });
      }
    } finally {
      if (originalIn && originalOut) {
        project.executeTransaction((compound) => {
          compound.addAction(sequence.createSetInPointAction(originalIn));
          compound.addAction(sequence.createSetOutPointAction(originalOut));
        }, 'SmoothyEdit · Restore Source Range');
      }
    }

    const sourceName = await readValue(sequence, 'name', 'Sequence');
    const assembly = await project.createSequence(`${sourceName} · Vertical Shorts`);
    if (!assembly) throw new Error('Premiere could not create the assembly sequence.');
    let verticalApplied = false;
    const settings = await safeCall(assembly, 'getSettings', null);
    if (settings && typeof settings.getVideoFrameRect === 'function' && typeof settings.setVideoFrameRect === 'function') {
      const rect = await settings.getVideoFrameRect();
      if (rect) {
        rect.width = Number(request && request.width) || 1080;
        rect.height = Number(request && request.height) || 1920;
        const changed = await settings.setVideoFrameRect(rect);
        if (changed && typeof assembly.createSetSettingsAction === 'function') {
          const settingsAction = assembly.createSetSettingsAction(settings);
          verticalApplied = Boolean(project.executeTransaction(
            (compound) => compound.addAction(settingsAction),
            'SmoothyEdit · Set Vertical Frame'
          ));
        }
      }
    }

    const editor = ppro.SequenceEditor && typeof ppro.SequenceEditor.getEditor === 'function'
      ? await ppro.SequenceEditor.getEditor(assembly)
      : null;
    if (!editor || typeof editor.createInsertProjectItemAction !== 'function') {
      throw new Error('Premiere did not expose sequence insertion for the new assembly.');
    }
    let cursor = 0;
    for (const entry of subsequences) {
      const projectItem = await safeCall(entry.sequence, 'getProjectItem', null);
      const insertionTime = await ppro.TickTime.createWithSeconds(cursor);
      const action = editor.createInsertProjectItemAction(projectItem, insertionTime, 0, 0, true);
      const inserted = project.executeTransaction((compound) => compound.addAction(action), 'SmoothyEdit · Add Short');
      if (!inserted) throw new Error('Premiere rejected a short insertion.');
      cursor += entry.duration + gapSeconds;
    }
    await safeCall(project, 'setActiveSequence', false, assembly);
    await safeCall(project, 'openSequence', false, assembly);
    send({ type: 'shortsAssemblyCreated', success: true, count: subsequences.length, sequenceName: `${sourceName} · Vertical Shorts`, verticalApplied, gapSeconds });
    log('success', `Created vertical assembly with ${subsequences.length} shorts`);
  } catch (error) {
    send({ type: 'shortsAssemblyCreated', success: false, error: error.message, pluginType: 'uxp' });
    log('error', `Shorts assembly failed: ${error.message}`);
  }
}

async function importCaptions() {
  sendUnsupported('captionsImported', 'Caption import is not available in Premiere UXP yet.');
}

function sendUnsupported(type, message) {
  log('warn', `Unsupported: ${type} - ${message}`);
  send({ type, success: false, error: message, pluginType: 'uxp' });
}

function sendError(type, error) {
  log('error', `Error (${type}): ${error && error.message ? error.message : String(error)}`);
  send({ type, success: false, error: error && error.message ? error.message : String(error) });
}

async function readValue(object, key, fallback) {
  if (!object || !(key in object)) return fallback;
  const value = object[key];
  return typeof value === 'function' ? await value.call(object) : value;
}

async function safeCall(object, methodName, fallback, ...args) {
  try {
    if (!object || typeof object[methodName] !== 'function') return fallback;
    return await object[methodName](...args);
  } catch {
    return fallback;
  }
}

async function secondsFromTime(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.seconds === 'number') return value.seconds;
  if (typeof value.ticks === 'number') return value.ticks / 254016000000;
  if (typeof value.ticks === 'string') return Number(value.ticks) / 254016000000;
  return 0;
}

function parseTimeValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const raw = String(value).replace(/,/g, '.');
  if (!raw.includes(':')) return Number.parseFloat(raw) || 0;
  return raw.split(':').reduce((seconds, part) => (seconds * 60) + (Number.parseFloat(part) || 0), 0);
}

// ---------------------------------------------------------------------------
// Timeline state push — Phase 0 of the AutoPod/Phantom feature roadmap.
//
// Subscribes to UXP sequence events when available (no published list of names,
// so we introspect Constants.SequenceEvent at runtime) and falls back to a 2 Hz
// polling loop. Sends `{ kind: 'state', type: 'timelineState', ... }` only on
// diff, so the WebSocket stays quiet while the editor is idle.
// ---------------------------------------------------------------------------

function logSequenceEventConstants() {
  try {
    if (ppro && ppro.Constants && ppro.Constants.SequenceEvent) {
      const names = Object.keys(ppro.Constants.SequenceEvent);
      log('info', `Constants.SequenceEvent: ${names.join(', ') || '(none)'}`);
    } else {
      log('info', 'Constants.SequenceEvent is not exposed in this Premiere build.');
    }
  } catch (error) {
    log('warn', `Could not introspect Constants.SequenceEvent: ${error.message}`);
  }
}

async function subscribeToSequenceEvents() {
  if (state.eventSubscribed) return;
  if (!ppro || !ppro.EventManager || typeof ppro.EventManager.addEventListener !== 'function') {
    log('info', 'EventManager.addEventListener not available — using polling only.');
    return;
  }

  const projectEvents = pickEventName(['activeSequenceChanged', 'ActiveSequenceChanged']);
  if (projectEvents) {
    try {
      ppro.EventManager.addEventListener(ppro.Project, projectEvents, onActiveSequenceChanged);
      state.eventSubscribed = true;
      log('info', `Subscribed: Project.${projectEvents}`);
    } catch (error) {
      log('warn', `Subscribe to Project.${projectEvents} failed: ${error.message}`);
    }
  }

  await attachSequenceListeners();
}

function pickEventName(candidates) {
  if (!ppro || !ppro.Constants || !ppro.Constants.SequenceEvent) return candidates[0];
  const set = new Set(Object.keys(ppro.Constants.SequenceEvent));
  for (const name of candidates) {
    if (set.has(name)) return name;
  }
  return candidates[0];
}

async function onActiveSequenceChanged() {
  state.staleReadsRemaining = 2; // DVATA-1118
  state.subscribedSequenceId = null;
  await attachSequenceListeners();
  await pushTimelineState();
}

async function attachSequenceListeners() {
  if (!ppro || !ppro.EventManager) return;
  const { sequence } = await getActiveProjectAndSequence();
  if (!sequence) return;
  const seqId = await readValue(sequence, 'guid', '');
  if (!seqId || seqId === state.subscribedSequenceId) return;

  const playheadEvent = pickEventName(['playerPositionChanged', 'PlayerPositionChanged']);
  const selectionEvent = pickEventName(['selectionChanged', 'SelectionChanged']);
  for (const evt of [playheadEvent, selectionEvent]) {
    if (!evt) continue;
    try {
      ppro.EventManager.addEventListener(sequence, evt, pushTimelineState);
    } catch (error) {
      log('warn', `Subscribe to sequence.${evt} failed: ${error.message}`);
    }
  }
  state.subscribedSequenceId = seqId;
}

function startStatePushLoop() {
  stopStatePushLoop();
  state.pollTimer = setInterval(pushTimelineState, STATE_PUSH_INTERVAL_MS);
  pushTimelineState();
}

function stopStatePushLoop() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.lastSeqId = null;
  state.lastPlayheadSec = -1;
  state.lastHasSelection = null;
}

async function pushTimelineState() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;

  try {
    const { sequence } = await getActiveProjectAndSequence();
    if (!sequence) {
      sendStateIfDiff({ seqId: null, playheadSec: 0, hasSelection: false });
      return;
    }

    const seqId = await readValue(sequence, 'guid', '');
    if (seqId !== state.subscribedSequenceId) {
      // Active sequence changed under us without an event firing.
      state.staleReadsRemaining = 2;
      await attachSequenceListeners();
    }

    if (state.staleReadsRemaining > 0) {
      state.staleReadsRemaining -= 1;
      return; // skip — getPlayerPosition is stale per DVATA-1118
    }

    const posTime = await safeCall(sequence, 'getPlayerPosition', null);
    const playheadSec = await secondsFromTime(posTime);
    const selection = await safeCall(sequence, 'getSelection', null);
    const hasSelection = !!(selection && readSelectionItemCount(selection) > 0);

    sendStateIfDiff({ seqId, playheadSec, hasSelection });
  } catch (error) {
    log('warn', `pushTimelineState exception: ${error.message}`);
  }
}

function readSelectionItemCount(selection) {
  if (Array.isArray(selection)) return selection.length;
  if (Array.isArray(selection.itemIds)) return selection.itemIds.length;
  if (typeof selection.length === 'number') return selection.length;
  if (typeof selection.numItems === 'number') return selection.numItems;
  return 0;
}

function sendStateIfDiff(payload) {
  // Quantize playhead to 50ms — drops chatter from sub-frame jitter while
  // still feeling live on a 24fps timeline (≈42ms/frame).
  const quantized = Math.round((payload.playheadSec || 0) * 20) / 20;
  if (
    payload.seqId === state.lastSeqId &&
    quantized === state.lastPlayheadSec &&
    payload.hasSelection === state.lastHasSelection
  ) {
    return;
  }
  state.lastSeqId = payload.seqId;
  state.lastPlayheadSec = quantized;
  state.lastHasSelection = payload.hasSelection;

  send({
    kind: 'state',
    type: 'timelineState',
    seqId: payload.seqId,
    playheadSec: quantized,
    hasSelection: payload.hasSelection
  });
}

reconnectButton.addEventListener('click', () => {
  if (state.socket) state.socket.close();
  clearReconnect();
  connect();
});

refreshButton.addEventListener('click', sendSequenceInfo);

connect();
