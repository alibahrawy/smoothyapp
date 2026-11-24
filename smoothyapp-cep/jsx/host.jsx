/**
 * AutoCut - Premiere Pro ExtendScript
 *
 * Reads clips and tracks from the active Premiere project/sequence.
 * Gets file paths for processing by the Node.js server.
 */

// ---------------------------------------------------------------------------
// JSON Polyfill for Premiere Pro 2026+ where Adobe removed JSON from
// ExtendScript. This polyfill is only active when JSON is undefined.
// ---------------------------------------------------------------------------
if (typeof JSON === 'undefined') {
  JSON = {
    stringify: function(value) {
      if (value === null) return 'null';
      if (typeof value === 'undefined') return 'null';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'number') return isNaN(value) ? 'null' : String(value);
      if (typeof value === 'string') return '"' + value.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, function(c) {
        var m = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
        return m[c] || '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
      }) + '"';
      if (typeof value === 'function') return 'null';
      if (value && typeof value.toJSON === 'function') return JSON.stringify(value.toJSON());
      if (value instanceof Array || Object.prototype.toString.call(value) === '[object Array]') {
        var parts = [];
        for (var i = 0; i < value.length; i++) {
          parts.push(JSON.stringify(value[i]));
        }
        return '[' + parts.join(',') + ']';
      }
      var keys = [];
      for (var k in value) {
        if (value.hasOwnProperty(k)) {
          keys.push(JSON.stringify(String(k)) + ':' + JSON.stringify(value[k]));
        }
      }
      return '{' + keys.join(',') + '}';
    },
    parse: function(text) {
      if (typeof text !== 'string' || !text) return null;
      text = text.replace(/^[\s\xA0]+/, '').replace(/[\s\xA0]+$/, '');
      // Use eval for ExtendScript - safe because we control the input
      // Replace dangerous chars first as a basic guard
      var clean = text.replace(/\n|\r/g, '');
      return eval('(' + clean + ')');
    }
  };
}

var SMOOTHY_CEP_HOST_VERSION = "20261124-caption-styles-v45";

function getSmoothyCepHostVersion() {
  return SMOOTHY_CEP_HOST_VERSION;
}

// Preserve jobs when bridge.js reloads host.jsx before each request.
var SMOOTHY_MULTICAM_JOBS = typeof SMOOTHY_MULTICAM_JOBS === "undefined" ? {} : SMOOTHY_MULTICAM_JOBS;

function smoothyFindSequence(id) {
  if (!app.project || !app.project.sequences) return null;
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    var seq = app.project.sequences[i];
    if (String(seq.sequenceID) === String(id)) return seq;
  }
  return null;
}
function smoothyNameSequence(seq, name) {
  seq.name = name;
  // Updating both also updates the Project panel in Premiere versions that
  // keep the sequence and its projectItem names separately.
  if (seq.projectItem) seq.projectItem.name = name;
}
function smoothyMulticamJob(jobId) {
  var job = SMOOTHY_MULTICAM_JOBS[jobId];
  var clone = job ? smoothyFindSequence(job.cloneId) : null;
  if (!clone) throw new Error("The multicam duplicate or project was closed. Refresh Premiere and try again.");
  // Every later operation uses this captured duplicate, regardless of which
  // sequence the user views or edits. Only changes to the working copy can
  // invalidate the audio/camera snapshot analysed by Electron.
  if (smoothyTimelineRevision(clone, false) !== job.cloneRevision) throw new Error("The Multicam duplicate changed during analysis. Run Multicam again from your original timeline.");
  return job;
}
function smoothyMulticamIndices(indices, tracks) {
  if (!indices || !indices.length) throw new Error("Select microphone and camera tracks.");
  var seen = {};
  for (var i = 0; i < indices.length; i++) {
    var index = indices[i];
    if (typeof index !== "number" || index !== Math.floor(index) || index < 0 || index >= tracks.numTracks || seen[index] || !tracks[index].clips.numItems) throw new Error("The selected tracks changed. Refresh Premiere and try again.");
    seen[index] = true;
  }
}

/** Duplicate the complete timeline; never reconstruct ProjectItems from paths. */
function prepareMulticamTimeline(payloadJSON) {
  try {
    var payload = JSON.parse(payloadJSON), source = smoothyFindSequence(payload.sequenceId);
    if (!source) throw new Error("The selected Multicam sequence or project was closed. Refresh Premiere and run Multicam again.");
    var active = app.project.activeSequence, activeId = active ? String(active.sequenceID) : null;
    if (!/^[a-f0-9-]{36}$/.test(payload.jobId) || SMOOTHY_MULTICAM_JOBS[payload.jobId]) throw new Error("Invalid multicam session.");
    if (!payload.timelineRevision || smoothyTimelineRevision(source, false) !== payload.timelineRevision) throw new Error("The timeline changed. Refresh Premiere and run Multicam again.");
    smoothyMulticamIndices(payload.audioTrackIndices, source.audioTracks);
    smoothyMulticamIndices(payload.videoTrackIndices, source.videoTracks);
    var audioFolder = typeof payload.audioDirectory === "string" ? new Folder(payload.audioDirectory) : null;
    if (!audioFolder || !audioFolder.exists || !/^smoothyedit-multicam-[a-zA-Z0-9]+$/.test(audioFolder.name)) throw new Error("Refresh the updated SmoothyEdit app to create the Multicam audio folder.");
    var oldIds = {}, i;
    for (i = 0; i < app.project.sequences.numSequences; i++) oldIds[String(app.project.sequences[i].sequenceID)] = true;
    // clone() has returned a Sequence, Boolean or void across Premiere versions.
    // Find the new persistent ID instead of depending on that return value.
    source.clone();
    var clone = null;
    for (i = 0; i < app.project.sequences.numSequences; i++) {
      var candidate = app.project.sequences[i];
      if (!oldIds[String(candidate.sequenceID)]) {
        if (clone) throw new Error("Premiere created more than one sequence. Please inspect the Project panel.");
        clone = candidate;
      }
    }
    if (!clone || String(clone.sequenceID) === String(source.sequenceID)) throw new Error("Premiere could not duplicate the sequence.");
    var job = { sourceId: String(source.sequenceID), cloneId: String(clone.sequenceID),
      cloneRevision: smoothyTimelineRevision(clone, false), audioIndices: payload.audioTrackIndices, videoIndices: payload.videoTrackIndices,
      audioDirectory: audioFolder.fsName, files: [], editing: false, complete: false, name: String(payload.sequenceName || source.name + " - Auto-Switch").substring(0, 200) };
    SMOOTHY_MULTICAM_JOBS[payload.jobId] = job;
    smoothyNameSequence(clone, job.name + " (analysing)");
    var info = JSON.parse(getSequenceInfo(clone));
    if (!info.hasSequence || !(info.duration > 0) || !(info.fps > 0)) throw new Error(info.error || "Premiere could not read the duplicate.");
    // clone() may activate its result. Return to the sequence the user was
    // viewing; the job remains tied to the requested source and its duplicate.
    if (activeId && smoothyFindSequence(activeId)) app.project.openSequence(activeId);
    return JSON.stringify({ success: true, sequenceId: job.cloneId, duration: info.duration, fps: info.fps, videoTracks: info.videoTracks });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
}

function smoothyMulticamAudioPreset() {
  var root = Folder.appPackage.fsName;
  var roots = [root + "/MediaIO/systempresets/", root + "/Contents/MediaIO/systempresets/"];
  var formats = ["3F3F3F3F_57415645", "3F3F3F3F_4D503320", "58444341_4d703300"];
  for (var f = 0; f < formats.length; f++) for (var r = 0; r < roots.length; r++) {
    var folder = new Folder(roots[r] + formats[f]);
    if (folder.exists) {
      var presets = folder.getFiles("*.epr");
      if (presets.length) return presets[0].fsName;
    }
  }
  throw new Error("Premiere's built-in WAV/MP3 audio export preset was not found.");
}

/** Render a single microphone through Premiere, including nest and clip effects. */
function exportMulticamTimelineTrack(payloadJSON) {
  var seq = null, muted = [], activeId = null;
  try {
    var payload = JSON.parse(payloadJSON), job = smoothyMulticamJob(payload.jobId);
    var allowed = false;
    for (var a = 0; a < job.audioIndices.length; a++) if (job.audioIndices[a] === payload.trackIndex) allowed = true;
    if (!allowed) throw new Error("Choose a microphone from the analysed sequence.");
    seq = smoothyFindSequence(job.cloneId);
    if (app.project.activeSequence) activeId = String(app.project.activeSequence.sequenceID);
    var preset = smoothyMulticamAudioPreset();
    var extension = String(seq.getExportFileExtension(preset) || "wav").replace(/^\./, "").toLowerCase();
    if (!/^(wav|mp3)$/i.test(extension)) throw new Error("The audio export preset must produce WAV or MP3.");
    // Avoid Premiere's protected TemporaryItems folder: Electron creates and
    // supplies this per-job folder before asking Premiere to render.
    var file = new File(job.audioDirectory + "/microphone-" + payload.trackIndex + "." + extension);
    if (file.exists) throw new Error("The microphone audio file already exists. Run Multicam again.");
    job.files.push(file.fsName);
    app.project.openSequence(job.cloneId);
    if (!app.project.activeSequence || String(app.project.activeSequence.sequenceID) !== job.cloneId) throw new Error("Premiere could not open the Multicam duplicate for audio export.");
    for (var i = 0; i < seq.audioTracks.numTracks; i++) muted.push(seq.audioTracks[i].isMuted() ? 1 : 0);
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      seq.audioTracks[i].setMute(i === payload.trackIndex ? 0 : 1);
      if (!!seq.audioTracks[i].isMuted() !== (i !== payload.trackIndex)) throw new Error("Premiere could not isolate microphone A" + (payload.trackIndex + 1) + ".");
    }
    // ENCODE_ENTIRE includes leading silence and ignores the user's In/Out.
    // Premiere export return values vary; verify the actual new file instead.
    seq.exportAsMediaDirect(file.fsName, preset, 0);
    if (!file.exists || file.length <= 44) throw new Error("Premiere could not render microphone A" + (payload.trackIndex + 1) + ".");
    return JSON.stringify({ success: true, filePath: file.fsName, fileSize: file.length, duration: smoothySequenceDuration(seq) });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
  finally {
    if (seq) for (var t = 0; t < muted.length; t++) seq.audioTracks[t].setMute(muted[t]);
    if (activeId && smoothyFindSequence(activeId)) app.project.openSequence(activeId);
  }
}

/**
 * After editing, the topmost camera track must show the winning camera across
 * every camera range with nothing disabled underneath, while the lowest
 * camera track keeps the reverse angle it already had.
 */
function smoothyMulticamTrackIndices(indices) {
  var top = -1, bottom = -1;
  for (var i = 0; i < indices.length; i++) {
    var index = indices[i];
    if (top < 0 || index > top) top = index;
    if (bottom < 0 || index < bottom) bottom = index;
  }
  return { top: top, bottom: bottom };
}

/** A clip collection can be out of timeline order after a native move. */
function smoothyMulticamPiece(clip, frame) {
  return { start: frame(clip.start.seconds), end: frame(clip.end.seconds),
    itemId: String(clip.projectItem.nodeId), inTicks: String(clip.inPoint.ticks),
    outTicks: String(clip.outPoint.ticks), speed: clip.getSpeed(), disabled: !!clip.disabled };
}
function smoothyMulticamFindClip(seq, index, piece, offset, frame) {
  var clips = seq.videoTracks[index].clips;
  for (var i = 0; i < clips.numItems; i++) {
    var clip = clips[i];
    if (frame(clip.start.seconds) === piece.start + offset && frame(clip.end.seconds) === piece.end + offset &&
        String(clip.projectItem.nodeId) === piece.itemId && String(clip.inPoint.ticks) === piece.inTicks &&
        String(clip.outPoint.ticks) === piece.outTicks && clip.getSpeed() === piece.speed && !!clip.disabled === piece.disabled) return clip;
  }
  throw new Error("Premiere did not preserve the camera piece on V" + (index + 1) + " at frame " + (piece.start + offset) + ". The original is untouched; inspect the incomplete duplicate.");
}
function smoothyVerifyMulticamOutput(seq, indices, expected, frame) {
  for (var t = 0; t < indices.length; t++) {
    var index = indices[t], track = seq.videoTracks[index], pieces = expected[index];
    if (track.isMuted()) throw new Error("Camera V" + (index + 1) + " is hidden in the duplicate.");
    if (track.clips.numItems !== pieces.length) throw new Error("Premiere changed the camera coverage on V" + (index + 1) + ". The original is untouched; inspect the incomplete duplicate.");
    for (var p = 0; p < pieces.length; p++) smoothyMulticamFindClip(seq, index, pieces[p], 0, frame);
  }
}

/** Swap existing video pieces, keeping their effects and continuous audio. */
function applyMulticamTimelineCuts(payloadJSON) {
  var seq = null, zeroPoint = null, job = null, scratchIndex = -1, qeSeq = null, originalTrackCount = 0;
  try {
    var payload = JSON.parse(payloadJSON);
    job = smoothyMulticamJob(payload.jobId);
    seq = smoothyFindSequence(job.cloneId);
    var settings = seq.getSettings(), ticksPerFrame = Number(settings.videoFrameRate.ticks);
    if (!(ticksPerFrame > 0)) throw new Error("Premiere could not read the native frame rate.");
    var frame = function(seconds) { return Math.round(seconds * 254016000000 / ticksPerFrame); };
    var durationFrames = frame(smoothySequenceDuration(seq)), ranges = payload.ranges;
    if (!ranges || !ranges.length) throw new Error("No camera cuts were generated.");
    var validTracks = {}, previousEnd = 0, r, t, c;
    for (t = 0; t < job.videoIndices.length; t++) validTracks[job.videoIndices[t]] = true;
    for (r = 0; r < ranges.length; r++) {
      var range = ranges[r];
      if (range.startFrame !== previousEnd || range.endFrame !== Math.floor(range.endFrame) || range.endFrame <= range.startFrame || range.endFrame > durationFrames || (range.trackIndex !== -1 && !validTracks[range.trackIndex])) throw new Error("Invalid camera cut ranges.");
      previousEnd = range.endFrame;
    }
    if (previousEnd !== durationFrames) throw new Error("Camera decisions do not cover the full sequence.");
    var topIndex = smoothyMulticamTrackIndices(job.videoIndices).top;
    app.project.openSequence(job.cloneId);
    if (String(app.project.activeSequence.sequenceID) !== job.cloneId) throw new Error("Premiere could not open the duplicate for editing.");
    app.enableQE();
    qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) throw new Error("Premiere could not open the duplicate's video editing interface.");
    var audioBefore = smoothyTimelineRevision(seq, true);
    function verifyAudio() {
      if (smoothyTimelineRevision(seq, true) !== audioBefore) throw new Error("Premiere changed linked audio while cutting. The original is untouched; inspect the incomplete duplicate.");
    }
    zeroPoint = String(seq.zeroPoint);
    seq.setZeroPoint("0");
    job.editing = true;

    // Unlink only the duplicate's selected camera video. Native video-track
    // overwrites also insert audio and lose instance effects, so never use them.
    for (var g = 0; g < 2; g++) {
      var tracks = g ? seq.audioTracks : seq.videoTracks;
      for (t = 0; t < tracks.numTracks; t++) for (c = 0; c < tracks[t].clips.numItems; c++) tracks[t].clips[c].setSelected(false, false);
    }
    for (t = 0; t < job.videoIndices.length; t++) {
      var track = seq.videoTracks[job.videoIndices[t]];
      if (track.isMuted()) track.setMute(0);
      if (track.isMuted()) throw new Error("Premiere could not enable camera V" + (job.videoIndices[t] + 1) + ".");
      for (c = 0; c < track.clips.numItems; c++) track.clips[c].setSelected(true, false);
    }
    seq.unlinkSelection(); // false also means the clips were already unlinked.
    for (t = 0; t < job.videoIndices.length; t++) {
      var track = seq.videoTracks[job.videoIndices[t]];
      for (c = 0; c < track.clips.numItems; c++) track.clips[c].setSelected(false, false);
      for (r = 1; r < ranges.length; r++) {
        var cutTime = new Time(); cutTime.ticks = String(ranges[r].startFrame * ticksPerFrame);
        qeSeq.getVideoTrackAt(job.videoIndices[t]).razor(cutTime.getFormatted(settings.videoFrameRate, seq.videoDisplayFormat));
      }
    }
    verifyAudio();

    var originals = {}, expected = {};
    for (t = 0; t < job.videoIndices.length; t++) {
      var index = job.videoIndices[t], track = seq.videoTracks[index], parts = [];
      for (c = 0; c < track.clips.numItems; c++) {
        var piece = smoothyMulticamPiece(track.clips[c], frame);
        if (!(piece.end > piece.start)) throw new Error("Premiere returned an invalid camera piece.");
        for (r = 1; r < ranges.length; r++) if (piece.start < ranges[r].startFrame && piece.end > ranges[r].startFrame) throw new Error("Premiere did not cut camera V" + (index + 1) + " at frame " + ranges[r].startFrame + ".");
        parts.push(piece);
      }
      parts.sort(function(a, b) { return a.start - b.start; });
      originals[index] = parts; expected[index] = [];
    }
    function piecesIn(index, range) {
      var parts = [], all = originals[index];
      for (var i = 0; i < all.length; i++) if (all[i].start >= range.startFrame && all[i].end <= range.endFrame) parts.push(all[i]);
      return parts;
    }
    function requireCoverage(parts, range) {
      var cursor = range.startFrame;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].disabled) continue;
        if (parts[i].start !== cursor) break;
        cursor = parts[i].end;
      }
      if (cursor !== range.endFrame) throw new Error("The winning camera is missing footage at frame " + cursor + ". The original is untouched; inspect the incomplete duplicate.");
    }
    function moveTrack(from, to, piece, offset) {
      var track = qe.project.getActiveSequence().getVideoTrackAt(from), found = null;
      for (var i = 0; i < track.numItems; i++) {
        var item = track.getItemAt(i);
        if (item.type === "Clip" && Math.round(Number(item.start.ticks) / ticksPerFrame) === piece.start + offset && Math.round(Number(item.end.ticks) / ticksPerFrame) === piece.end + offset) { found = item; break; }
      }
      if (!found) throw new Error("Premiere could not locate camera V" + (from + 1) + " at frame " + piece.start + " for the video move. The original is untouched; inspect the incomplete duplicate.");
      if (typeof found.moveToTrack !== "function") throw new Error("This Premiere version does not expose camera track moves. The original is untouched; inspect the incomplete duplicate.");
      // Video track delta, zero audio track delta, zero time delta, move (not copy).
      found.moveToTrack(to - from, 0, "00:00:00:00", false);
      smoothyMulticamFindClip(seq, to, piece, offset, frame);
    }
    originalTrackCount = seq.videoTracks.numTracks;
    var originalTrackIds = [];
    for (t = 0; t < originalTrackCount; t++) originalTrackIds.push(String(seq.videoTracks[t].id));
    function ensureScratchTrack() {
      if (scratchIndex >= 0) return;
      if (typeof qeSeq.addTracks !== "function" || typeof qeSeq.removeVideoTrack !== "function") throw new Error("This Premiere version cannot swap camera video safely.");
      // Append one video-only track; never reuse or remove the user's tracks.
      // QE's second argument is the zero-based insertion position, not an
      // "insert after" index. Inserting at count - 1 shifts the last camera
      // into our supposed scratch slot and makes the camera lookup fail.
      qeSeq.addTracks(1, originalTrackCount, 0);
      if (seq.videoTracks.numTracks !== originalTrackCount + 1) throw new Error("Premiere could not create the temporary camera track.");
      for (var i = 0; i < originalTrackCount; i++) {
        if (String(seq.videoTracks[i].id) !== originalTrackIds[i]) throw new Error("Premiere shifted an existing video track while preparing the duplicate. The original is untouched; inspect the incomplete duplicate.");
      }
      if (seq.videoTracks[originalTrackCount].clips.numItems) throw new Error("Premiere did not append an empty temporary camera track. The original is untouched; inspect the incomplete duplicate.");
      scratchIndex = originalTrackCount;
      qeSeq = qe.project.getActiveSequence();
      verifyAudio();
    }
    function removeScratchTrack() {
      if (scratchIndex < 0) return;
      if (seq.videoTracks[scratchIndex].clips.numItems) throw new Error("Camera pieces remain on the temporary track. The original is untouched; inspect the incomplete duplicate.");
      qeSeq.removeVideoTrack(scratchIndex);
      if (seq.videoTracks.numTracks !== originalTrackCount) throw new Error("Premiere could not remove the empty temporary camera track.");
      scratchIndex = -1;
      verifyAudio();
    }
    for (r = 0; r < ranges.length; r++) {
      var range = ranges[r], winner = range.trackIndex;
      if (winner >= 0) requireCoverage(piecesIn(winner, range), range);
      for (t = 0; t < job.videoIndices.length; t++) {
        var index = job.videoIndices[t], sourceIndex = index;
        if (winner >= 0 && winner !== topIndex) {
          if (index === topIndex) sourceIndex = winner;
          else if (index === winner) sourceIndex = topIndex;
        }
        var assigned = piecesIn(sourceIndex, range);
        for (c = 0; c < assigned.length; c++) expected[index].push(assigned[c]);
      }
      if (winner < 0 || winner === topIndex) continue;
      var top = piecesIn(topIndex, range), chosen = piecesIn(winner, range);
      // Public TrackItem.move() can leave invisible, unselectable clips in
      // Premiere's timeline. Swap tracks at the same time instead, preserving
      // clip instances/effects and the timeline's native edit/display state.
      if (top.length) ensureScratchTrack();
      for (c = 0; c < top.length; c++) moveTrack(topIndex, scratchIndex, top[c], 0);
      for (c = 0; c < chosen.length; c++) moveTrack(winner, topIndex, chosen[c], 0);
      for (c = 0; c < top.length; c++) moveTrack(scratchIndex, winner, top[c], 0);
      verifyAudio();
    }
    removeScratchTrack();
    smoothyVerifyMulticamOutput(seq, job.videoIndices, expected, frame);
    verifyAudio();
    smoothyNameSequence(seq, job.name);
    job.complete = true;
    return JSON.stringify({ success: true, sequenceId: job.cloneId, sequenceName: job.name, verifiedRanges: ranges.length });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
  finally {
    // Remove only our appended track if empty. On a partial swap retain its
    // surviving video for recovery rather than discarding the reverse angle.
    if (seq && scratchIndex >= 0 && seq.videoTracks.numTracks === originalTrackCount + 1 && !seq.videoTracks[scratchIndex].clips.numItems) {
      try { qeSeq.removeVideoTrack(scratchIndex); } catch (cleanupError) {}
    }
    if (seq && zeroPoint !== null) seq.setZeroPoint(zeroPoint);
  }
}

function discardMulticamTimeline(payloadJSON) {
  try {
    var payload = JSON.parse(payloadJSON), job = SMOOTHY_MULTICAM_JOBS[payload.jobId];
    if (!job) return JSON.stringify({ success: true });
    for (var f = 0; f < job.files.length; f++) {
      try { var file = new File(job.files[f]); if (file.exists) file.remove(); } catch (error) {}
    }
    var clone = smoothyFindSequence(job.cloneId);
    if (clone && !job.complete) {
      smoothyNameSequence(clone, job.name + " (incomplete)");
      if (app.project.activeSequence && String(app.project.activeSequence.sequenceID) === job.cloneId && smoothyFindSequence(job.sourceId)) app.project.openSequence(job.sourceId);
    }
    delete SMOOTHY_MULTICAM_JOBS[payload.jobId];
    return JSON.stringify({ success: true });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
}

function getSmoothyMarkerDiagnostics() {
  try {
    var project = app.project;
    var seq = project ? project.activeSequence : null;
    var payload = $.global.SMOOTHY_MARKER_PAYLOAD_ENCODED || "";
    return "hostVersion=" + SMOOTHY_CEP_HOST_VERSION +
      ";hasProject=" + (!!project) +
      ";hasSequence=" + (!!seq) +
      ";hasMarkers=" + (!!(seq && seq.markers)) +
      ";markerCount=" + (seq && seq.markers ? seq.markers.numMarkers : -1) +
      ";payloadLength=" + payload.length +
      ";hasAddFunction=" + (typeof addMarkersFromStagedWebsitePayload === "function");
  } catch (e) {
    return "hostVersion=" + SMOOTHY_CEP_HOST_VERSION + ";diagnosticsError=" + e.message;
  }
}

/**
 * Get all video clips from the project panel
 * Returns JSON array of clip info
 */
function getProjectClips() {
  try {
    var project = app.project;
    if (!project) {
      return JSON.stringify({ error: "No project open" });
    }

    var clips = [];
    scanBinForClips(project.rootItem, clips);

    return JSON.stringify(clips);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Recursively scan bins for media clips
 */
function scanBinForClips(bin, clips) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var item = bin.children[i];

    if (item.type === ProjectItemType.BIN) {
      // Recurse into bins
      scanBinForClips(item, clips);
    } else if (item.type === ProjectItemType.CLIP) {
      // Get clip info
      var mediaPath = item.getMediaPath();
      if (mediaPath) {
        clips.push({
          name: item.name,
          path: mediaPath,
          nodeId: item.nodeId
        });
      }
    }
  }
}

/**
 * Get audio tracks from the active sequence
 * Returns info about each audio track and its clips
 */
function getSequenceAudioTracks() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ error: "No active sequence. Open a sequence first." });
    }

    var tracks = [];
    var audioTracks = seq.audioTracks;

    for (var i = 0; i < audioTracks.numTracks; i++) {
      var track = audioTracks[i];
      var trackInfo = {
        index: i,
        name: track.name || ("Audio " + (i + 1)),
        clips: []
      };

      // Get clips on this track
      for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        var projectItem = clip.projectItem;

        if (projectItem) {
          var mediaPath = projectItem.getMediaPath();
          trackInfo.clips.push({
            name: clip.name,
            path: mediaPath,
            start: clip.start.seconds,
            end: clip.end.seconds,
            inPoint: clip.inPoint.seconds,
            outPoint: clip.outPoint.seconds
          });
        }
      }

      tracks.push(trackInfo);
    }

    return JSON.stringify({
      sequenceName: seq.name,
      duration: seq.end.seconds,
      audioTracks: tracks
    });

  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Get video tracks from the active sequence
 */
function getSequenceVideoTracks() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ error: "No active sequence" });
    }

    var tracks = [];
    var videoTracks = seq.videoTracks;

    for (var i = 0; i < videoTracks.numTracks; i++) {
      var track = videoTracks[i];
      var trackInfo = {
        index: i,
        name: track.name || ("Video " + (i + 1)),
        clips: []
      };

      for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        var projectItem = clip.projectItem;

        if (projectItem) {
          var mediaPath = projectItem.getMediaPath();
          trackInfo.clips.push({
            name: clip.name,
            path: mediaPath,
            start: clip.start.seconds,
            end: clip.end.seconds
          });
        }
      }

      tracks.push(trackInfo);
    }

    return JSON.stringify({
      sequenceName: seq.name,
      videoTracks: tracks
    });

  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Get complete sequence info including both audio and video tracks
 */
function smoothyMediaFrameRate(projectItem) {
  try { return Number(projectItem.getFootageInterpretation().frameRate) || null; } catch (error) { return null; }
}
function smoothyMediaPath(projectItem) {
  try { return projectItem.getMediaPath() || ""; } catch (error) { return ""; }
}
function smoothySequenceDuration(seq) {
  // Some CEP versions expose end as absolute ticks, including start timecode.
  // Clip positions are always on the timeline clock and disambiguate it.
  var raw = seq.end && typeof seq.end.seconds !== "undefined" ? Number(seq.end.seconds) : Number(seq.end) / 254016000000;
  var lastClip = 0;
  var groups = [seq.videoTracks, seq.audioTracks];
  for (var g = 0; g < groups.length; g++) for (var t = 0; t < groups[g].numTracks; t++) {
    var clips = groups[g][t].clips;
    for (var c = 0; c < clips.numItems; c++) lastClip = Math.max(lastClip, Number(clips[c].end.seconds));
  }
  var offset = Number(seq.zeroPoint) / 254016000000;
  if (offset > 0 && raw >= offset && Math.abs(raw - offset - lastClip) < Math.abs(raw - lastClip)) raw -= offset;
  return Math.max(lastClip, isFinite(raw) ? raw : 0);
}
function smoothyTimelineRevision(seq, audioOnly) {
  var groups = audioOnly ? [seq.audioTracks] : [seq.videoTracks, seq.audioTracks];
  // Parking video can temporarily extend the sequence; that is not an audio edit.
  var value = audioOnly ? [String(seq.timebase)] : [String(seq.timebase), smoothySequenceDuration(seq)];
  for (var g = 0; g < groups.length; g++) {
    var tracks = groups[g], trackValues = [];
    for (var t = 0; t < tracks.numTracks; t++) {
      var track = tracks[t], clips = [];
      for (var c = 0; c < track.clips.numItems; c++) {
        var item = track.clips[c], speed = 1;
        try { speed = item.getSpeed(); } catch (error) {}
        clips.push([item.name, item.projectItem ? String(item.projectItem.nodeId) : "", item.start.seconds, item.end.seconds, item.inPoint.seconds, item.outPoint.seconds, !!item.disabled, speed]);
      }
      var muted = false;
      try { muted = !!track.isMuted(); } catch (error) {}
      trackValues.push([track.name, muted, clips]);
    }
    value.push(trackValues);
  }
  return JSON.stringify(value);
}
function getSequenceInfo(sequenceOverride) {
  try {
    var seq = sequenceOverride || app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ hasSequence: false, error: "No active sequence" });
    }

    var settings = seq.getSettings();

    var info = {
      hasSequence: true,
      name: seq.name,
      id: seq.sequenceID,
      duration: smoothySequenceDuration(seq),
      fps: settings.videoFrameRate ? (1 / settings.videoFrameRate.seconds) : 30,
      width: settings.videoFrameWidth,
      height: settings.videoFrameHeight,
      markerCount: seq.markers.numMarkers,
      audioTracks: [],
      videoTracks: [],
      multicamTimelineVersion: 7,
      timelineRevision: smoothyTimelineRevision(seq, false)
    };

    // Get audio tracks
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      var aTrack = seq.audioTracks[i];
      var aTrackInfo = {
        index: i,
        name: aTrack.name || ("Audio " + (i + 1)),
        clips: []
      };

      for (var j = 0; j < aTrack.clips.numItems; j++) {
        var aClip = aTrack.clips[j];
        if (aClip.projectItem) {
          aTrackInfo.clips.push({
            name: aClip.name,
            path: smoothyMediaPath(aClip.projectItem),
            start: aClip.start.seconds,
            end: aClip.end.seconds,
            inPoint: aClip.inPoint.seconds,
            outPoint: aClip.outPoint.seconds,
            reversed: aClip.isSpeedReversed(),
            disabled: aClip.disabled
          });
        }
      }

      if (aTrackInfo.clips.length > 0) {
        info.audioTracks.push(aTrackInfo);
      }
    }

    // Get video tracks
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var vTrack = seq.videoTracks[i];
      var vTrackInfo = {
        index: i,
        name: vTrack.name || ("Video " + (i + 1)),
        clips: []
      };

      for (var j = 0; j < vTrack.clips.numItems; j++) {
        var vClip = vTrack.clips[j];
        if (vClip.projectItem) {
          vTrackInfo.clips.push({
            name: vClip.name,
            path: smoothyMediaPath(vClip.projectItem),
            mediaFps: smoothyMediaFrameRate(vClip.projectItem),
            start: vClip.start.seconds,
            end: vClip.end.seconds,
            inPoint: vClip.inPoint.seconds,
            outPoint: vClip.outPoint.seconds,
            reversed: vClip.isSpeedReversed(),
            disabled: vClip.disabled
          });
        }
      }

      if (vTrackInfo.clips.length > 0) {
        info.videoTracks.push(vTrackInfo);
      }
    }

    return JSON.stringify(info);

  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Import an FCP XML file into the current project
 */
function importFCPXML(xmlPath) {
  try {
    var project = app.project;
    if (!project) {
      return JSON.stringify({ success: false, error: "No project is open" });
    }

    var xmlFile = new File(xmlPath);
    if (!xmlFile.exists) {
      return JSON.stringify({ success: false, error: "XML file not found: " + xmlPath });
    }

    var importSuccess = project.importFiles(
      [xmlPath],
      true,
      project.rootItem,
      false
    );

    if (importSuccess) {
      return JSON.stringify({ success: true });
    } else {
      return JSON.stringify({ success: false, error: "XML import failed" });
    }

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Import a PNG/image into the project and place it at the playhead on the
 * topmost video track. Used by the desktop app's Assets tab (SVG -> PNG).
 */
function importStockFootageToProject(filePath) {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "Open a Premiere project first." });
    if (!filePath || !/\.mp4$/i.test(filePath) || !(new File(filePath)).exists) return JSON.stringify({ success: false, error: "Stock footage MP4 not found." });
    var imported = app.project.importFiles([filePath], true, app.project.rootItem, false);
    return JSON.stringify(imported ? { success: true, message: "Video imported into the Project panel." } : { success: false, error: "Premiere could not import this MP4." });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
}

function importAudioLibraryToProject(filePath) {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "Open a Premiere project first." });
    if (!filePath || !/\.mp3$/i.test(filePath) || !(new File(filePath)).exists) return JSON.stringify({ success: false, error: "Audio Library MP3 not found." });
    var imported = app.project.importFiles([filePath], true, app.project.rootItem, false);
    return JSON.stringify(imported ? { success: true, message: "Audio imported into the Project panel." } : { success: false, error: "Premiere could not import this MP3." });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
}

function importImageToTimeline(imagePath, durationSeconds) {
  try {
    var project = app.project;
    if (!project) {
      return JSON.stringify({ success: false, error: "No project is open" });
    }

    var seq = project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    if (!imagePath) {
      return JSON.stringify({ success: false, error: "No image path provided" });
    }

    var imageFile = new File(imagePath);
    if (!imageFile.exists) {
      return JSON.stringify({ success: false, error: "Image file not found: " + imagePath });
    }

    var duration = parseFloat(durationSeconds);
    if (!isFinite(duration) || duration <= 0) duration = 5;

    // Import into the project root bin so the media is reusable.
    var importSuccess = project.importFiles([imagePath], true, project.rootItem, false);
    if (!importSuccess) {
      return JSON.stringify({ success: false, error: "Premiere could not import the image" });
    }

    // Locate the freshly imported project item.
    var fileName = imageFile.name;
    var fileNameNoExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
    var imageItem = null;
    for (var i = project.rootItem.children.numItems - 1; i >= 0; i--) {
      var child = project.rootItem.children[i];
      var childNoExt = child.name.substring(0, child.name.lastIndexOf('.')) || child.name;
      if (child.name === fileName || childNoExt === fileNameNoExt) {
        imageItem = child;
        break;
      }
    }

    if (!imageItem) {
      return JSON.stringify({
        success: true,
        message: "Image imported into the project. Drag '" + fileName + "' onto your sequence."
      });
    }

    // Set source in/out so the still has an explicit duration (media type 1 = video).
    try {
      var inTime = new Time();
      inTime.seconds = 0;
      var outTime = new Time();
      outTime.seconds = duration;
      imageItem.setInPoint(inTime.ticks, 1);
      imageItem.setOutPoint(outTime.ticks, 1);
    } catch (trimErr) {
      // Non-fatal: Premiere's default still duration will be used.
    }

    if (seq.videoTracks.numTracks < 1) {
      return JSON.stringify({
        success: true,
        message: "Image imported into the project. Add a video track to place it on the timeline."
      });
    }

    var targetTrack = seq.videoTracks[seq.videoTracks.numTracks - 1];
    var playhead = seq.getPlayerPosition();
    var insertTicks = playhead ? playhead.ticks : "0";

    var placed = false;
    try {
      targetTrack.overwriteClip(imageItem, insertTicks);
      placed = true;
    } catch (overwriteErr) {
      try {
        targetTrack.insertClip(imageItem, insertTicks);
        placed = true;
      } catch (insertErr) {
        // Fall through to the manual-drag message.
      }
    }

    if (!placed) {
      return JSON.stringify({
        success: true,
        message: "Image imported into the project. Drag '" + fileName + "' onto your sequence to place it."
      });
    }

    return JSON.stringify({
      success: true,
      message: "Image placed at the playhead on V" + seq.videoTracks.numTracks + "."
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: "importImageToTimeline: " + e.message });
  }
}

/**
 * Open file browser (fallback)
 */
function browseForMediaFile() {
  var file = File.openDialog("Select Media File", "Media:*.mp4;*.mov;*.mxf;*.wav;*.mp3");
  if (file) {
    return file.fsName;
  }
  return null;
}

/**
 * Remove silence segments using QE DOM (ripple delete)
 * silenceSegmentsJSON: JSON array of {start: seconds, end: seconds, duration: seconds}
 * Segments MUST be processed from END to START to preserve timecodes
 */
function removeSilenceWithQE(silenceSegmentsJSON) {
  try {
    // Enable QE DOM
    app.enableQE();

    var seq = app.project.activeSequence;
    var qeSeq = qe.project.getActiveSequence();

    if (!seq || !qeSeq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    var payload = JSON.parse(silenceSegmentsJSON);
    if (!payload.sequenceId || String(seq.sequenceID) !== String(payload.sequenceId)) {
      return JSON.stringify({ success: false, error: "The active sequence changed. Return to the analyzed sequence and run Silence Removal again." });
    }
    var segments = payload.segments;
    if (!segments || segments.length === 0) {
      return JSON.stringify({ success: false, error: "No silence segments provided" });
    }

    // Sort segments in DESCENDING order by start time - critical!
    segments.sort(function (a, b) { return b.start - a.start; });

    var removedCount = 0;
    var errors = [];

    // Get the sequence's ticks per frame for precise frame alignment
    var seqSettings = seq.getSettings();
    var ticksPerFrame = seqSettings.videoFrameRate.ticks;

    for (var s = 0; s < segments.length; s++) {
      var segment = segments[s];

      try {
        if (segment.start >= 0 && segment.end > segment.start) {
          // Use Time objects and let Premiere handle the conversion
          var inTime = new Time();
          inTime.seconds = segment.start;
          var outTime = new Time();
          outTime.seconds = segment.end;

          // Snap to frame boundaries using Premiere's native tick system.
          // No extra buffer: the previous 2-frame padding on each side ate
          // content around every cut.
          var inTicks = Math.floor(inTime.ticks / ticksPerFrame) * ticksPerFrame;
          if (inTicks < 0) inTicks = 0;

          var outTicks = Math.ceil(outTime.ticks / ticksPerFrame) * ticksPerFrame;

          seq.setInPoint(inTicks.toString());
          seq.setOutPoint(outTicks.toString());
          qeSeq.extract();
          removedCount++;
        }
      } catch (segErr) {
        errors.push("Segment " + s + ": " + segErr.message);
      }
    }

    // Clear in/out points
    try {
      seq.setInPoint("-1");
      seq.setOutPoint("-1");
    } catch (clearErr) { }

    var msg = "Removed " + removedCount + " of " + segments.length + " silence segments";

    return JSON.stringify({
      success: removedCount > 0,
      message: msg,
      removedCount: removedCount
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Export sequence audio to a temporary file for the CEP panel.
 * The panel reads/base64-encodes it with Node so Premiere's scripting engine
 * never has to process a large binary string.
 */
function exportSequenceAudio() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    // Get sequence duration
    var duration = seq.end.seconds;

    // Create temp file path for audio export
    var tempFolder = Folder.temp;
    var timestamp = new Date().getTime();
    var audioFile = new File(tempFolder.fsName + "/smoothyedit_audio_" + timestamp + ".mp3");

    // Prefer the built-in MP3 audio presets. This avoids exporting video.
    var presetPath = "";

    // Try to find an audio preset (check both Windows/root and macOS Contents/ paths)
    var presetRoots = [
      Folder.appPackage.fsName + "/MediaIO/systempresets/58444341_4d703300/",
      Folder.appPackage.fsName + "/Contents/MediaIO/systempresets/58444341_4d703300/"
    ];
    for (var pIdx = 0; pIdx < presetRoots.length && !presetPath; pIdx++) {
      var presetsFolder = new Folder(presetRoots[pIdx]);
      if (presetsFolder.exists) {
        var presets = presetsFolder.getFiles("*.epr");
        if (presets.length > 0) {
          presetPath = presets[0].fsName;
        }
      }
    }

    if (!presetPath) {
      return JSON.stringify({ success: false, error: "No built-in MP3 audio preset was found." });
    }

    try {
      var extension = seq.getExportFileExtension ? seq.getExportFileExtension(presetPath) : "mp3";
      if (extension) {
        extension = String(extension).replace(/^\./, "");
        audioFile = new File(tempFolder.fsName + "/smoothyedit_audio_" + timestamp + "." + extension);
      }
      var exportSuccess = seq.exportAsMediaDirect(audioFile.fsName, presetPath, 0);
      if (!exportSuccess || !audioFile.exists) {
        return JSON.stringify({ success: false, error: "Premiere could not export sequence audio with its MP3 preset." });
      }
      return JSON.stringify({
        success: true,
        filePath: audioFile.fsName,
        fileName: audioFile.name,
        fileSize: audioFile.length,
        duration: duration
      });
    } catch (exportErr) {
      return JSON.stringify({
        success: false,
        error: "Could not export audio: " + exportErr.message
      });
    }

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Convert binary string to base64
 */
function binaryToBase64(binary) {
  var base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var result = "";
  var i = 0;

  while (i < binary.length) {
    var byte1 = binary.charCodeAt(i++) & 0xFF;
    var byte2 = i < binary.length ? binary.charCodeAt(i++) & 0xFF : 0;
    var byte3 = i < binary.length ? binary.charCodeAt(i++) & 0xFF : 0;

    var enc1 = byte1 >> 2;
    var enc2 = ((byte1 & 3) << 4) | (byte2 >> 4);
    var enc3 = ((byte2 & 15) << 2) | (byte3 >> 6);
    var enc4 = byte3 & 63;

    if (i - 2 > binary.length) {
      enc3 = enc4 = 64;
    } else if (i - 1 > binary.length) {
      enc4 = 64;
    }

    result += base64Chars.charAt(enc1) + base64Chars.charAt(enc2) +
      (enc3 === 64 ? "=" : base64Chars.charAt(enc3)) +
      (enc4 === 64 ? "=" : base64Chars.charAt(enc4));
  }

  return result;
}

/**
 * Add markers from website to sequence
 * markersJSON: array of {time, endTime, name, comment}
 * Creates TWO markers per short - one at start, one at end - with matching colors
 * Each short gets a different color to visually distinguish them
 */
function addMarkersFromWebsiteEncoded(encodedMarkersJSON) {
  try {
    return addMarkersFromWebsite(decodeURIComponent(encodedMarkersJSON));
  } catch (e) {
    return JSON.stringify({ success: false, error: "Failed to decode marker payload: " + e.message });
  }
}

function addMarkersFromStagedWebsitePayload() {
  try {
    var encodedMarkersJSON = $.global.SMOOTHY_MARKER_PAYLOAD_ENCODED || "";
    $.global.SMOOTHY_MARKER_PAYLOAD_ENCODED = "";
    return addMarkersFromWebsiteEncoded(encodedMarkersJSON);
  } catch (e) {
    return JSON.stringify({ success: false, error: "Failed to read staged marker payload: " + e.message });
  }
}

function addMarkersFromWebsite(markersJSON) {
  try {
    var project = app.project;
    var seq = project.activeSequence;

    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    var markers = JSON.parse(markersJSON);
    if (!markers || markers.length === 0) {
      return JSON.stringify({ success: false, error: "No markers provided" });
    }

    var addedCount = 0;
    var seqMarkers = seq.markers;

    // Available marker colors (0-7 in Premiere Pro)
    // 0=Green, 1=Red, 2=Purple, 3=Orange, 4=Yellow, 5=White, 6=Blue, 7=Cyan
    var colors = [0, 1, 2, 3, 4, 6, 7]; // Skip white (5) as it's hard to see

    function parseTimeValue(value) {
      if (value === null || value === undefined) return 0;
      if (typeof value === "number") return value;
      if (typeof value !== "string") return 0;

      var raw = value.replace(/,/g, ".");
      if (raw.indexOf(":") !== -1) {
        var parts = raw.split(":");
        var seconds = 0;
        for (var p = 0; p < parts.length; p++) {
          var part = parseFloat(parts[p]);
          if (isNaN(part)) return 0;
          seconds = seconds * 60 + part;
        }
        return seconds;
      }

      var num = parseFloat(raw);
      return isNaN(num) ? 0 : num;
    }

    function formatDuration(secs) {
      var mins = Math.floor(secs / 60);
      var s = Math.floor(secs % 60);
      return mins > 0 ? mins + "m " + s + "s" : s + "s";
    }

    function safeMarkerTime(value) {
      var seconds = parseTimeValue(value);
      if (isNaN(seconds) || seconds < 0) return 0;
      return seconds;
    }

    function safeSetMarkerName(marker, value) {
      try {
        marker.name = String(value).replace(/[^\x20-\x7E]/g, "").substring(0, 80);
      } catch (nameErr) {
        // Marker creation is more important than display text.
      }
    }

    function safeSetMarkerColor(marker, colorIndex) {
      if (!marker) return false;
      try {
        // Premiere 2026+ changed the marker color API.
        // Try multiple approaches and use the first one that works.
        var methodsTried = [];

        // Method 1: setColorByIndex() method (older Premiere)
        if (typeof marker.setColorByIndex === 'function') {
          marker.setColorByIndex(colorIndex);
          methodsTried.push('setColorByIndex');
          return true;
        }

        // Method 2: color property (Premiere 2024+)
        if ('color' in marker) {
          marker.color = colorIndex;
          methodsTried.push('colorProperty');
          return true;
        }

        // Method 3: setColor() method (alternative)
        if (typeof marker.setColor === 'function') {
          marker.setColor(colorIndex);
          methodsTried.push('setColor');
          return true;
        }

        // Method 4: colorIndex property
        if ('colorIndex' in marker) {
          marker.colorIndex = colorIndex;
          methodsTried.push('colorIndexProperty');
          return true;
        }

        return false;
      } catch (e) {
        return false;
      }
    }

    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];

      try {
        // Parse times
        var startTime = safeMarkerTime(m.time !== undefined ? m.time : (m.startTime !== undefined ? m.startTime : m.start));
        var rawEnd = m.endTime !== undefined ? m.endTime : (m.end !== undefined ? m.end : (m.outTime !== undefined ? m.outTime : m.out));
        var hasExplicitEnd = rawEnd !== undefined && rawEnd !== null && rawEnd !== "";
        var endTime = hasExplicitEnd ? safeMarkerTime(rawEnd) : 0;

        // Pick a color for this marker (cycles through 7 distinct colors unless caller chose one)
        var colorIndex = (typeof m.color === "number" && !isNaN(m.color)) ? m.color : colors[i % colors.length];
        var customName = typeof m.name === "string" ? m.name.replace(/^\s+|\s+$/g, "") : "";
        var customComment = typeof m.comment === "string" ? m.comment.replace(/^\s+|\s+$/g, "") : "";

        if (customName) {
          // Named/agent marker: create one marker preserving name, comment, and optional duration.
          var namedMarker = seqMarkers.createMarker(startTime);
          if (namedMarker) {
            safeSetMarkerName(namedMarker, customName);
            namedMarker.comments = customComment
              ? (customComment.indexOf("[SmoothyEdit]") === 0 ? customComment : "[SmoothyEdit] " + customComment)
              : "[SmoothyEdit]";
            if (hasExplicitEnd && endTime > startTime) {
              try { namedMarker.end = endTime; } catch (e) {}
            }
            safeSetMarkerColor(namedMarker, colorIndex);
            addedCount++;
          }
        } else {
          // Best Shorts pair: START + END markers
          if (endTime <= 0 || endTime <= startTime) {
            endTime = startTime + 60; // Default 60 second duration
          }
          var shortNum = i + 1;
          var shortName = "Short " + shortNum;

          var startMarker = seqMarkers.createMarker(startTime);
          if (startMarker) {
            safeSetMarkerName(startMarker, "START: " + shortName);
            startMarker.comments = customComment ? ("[SmoothyEdit] " + customComment) : "[SmoothyEdit] Short start";
            safeSetMarkerColor(startMarker, colorIndex);
            addedCount++;
          }

          var endMarker = seqMarkers.createMarker(endTime);
          if (endMarker) {
            safeSetMarkerName(endMarker, "END: " + shortName);
            endMarker.comments = "[SmoothyEdit] Short end";
            safeSetMarkerColor(endMarker, colorIndex);
            addedCount++;
          }
        }

      } catch (markerErr) {
        // Continue with next marker
      }
    }

    // Diagnostic: check what marker methods are available
    var markerMethods = [];
    try {
      var testMarker = seqMarkers.createMarker(0);
      if (testMarker) {
        if (typeof testMarker.setColorByIndex === 'function') markerMethods.push('setColorByIndex');
        if ('color' in testMarker) markerMethods.push('color');
        if (typeof testMarker.setColor === 'function') markerMethods.push('setColor');
        if ('colorIndex' in testMarker) markerMethods.push('colorIndex');
        seqMarkers.deleteMarker(testMarker);
      }
    } catch (e) {}

    return JSON.stringify({
      success: addedCount > 0,
      count: addedCount,
      message: "Added " + addedCount + " markers (" + markers.length + " shorts x 2)",
      markerMethods: markerMethods
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Clear all markers from the active sequence
 */
function clearAllMarkers(scope, sequenceId) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
    if (sequenceId && String(seq.sequenceID) !== String(sequenceId)) {
      return JSON.stringify({ success: false, error: "The active sequence changed. Refresh before clearing markers." });
    }
    var targets = [];
    var marker = seq.markers.getFirstMarker();
    while (marker) {
      if (scope === "all" || String(marker.comments || "").indexOf("[SmoothyEdit]") === 0) targets.push(marker);
      marker = seq.markers.getNextMarker(marker);
    }
    for (var index = targets.length - 1; index >= 0; index--) seq.markers.deleteMarker(targets[index]);
    return JSON.stringify({ success: true, count: targets.length, message: "Cleared " + targets.length + " markers" });
  } catch (error) { return JSON.stringify({ success: false, error: error.message }); }
}

/**
 * Cut out marked shorts - removes content OUTSIDE shorts, keeps gaps.
 *
 * Strategy (two-pass):
 *  Pass 1: Use proven extract() to remove all gap regions (end-to-start).
 *          After this, shorts are adjacent but AV stays in sync.
 *  Pass 2: Shift shorts back to their original timeline positions
 *          by moving clips on all tracks, reinstating the gaps.
 */
function cutMarkedShorts(optionsStr) {
  try {
    var options = {};
    if (optionsStr) {
      try { options = JSON.parse(optionsStr); } catch (e) { }
    }

    var project = app.project;
    var seq = project.activeSequence;

    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      return JSON.stringify({ success: false, error: "Could not get QE sequence" });
    }

    var markers = seq.markers;
    if (markers.numMarkers === 0) {
      return JSON.stringify({ success: false, error: "No markers found in sequence" });
    }

    // Collect shorts from markers
    var shorts = [];
    var currentShort = null;

    var currentMarker = markers.getFirstMarker();
    while (currentMarker) {
      var name = currentMarker.name || "";
      if (name.indexOf("START:") > -1) {
        currentShort = { start: currentMarker.start.seconds, end: -1 };
      } else if (name.indexOf("END:") > -1 && currentShort !== null) {
        currentShort.end = currentMarker.start.seconds;
        shorts.push(currentShort);
        currentShort = null;
      }
      currentMarker = markers.getNextMarker(currentMarker);
    }

    if (shorts.length === 0) {
      return JSON.stringify({ success: false, error: "No complete short marker pairs found" });
    }

    shorts.sort(function(a, b) { return a.start - b.start; });

    var debugLogs = [];
    debugLogs.push("Found " + shorts.length + " shorts");

    var seqSettings = seq.getSettings();
    var ticksPerFrame = seqSettings.videoFrameRate.ticks;

    // Optional: thumbnail insertion
    if (options.thumbnailPath) {
      try {
        var twoFramesTicks = ticksPerFrame * 2;
        var importSuccess = project.importFiles([options.thumbnailPath], true, project.rootItem, false);
        if (importSuccess) {
          var fileName = options.thumbnailPath.substring(options.thumbnailPath.replace(/\\/g, "/").lastIndexOf("/") + 1);
          var imageItem = null;
          for (var fi = 0; fi < project.rootItem.children.numItems; fi++) {
            var fItem = project.rootItem.children[fi];
            var itemNameNoExt = fItem.name.substring(0, fItem.name.lastIndexOf('.')) || fItem.name;
            var fileNameNoExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
            if (fItem.name === fileName || itemNameNoExt === fileNameNoExt) {
              imageItem = fItem;
              break;
            }
          }
          if (imageItem && seq.videoTracks.numTracks > 0) {
            var thumbIn = new Time(); thumbIn.seconds = 0;
            var thumbOut = new Time(); thumbOut.ticks = String(twoFramesTicks);
            imageItem.setInPoint(thumbIn.ticks, 1);
            imageItem.setOutPoint(thumbOut.ticks, 1);
            var targetTrack = seq.videoTracks[seq.videoTracks.numTracks - 1];
            for (var ti = 0; ti < shorts.length; ti++) {
              var insertTime = new Time();
              insertTime.seconds = shorts[ti].start;
              try { targetTrack.overwriteClip(imageItem, insertTime.ticks); } catch (e) {}
            }
          }
        }
      } catch (e) { debugLogs.push("Thumbnail: " + e.message); }
    }

    // Build gap regions (everything NOT inside a short)
    var removeSegments = [];
    var seqEndSecs = seq.end.seconds;

    // Gap before first short
    if (shorts[0].start > 0.1) {
      removeSegments.push({ start: 0, end: shorts[0].start });
    }
    // Gaps between shorts
    for (var i = 0; i < shorts.length - 1; i++) {
      var gapStart = shorts[i].end;
      var gapEnd = shorts[i + 1].start;
      if (gapEnd > gapStart + 0.1) {
        removeSegments.push({ start: gapStart, end: gapEnd });
      }
    }
    // Gap after last short
    var lastShortEnd = shorts[shorts.length - 1].end;
    if (seqEndSecs > lastShortEnd + 0.1) {
      removeSegments.push({ start: lastShortEnd, end: seqEndSecs });
    }

    // Sort DESCENDING so we extract from end first (preserves earlier timecodes)
    removeSegments.sort(function(a, b) { return b.start - a.start; });
    debugLogs.push(removeSegments.length + " gaps to extract");

    var extractedCount = 0;

    for (var s = 0; s < removeSegments.length; s++) {
      var seg = removeSegments[s];
      var inTime = new Time();
      inTime.seconds = seg.start;
      var outTime = new Time();
      outTime.seconds = seg.end;

      var inTicks = Math.floor(inTime.ticks / ticksPerFrame) * ticksPerFrame;
      if (inTicks < 0) inTicks = 0;
      var outTicks = Math.ceil(outTime.ticks / ticksPerFrame) * ticksPerFrame;

      try {
        seq.setInPoint(inTicks.toString());
        seq.setOutPoint(outTicks.toString());
        qeSeq.extract();
        extractedCount++;
      } catch (extractErr) {
        debugLogs.push("Extract err: " + extractErr.message);
      }
    }

    // Clear in/out points
    try { seq.setInPoint("-1"); seq.setOutPoint("-1"); } catch (e) {}

    debugLogs.push("Extracted " + extractedCount + " gaps");

    return JSON.stringify({
      success: extractedCount > 0,
      message: "Kept " + shorts.length + " shorts, extracted " + extractedCount + " gap regions.",
      debug: debugLogs.join(" | ")
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: "cutMarkedShorts: " + e.message });
  }
}

/**
 * Export subtitles/captions from the active sequence
 * Searches project for .srt files and reads their content
 */
function exportSubtitles() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    var subtitles = [];
    var source = "none";
    var debugInfo = [];
    var srtFilePath = null;

    // Search project for SRT/caption files
    debugInfo.push("Searching project for caption files...");

    function searchForCaptionFiles(bin, results) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var item = bin.children[i];
        if (item.type === ProjectItemType.BIN) {
          searchForCaptionFiles(item, results);
        } else if (item.type === ProjectItemType.FILE || item.type === ProjectItemType.CLIP) {
          var path = "";
          try {
            path = item.getMediaPath();
          } catch (e) { }

          if (path) {
            var lowerPath = path.toLowerCase();
            if (lowerPath.indexOf(".srt") !== -1 ||
              lowerPath.indexOf(".vtt") !== -1 ||
              lowerPath.indexOf("caption") !== -1 ||
              lowerPath.indexOf("subtitle") !== -1) {
              results.push({ name: item.name, path: path });
            }
          }
        }
      }
    }

    var captionFiles = [];
    searchForCaptionFiles(app.project.rootItem, captionFiles);
    debugInfo.push("Found " + captionFiles.length + " caption files");

    // If we found an SRT file, read it
    if (captionFiles.length > 0) {
      srtFilePath = captionFiles[0].path;
      debugInfo.push("Reading: " + srtFilePath);

      var srtFile = new File(srtFilePath);
      if (srtFile.exists) {
        srtFile.open("r");
        var srtContent = srtFile.read();
        srtFile.close();

        // Parse SRT content
        subtitles = parseSRT(srtContent);
        source = "srt_file";
        debugInfo.push("Parsed " + subtitles.length + " subtitles from SRT");

        // Return the raw SRT content
        return JSON.stringify({
          success: true,
          subtitles: subtitles,
          srt: srtContent,
          count: subtitles.length,
          sequenceName: seq.name,
          source: source,
          filePath: srtFilePath,
          debug: debugInfo.join("; ")
        });
      }
    }

    // Try to find caption track clips
    debugInfo.push("Checking caption tracks...");
    try {
      if (seq.captionTracks && seq.captionTracks.numTracks > 0) {
        debugInfo.push("Found " + seq.captionTracks.numTracks + " caption tracks");
        for (var t = 0; t < seq.captionTracks.numTracks; t++) {
          var track = seq.captionTracks[t];
          if (track && track.clips && track.clips.numItems > 0) {
            debugInfo.push("Track " + t + " has " + track.clips.numItems + " clips");
            source = "caption_track";
          }
        }
      } else {
        debugInfo.push("No caption tracks found");
      }
    } catch (e) {
      debugInfo.push("Caption track error: " + e.message);
    }

    // Generate empty SRT if nothing found
    var srtContent = "";
    for (var s = 0; s < subtitles.length; s++) {
      var sub = subtitles[s];
      srtContent += (s + 1) + "\n";
      srtContent += formatSrtTime(sub.start) + " --> " + formatSrtTime(sub.end) + "\n";
      srtContent += sub.text + "\n\n";
    }

    return JSON.stringify({
      success: true,
      subtitles: subtitles,
      srt: srtContent,
      count: subtitles.length,
      sequenceName: seq.name,
      source: source,
      debug: debugInfo.join("; ")
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message, debug: "Error: " + e.message });
  }
}

/**
 * Parse SRT format into subtitle objects
 */
function parseSRT(content) {
  var subtitles = [];
  var blocks = content.split(/\n\n+/);

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i].replace(/^\s+|\s+$/g, '');
    if (!block) continue;

    var lines = block.split(/\n/);
    if (lines.length >= 3) {
      // Line 1: index, Line 2: timecode, Line 3+: text
      var timeLine = lines[1];
      var timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);

      if (timeMatch) {
        var startSec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000;
        var endSec = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000;

        var text = "";
        for (var j = 2; j < lines.length; j++) {
          if (text) text += " ";
          text += lines[j];
        }

        subtitles.push({
          index: subtitles.length + 1,
          start: startSec,
          end: endSec,
          text: text
        });
      }
    }
  }

  return subtitles;
}

/**
 * Format seconds to SRT timestamp (HH:MM:SS,mmm)
 */
function formatSrtTime(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var ms = Math.floor((seconds % 1) * 1000);

  function pad(n, len) {
    var str = String(n);
    while (str.length < len) str = "0" + str;
    return str;
  }

  return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
}

/**
 * Import an SRT file (already written by the desktop app) into Premiere as a
 * caption track. srtPath is an absolute path to the file on disk — the desktop
 * app owns file generation so the bytes match the "Save SRT" output exactly.
 */
function importCaptions(srtPath) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    if (!srtPath) {
      return JSON.stringify({ success: false, error: "No caption file path provided" });
    }

    var srtFile = new File(srtPath);
    if (!srtFile.exists) {
      return JSON.stringify({ success: false, error: "Caption file not found: " + srtPath });
    }

    // Count cues so the user can verify the whole file made it into Premiere.
    var cueCount = 0;
    try {
      srtFile.open("r");
      var srtContent = srtFile.read();
      srtFile.close();
      cueCount = parseSRT(srtContent).length;
    } catch (parseErr) {
      cueCount = 0;
    }

    // Import the SRT file into Premiere's project panel
    var importSuccess = app.project.importFiles(
      [srtPath],              // array of file paths
      true,                   // suppress import UI
      app.project.rootItem,   // target bin
      false                   // not numbered stills
    );

    if (!importSuccess) {
      return JSON.stringify({
        success: false,
        error: "Premiere could not import the caption file. File saved at: " + srtPath
      });
    }

    // Find the imported SRT item in the project
    var srtItem = null;
    var srtFileName = srtFile.name;

    for (var i = app.project.rootItem.children.numItems - 1; i >= 0; i--) {
      var item = app.project.rootItem.children[i];
      if (item.name === srtFileName || item.name === srtFileName.replace(".srt", "")) {
        srtItem = item;
        break;
      }
    }

    if (!srtItem) {
      return JSON.stringify({
        success: true,
        count: cueCount,
        message: "Caption file imported into the project panel. Drag '" + srtFileName + "' onto your sequence to create a caption track."
      });
    }

    // Try to create a caption track directly from the imported SRT item.
    // This is the documented API for caption media (Premiere 15.4+) and places
    // the full set of cues at the requested time — insertClip on caption media
    // is unreliable (it can insert only part of the captions or fail outright).
    try {
      var newTrack = seq.createCaptionTrack(srtItem, 0);
      if (newTrack) {
        return JSON.stringify({
          success: true,
          count: cueCount,
          message: "Captions imported onto the sequence" + (cueCount > 0 ? " (" + cueCount + " cues)." : ".")
        });
      }
    } catch (captionErr) {
      // Fall through to the insertClip strategies below.
    }

    // Try to insert the SRT onto the sequence as a caption track.
    // The 2-argument form is the most reliable for caption media; the 4-argument
    // form is kept as a fallback for older Premiere versions.
    try {
      seq.insertClip(srtItem, 0);
      return JSON.stringify({
        success: true,
        count: cueCount,
        message: "Captions imported onto the sequence" + (cueCount > 0 ? " (" + cueCount + " cues)." : ".")
      });
    } catch (insertErr2) {
      try {
        seq.insertClip(srtItem, 0, seq.videoTracks.numTracks - 1, seq.audioTracks.numTracks - 1);
        return JSON.stringify({
          success: true,
          count: cueCount,
          message: "Captions imported onto the sequence" + (cueCount > 0 ? " (" + cueCount + " cues)." : ".")
        });
      } catch (insertErr) {
        // insertClip may not work for SRT — tell the user to drag from project panel
        return JSON.stringify({
          success: true,
          count: cueCount,
          message: "Caption file imported into the project. Drag '" + srtFileName + "' from the project panel onto your sequence to create a caption track."
        });
      }
    }

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Add wide shots to a new track by copying segments from source track (supports nested sequences)
 * wideShotsJSON: array of {start: seconds, end: seconds, camera: trackIndex}
 * sourceTrackIndex: the video track containing the wide camera/nested sequence (0-indexed)
 * targetTrackIndex: where to place the wide shots (typically a track above the source)
 *
 * This function:
 * 1. Finds the nested sequence clip on the source track
 * 2. Disables/removes the original continuous clip
 * 3. Creates individual clips at each wide shot time with proper in/out points for sync
 */
function addWideShotsToTimeline(wideShotsJSON, sourceTrackIndex, targetTrackIndex) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    var wideShots = JSON.parse(wideShotsJSON);
    if (!wideShots || wideShots.length === 0) {
      return JSON.stringify({ success: false, error: "No wide shots provided" });
    }

    // Default to track index 2 (V3) for source if not specified
    sourceTrackIndex = sourceTrackIndex || 2;

    var videoTracks = seq.videoTracks;

    // Ensure source track exists
    if (videoTracks.numTracks <= sourceTrackIndex) {
      return JSON.stringify({ success: false, error: "Source track V" + (sourceTrackIndex + 1) + " does not exist" });
    }

    // Get the source track (where the nested sequence/wide camera is)
    var sourceTrack = videoTracks[sourceTrackIndex];

    // Find the source clip (nested sequence) on the source track
    var sourceProjectItem = null;
    var sourceClipInPoint = 0; // The in-point of the source clip
    var sourceClipStart = 0;   // Where the source clip starts on timeline

    if (sourceTrack.clips.numItems > 0) {
      var sourceClip = sourceTrack.clips[0]; // First clip is the wide camera
      sourceProjectItem = sourceClip.projectItem;
      sourceClipInPoint = sourceClip.inPoint.seconds;
      sourceClipStart = sourceClip.start.seconds;

      // IMPORTANT: Remove the continuous clip so only our segments show
      // This prevents the wide camera from playing continuously
      sourceClip.remove(false, false); // Don't ripple, don't align to playhead
    }

    if (!sourceProjectItem) {
      return JSON.stringify({ success: false, error: "No clip found on source track V" + (sourceTrackIndex + 1) });
    }

    var addedCount = 0;
    var errors = [];

    // Sort wide shots by start time (ascending for cleaner insertion)
    wideShots.sort(function (a, b) { return a.start - b.start; });

    for (var i = 0; i < wideShots.length; i++) {
      var shot = wideShots[i];

      try {
        var startTime = shot.start;
        var endTime = shot.end;
        var duration = endTime - startTime;

        if (duration <= 0) continue;

        // For synced nested sequences where in-point 0 = timeline 0:
        // The clip's in-point should match the timeline position
        // So a wide shot at 10s-15s should have in-point 10s, showing content from 10s-15s of nested seq

        // Create time for insertion position on timeline
        var insertTicks = startTime * 254016000000; // Convert seconds to ticks

        // Insert the clip at the timeline position
        // insertClip returns the new TrackItem
        var newClip = sourceTrack.insertClip(sourceProjectItem, insertTicks.toString());

        if (newClip) {
          try {
            // Set the in-point to match the timeline position (for sync)
            // This means: at timeline 10s, show the content from 10s of the nested sequence
            var inTime = new Time();
            inTime.seconds = startTime;
            newClip.inPoint = inTime;

            // Set the out-point
            var outTime = new Time();
            outTime.seconds = endTime;
            newClip.outPoint = outTime;

            // Alternatively, set the end position on timeline directly
            var endTimeOnTimeline = new Time();
            endTimeOnTimeline.seconds = endTime;
            newClip.end = endTimeOnTimeline;

          } catch (trimErr) {
            errors.push("Trim " + i + ": " + trimErr.message);
          }
          addedCount++;
        }

      } catch (shotErr) {
        errors.push("Shot " + i + ": " + shotErr.message);
      }
    }

    var message = "Added " + addedCount + " of " + wideShots.length + " wide shots to V" + (sourceTrackIndex + 1);
    if (errors.length > 0) {
      message += " (Errors: " + errors.slice(0, 3).join("; ") + ")";
    }

    return JSON.stringify({
      success: addedCount > 0,
      count: addedCount,
      message: message,
      errors: errors
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Alternative: Insert wide shots using QE DOM for more precise control
 */
function addWideShotsWithQE(wideShotsJSON, sourceTrackIndex, targetTrackIndex) {
  try {
    app.enableQE();

    var seq = app.project.activeSequence;
    var qeSeq = qe.project.getActiveSequence();

    if (!seq || !qeSeq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    var wideShots = JSON.parse(wideShotsJSON);
    if (!wideShots || wideShots.length === 0) {
      return JSON.stringify({ success: false, error: "No wide shots provided" });
    }

    sourceTrackIndex = sourceTrackIndex || 2;
    targetTrackIndex = targetTrackIndex || 2;

    var videoTracks = seq.videoTracks;

    if (videoTracks.numTracks <= sourceTrackIndex) {
      return JSON.stringify({ success: false, error: "Source track does not exist" });
    }

    // Get the source clip's project item
    var sourceTrack = videoTracks[sourceTrackIndex];
    var sourceProjectItem = null;

    if (sourceTrack.clips.numItems > 0) {
      sourceProjectItem = sourceTrack.clips[0].projectItem;
    }

    if (!sourceProjectItem) {
      return JSON.stringify({ success: false, error: "No source clip found on V" + (sourceTrackIndex + 1) });
    }

    var targetTrack = videoTracks[targetTrackIndex];
    var addedCount = 0;

    // Sort by start time
    wideShots.sort(function (a, b) { return a.start - b.start; });

    for (var i = 0; i < wideShots.length; i++) {
      var shot = wideShots[i];

      try {
        var startTicks = shot.start * 254016000000; // Convert seconds to ticks (assuming 254016000000 ticks/sec)
        var endTicks = shot.end * 254016000000;

        // Use insertClip which works better with nested sequences
        var insertTime = new Time();
        insertTime.seconds = shot.start;

        var clipDuration = shot.end - shot.start;

        // Insert the clip
        targetTrack.insertClip(sourceProjectItem, insertTime.ticks);
        addedCount++;

      } catch (err) {
        // Continue with next shot
      }
    }

    return JSON.stringify({
      success: addedCount > 0,
      count: addedCount,
      message: "Added " + addedCount + " wide shots using QE"
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * Fallback: Add markers at silence boundaries if QE doesn't work
 */
function addSilenceMarkers(silenceSegmentsJSON) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ success: false, error: "No active sequence" });
    }

    var payload = JSON.parse(silenceSegmentsJSON);
    if (!payload.sequenceId || String(seq.sequenceID) !== String(payload.sequenceId)) {
      return JSON.stringify({ success: false, error: "The active sequence changed. Return to the analyzed sequence and run Silence Removal again." });
    }
    var segments = payload.segments;
    if (!segments || segments.length === 0) {
      return JSON.stringify({ success: false, error: "No silence segments provided" });
    }

    var markers = seq.markers;
    var addedCount = 0;

    for (var s = 0; s < segments.length; s++) {
      var segment = segments[s];

      var marker = markers.createMarker(segment.start);
      if (marker) {
        marker.name = "Silence " + (s + 1);
        marker.comments = "Duration: " + (segment.end - segment.start).toFixed(1) + "s";
        marker.setColorByIndex(1);
        marker.end = new Time();
        marker.end.seconds = segment.end;
        addedCount++;
      }
    }

    return JSON.stringify({
      success: true,
      message: "Added " + addedCount + " silence markers",
      addedCount: addedCount
    });

  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// ShortsCuts — apply effects, transitions and captured presets to the selected
// clips. QE DOM is used only for the operations Premiere does not expose in the
// standard DOM; component values are set through the standard DOM afterwards.
// ---------------------------------------------------------------------------

function smoothyShortsCutsArray(value) {
  var out = [];
  if (!value) return out;
  if (typeof value.length === "number") {
    for (var i = 0; i < value.length; i++) out.push(String(value[i]));
  } else if (typeof value.numItems === "number") {
    for (var j = 0; j < value.numItems; j++) out.push(String(value[j]));
  }
  return out;
}

function smoothyShortsCutsSelected(seq, video) {
  var pairs = [], tracks = video ? seq.videoTracks : seq.audioTracks;
  if (!tracks) return pairs;
  for (var t = 0; t < tracks.numTracks; t++) {
    var track = tracks[t], clips = track.clips;
    if (!clips) continue;
    for (var c = 0; c < clips.numItems; c++) {
      var clip = clips[c], selected = false;
      try {
        selected = typeof clip.isSelected === "function" ? !!clip.isSelected() : !!clip.isSelected;
      } catch (e) {
        selected = false;
      }
      if (selected) pairs.push({ track: t, index: c, clip: clip });
    }
  }
  return pairs;
}

function smoothyShortsCutsTrackItems(qeTrack) {
  var items = [], count = 0;
  try {
    count = qeTrack.numItems || 0;
  } catch (e) {
    count = 0;
  }
  if (!count) {
    while (count < 5000 && qeTrack.getItemAt(count)) count++;
  }
  for (var i = 0; i < count; i++) {
    var item = null;
    try {
      item = qeTrack.getItemAt(i);
    } catch (e) {
      item = null;
    }
    if (!item) continue;
    var type = "";
    try {
      type = String(item.type || "").toLowerCase();
    } catch (e) {
      type = "";
    }
    if (type === "empty" || (type !== "" && type !== "clip")) continue;
    items.push(item);
  }
  return items;
}

function smoothyShortsCutsQeClip(seq, qeSeq, video, trackIndex, standardIndex) {
  var qeTrack = null;
  try {
    qeTrack = video ? qeSeq.getVideoTrackAt(trackIndex) : qeSeq.getAudioTrackAt(trackIndex);
  } catch (e) {
    qeTrack = null;
  }
  if (!qeTrack) return null;
  var items = smoothyShortsCutsTrackItems(qeTrack);
  return items[standardIndex] || null;
}

function smoothyShortsCutsFindName(names, wanted) {
  if (!wanted) return null;
  var target = String(wanted).toLowerCase(), prefix = null, contains = null;
  for (var i = 0; i < names.length; i++) {
    var value = String(names[i]).toLowerCase();
    if (value === target) return String(names[i]);
    if (!prefix && value.indexOf(target) === 0) prefix = String(names[i]);
    if (!contains && value.indexOf(target) >= 0) contains = String(names[i]);
  }
  // Newer Premiere builds suffix some legacy effects, e.g. "Mosaic (Legacy)".
  return prefix || contains;
}

function smoothyShortsCutsAddEffect(qeClip, video, name) {
  app.enableQE();
  var list = smoothyShortsCutsArray(video ? qe.project.getVideoEffectList() : qe.project.getAudioEffectList());
  var resolved = smoothyShortsCutsFindName(list, name) || name;
  var effect = null;
  try {
    effect = video ? qe.project.getVideoEffectByName(resolved) : qe.project.getAudioEffectByName(resolved);
  } catch (e) {
    effect = null;
  }
  if (!effect) {
    try {
      effect = video ? qe.project.getVideoEffectByName(resolved, true) : qe.project.getAudioEffectByName(resolved, true);
    } catch (e2) {
      effect = null;
    }
  }
  if (!effect) throw new Error('Premiere could not find the effect "' + name + '". Refresh the catalog and add it again.');
  if (video) {
    if (typeof qeClip.addVideoEffect !== "function") throw new Error("This Premiere version cannot add video effects.");
    qeClip.addVideoEffect(effect);
  } else {
    if (typeof qeClip.addAudioEffect !== "function") throw new Error("This Premiere version cannot add audio effects.");
    qeClip.addAudioEffect(effect);
  }
}

function smoothyShortsCutsTransitionDuration(seconds, fps) {
  var rate = Number(fps) > 0 ? Number(fps) : 25;
  var totalFrames = Math.max(1, Math.round(Math.max(0.05, Math.min(10, Number(seconds) || 0.5)) * rate));
  var wholeSeconds = Math.floor(totalFrames / rate);
  var frames = Math.round(totalFrames - wholeSeconds * rate);
  if (frames >= Math.round(rate)) { wholeSeconds++; frames = 0; }
  return String(wholeSeconds) + "." + (frames < 10 ? "0" : "") + frames;
}

function smoothyShortsCutsAddTransition(qeClip, video, name, atEnd, seconds, fps) {
  app.enableQE();
  var transition = null;
  if (name) {
    var list = smoothyShortsCutsArray(video ? qe.project.getVideoTransitionList() : qe.project.getAudioTransitionList());
    var resolved = smoothyShortsCutsFindName(list, name) || name;
    try {
      transition = video ? qe.project.getVideoTransitionByName(resolved) : qe.project.getAudioTransitionByName(resolved);
    } catch (e) {
      transition = null;
    }
    if (!transition) throw new Error('Premiere could not find the transition "' + name + '". Refresh the catalog and add it again.');
  }
  var duration = smoothyShortsCutsTransitionDuration(seconds, fps);
  if (typeof qeClip.addTransition !== "function") throw new Error("This Premiere version cannot add transitions.");
  try {
    qeClip.addTransition(transition, atEnd, duration);
    return;
  } catch (e) {
    // Older builds accept an extra argument; make one compatibility attempt.
  }
  try {
    qeClip.addTransition(transition, atEnd, duration, 1);
    return;
  } catch (e2) {
    throw new Error("Premiere could not add that transition at this edit point.");
  }
}

function smoothyShortsCutsValue(value) {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (value && typeof value.length === "number" && value.length > 0 && value.length <= 16) {
    var array = [];
    for (var i = 0; i < value.length; i++) {
      var number = Number(value[i]);
      if (!isFinite(number)) return null;
      array.push(number);
    }
    return array;
  }
  return null;
}

function smoothyShortsCutsComponent(clip, matchName) {
  var found = null;
  for (var i = 0; i < clip.components.numItems; i++) {
    var component = clip.components[i];
    if (String(component.matchName) === String(matchName)) found = component;
  }
  return found;
}

function smoothyShortsCutsConvertValue(name, value, seq) {
  if (value && typeof value.length === "number" && value.length === 2 && (name === "Position" || name === "Anchor Point")) {
    try {
      if (Math.abs(Number(value[0])) <= 10 && Math.abs(Number(value[1])) <= 10) {
        var settings = seq.getSettings();
        return [Number(value[0]) * Number(settings.videoFrameWidth), Number(value[1]) * Number(settings.videoFrameHeight)];
      }
    } catch (e) {
      // Use the raw value if the sequence frame size is unavailable.
    }
  }
  return value;
}

function smoothyShortsCutsApplyKeyframes(component, name, keyframes, clip, seq) {
  if (!keyframes || !keyframes.length) return 0;
  var base = Number(clip.start.ticks) || 0;
  var minimum = null;
  for (var t = 0; t < keyframes.length; t++) {
    var value = Number(keyframes[t].time);
    if (!isFinite(value)) continue;
    if (minimum === null || value < minimum) minimum = value;
  }
  if (minimum === null) return 0;
  try {
    component.setTimeVarying(true);
  } catch (e) {
    return 0;
  }
  var applied = 0;
  for (var i = 0; i < keyframes.length; i++) {
    var ticks = base + (Number(keyframes[i].time) - minimum);
    var current = smoothyShortsCutsConvertValue(name, keyframes[i].value, seq);
    try {
      var time = new Time();
      time.ticks = String(ticks);
      component.addKey(time);
      component.setValueAtKey(time, current, true);
      applied++;
    } catch (error) {
      try {
        component.addKey(ticks);
        component.setValueAtKey(ticks, current, true);
        applied++;
      } catch (fallbackError) {
        // Skip this keyframe; the remaining keyframes can still be useful.
      }
    }
  }
  return applied;
}

function smoothyShortsCutsSetProperties(component, properties, clip, seq) {
  var applied = 0;
  for (var i = 0; i < properties.length; i++) {
    var wanted = properties[i], target = null;
    for (var j = 0; j < component.properties.numItems; j++) {
      var property = component.properties[j];
      if (String(property.displayName) === String(wanted.name)) {
        target = property;
        break;
      }
    }
    if (!target) continue;
    try {
      if (wanted.keyframes && wanted.keyframes.length) {
        if (smoothyShortsCutsApplyKeyframes(target, wanted.name, wanted.keyframes, clip, seq) > 0) applied++;
      } else {
        target.setValue(smoothyShortsCutsConvertValue(wanted.name, wanted.value, seq), true);
        applied++;
      }
    } catch (e) {
      // A property can be read-only or unavailable in this Premiere build.
    }
  }
  return applied;
}

function smoothyShortsCutsIsIntrinsic(matchName) {
  return matchName === "AE.ADBE Motion" || matchName === "AE.ADBE Opacity" || matchName === "audioVolume";
}

function smoothyShortsCutsApplyPreset(seq, qeSeq, payload) {
  var preset = payload.preset;
  if (!preset || !preset.components || !preset.components.length) {
    return JSON.stringify({ success: false, error: "This preset has no components. Capture it again." });
  }
  var video = preset.mediaType !== "audio";
  var pairs = smoothyShortsCutsSelected(seq, video);
  if (!pairs.length) {
    return JSON.stringify({ success: false, error: video ? "Select one or more video clips." : "Select one or more audio clips." });
  }
  var appliedClips = 0, failedClips = 0, details = [];
  for (var p = 0; p < pairs.length; p++) {
    var pair = pairs[p];
    var qeClip = smoothyShortsCutsQeClip(seq, qeSeq, video, pair.track, pair.index);
    if (!qeClip) {
      failedClips++;
      if (details.length < 4) details.push("Could not map the selected clip on track " + (pair.track + 1) + ".");
      continue;
    }
    var clipApplied = 0;
    for (var c = 0; c < preset.components.length; c++) {
      var component = preset.components[c];
      if (!component.matchName || component.matchName === "AE.ADBE Time Remapping") continue;
      try {
        var intrinsic = smoothyShortsCutsIsIntrinsic(component.matchName);
        var target = intrinsic ? smoothyShortsCutsComponent(pair.clip, component.matchName) : null;
        if (!intrinsic) {
          for (var existing = pair.clip.components.numItems - 1; existing >= 0; existing--) {
            var old = pair.clip.components[existing];
            if (String(old.matchName) !== String(component.matchName)) continue;
            try {
              old.remove();
            } catch (e) {
              if (!target) target = old;
            }
          }
          if (!target) {
            smoothyShortsCutsAddEffect(qeClip, video, component.displayName || component.matchName);
            target = smoothyShortsCutsComponent(pair.clip, component.matchName);
          }
        }
        if (!target) continue;
        var values = smoothyShortsCutsSetProperties(target, component.properties || [], pair.clip, seq);
        if (values > 0) clipApplied++;
      } catch (error) {
        if (details.length < 4) details.push(error.message || "Could not apply one component.");
      }
    }
    if (clipApplied > 0) appliedClips++;
    else failedClips++;
  }
  var message = "Applied preset to " + appliedClips + (appliedClips === 1 ? " clip." : " clips.");
  if (failedClips) message += " " + failedClips + " clip(s) could not be changed.";
  return JSON.stringify({ success: appliedClips > 0, applied: appliedClips, failed: failedClips, message: message, details: details });
}

function getShortsCutsCatalog() {
  try {
    if (!app.project.activeSequence) return JSON.stringify({ success: false, error: "Open a sequence first." });
    app.enableQE();
    return JSON.stringify({
      success: true,
      videoEffects: smoothyShortsCutsArray(qe.project.getVideoEffectList()),
      audioEffects: smoothyShortsCutsArray(qe.project.getAudioEffectList()),
      videoTransitions: smoothyShortsCutsArray(qe.project.getVideoTransitionList()),
      audioTransitions: smoothyShortsCutsArray(qe.project.getAudioTransitionList())
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: "Could not read the Premiere effects list: " + e.message });
  }
}

function smoothyShortsCutsFindParam(component, names, fallbackIndex) {
  if (!component || !component.properties) return null;
  var count = component.properties.numItems;
  for (var n = 0; n < names.length; n++) {
    var wanted = String(names[n]).toLowerCase();
    for (var i = 0; i < count; i++) {
      var prop = component.properties[i];
      try {
        if (String(prop.displayName || "").toLowerCase() === wanted) return prop;
      } catch (e) {}
    }
  }
  if (typeof fallbackIndex === "number" && fallbackIndex >= 0 && fallbackIndex < count) {
    return component.properties[fallbackIndex];
  }
  return null;
}

function smoothyShortsCutsCopyParam(sourceParam, targetParam) {
  if (!sourceParam || !targetParam) return false;
  var timeVarying = false;
  try {
    timeVarying = typeof sourceParam.isTimeVarying === "function" && !!sourceParam.isTimeVarying();
  } catch (e) {
    timeVarying = false;
  }
  if (timeVarying) {
    var keys = null;
    try {
      keys = sourceParam.getKeys();
    } catch (e) {
      keys = null;
    }
    if (keys && keys.length > 0) {
      try {
        targetParam.setTimeVarying(true);
      } catch (e) {}
      var copied = 0;
      for (var k = 0; k < keys.length; k++) {
        var kt = keys[k];
        try {
          var kv = sourceParam.getValueAtKey(kt);
          targetParam.addKey(kt);
          targetParam.setValueAtKey(kt, kv, true);
          try {
            if (typeof sourceParam.getInterpolationTypeAtKey === "function" && typeof targetParam.setInterpolationTypeAtKey === "function") {
              var interp = sourceParam.getInterpolationTypeAtKey(kt);
              targetParam.setInterpolationTypeAtKey(kt, interp, true);
            }
          } catch (interpErr) {}
          copied++;
        } catch (keyErr) {}
      }
      if (copied > 0) return true;
    }
  }
  try {
    targetParam.setValue(sourceParam.getValue(), true);
    return true;
  } catch (e) {
    return false;
  }
}

function smoothyShortsCutsResetParam(param, defaultValue) {
  if (!param) return;
  try {
    if (typeof param.isTimeVarying === "function" && param.isTimeVarying()) {
      param.setTimeVarying(false);
    }
  } catch (e) {}
  try {
    param.setValue(defaultValue, true);
  } catch (e) {}
}

function smoothyShortsCutsMoveMotionToTransform(seq, qeSeq) {
  var pairs = smoothyShortsCutsSelected(seq, true);
  if (!pairs.length) {
    return JSON.stringify({ success: false, error: "Select one or more video clips first." });
  }
  var applied = 0, failed = 0, details = [];
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i];
    var motion = smoothyShortsCutsComponent(pair.clip, "AE.ADBE Motion");
    if (!motion) {
      failed++;
      if (details.length < 4) details.push("Clip on V" + (pair.track + 1) + " has no Motion component.");
      continue;
    }
    var qeClip = smoothyShortsCutsQeClip(seq, qeSeq, true, pair.track, pair.index);
    if (!qeClip) {
      failed++;
      if (details.length < 4) details.push("Could not map the selected clip on V" + (pair.track + 1) + ".");
      continue;
    }
    try {
      var beforeCount = pair.clip.components.numItems;
      smoothyShortsCutsAddEffect(qeClip, true, "Transform");
      var transform = null;
      for (var c = pair.clip.components.numItems - 1; c >= beforeCount; c--) {
        var comp = pair.clip.components[c];
        var mn = String(comp.matchName || "");
        var dn = String(comp.displayName || "");
        if (mn === "AE.ADBE Geometry2" || mn === "AE.ADBE Geometry" || /transform/i.test(dn)) {
          transform = comp;
          break;
        }
      }
      if (!transform) {
        transform = smoothyShortsCutsComponent(pair.clip, "AE.ADBE Geometry2") || smoothyShortsCutsComponent(pair.clip, "AE.ADBE Geometry");
      }
      if (!transform) {
        failed++;
        if (details.length < 4) details.push("Premiere added Transform, but its properties could not be read.");
        continue;
      }

      var mPos = smoothyShortsCutsFindParam(motion, ["Position"], 0);
      var mScale = smoothyShortsCutsFindParam(motion, ["Scale"], 1);
      var mScaleW = smoothyShortsCutsFindParam(motion, ["Scale Width"], 2);
      var mUniform = smoothyShortsCutsFindParam(motion, ["Uniform Scale"], 3);
      var mRot = smoothyShortsCutsFindParam(motion, ["Rotation"], 4);
      var mAnchor = smoothyShortsCutsFindParam(motion, ["Anchor Point"], 5);

      var tAnchor = smoothyShortsCutsFindParam(transform, ["Anchor Point"], 0);
      var tPos = smoothyShortsCutsFindParam(transform, ["Position"], 1);
      var tUniform = smoothyShortsCutsFindParam(transform, ["Uniform Scale"], 2);
      var tScaleH = smoothyShortsCutsFindParam(transform, ["Scale Height", "Scale"], 3);
      var tScaleW = smoothyShortsCutsFindParam(transform, ["Scale Width"], 4);
      var tRot = smoothyShortsCutsFindParam(transform, ["Rotation"], 7);

      var isUniform = true;
      try {
        if (mUniform) isUniform = !!mUniform.getValue();
      } catch (e) {
        isUniform = true;
      }
      if (mUniform && tUniform) smoothyShortsCutsCopyParam(mUniform, tUniform);
      if (mAnchor && tAnchor) smoothyShortsCutsCopyParam(mAnchor, tAnchor);
      if (mPos && tPos) smoothyShortsCutsCopyParam(mPos, tPos);
      if (mScale && tScaleH) smoothyShortsCutsCopyParam(mScale, tScaleH);
      if (!isUniform && mScaleW && tScaleW) smoothyShortsCutsCopyParam(mScaleW, tScaleW);
      if (mRot && tRot) smoothyShortsCutsCopyParam(mRot, tRot);

      // Reset built-in Motion so transforms are not doubled.
      smoothyShortsCutsResetParam(mUniform, true);
      smoothyShortsCutsResetParam(mPos, [0.5, 0.5]);
      smoothyShortsCutsResetParam(mAnchor, [0.5, 0.5]);
      smoothyShortsCutsResetParam(mScale, 100);
      smoothyShortsCutsResetParam(mScaleW, 100);
      smoothyShortsCutsResetParam(mRot, 0);

      applied++;
    } catch (error) {
      failed++;
      if (details.length < 4) details.push(error.message || "Could not move Motion to Transform.");
    }
  }
  var message = "Moved Motion to Transform on " + applied + (applied === 1 ? " clip." : " clips.");
  if (failed) message += " " + failed + " clip(s) could not be changed.";
  return JSON.stringify({ success: applied > 0, applied: applied, failed: failed, message: message, details: details });
}

function smoothyShortsCutsFindSequenceForItem(projectItem, excludeSeqId) {
  if (!projectItem || !app.project || !app.project.sequences) return null;
  var isSeq = false;
  try {
    isSeq = typeof projectItem.isSequence === "function" && !!projectItem.isSequence();
  } catch (e) {
    isSeq = false;
  }
  if (!isSeq) return null;
  var nodeId = "";
  var treePath = "";
  var name = "";
  try { nodeId = String(projectItem.nodeId || ""); } catch (e) {}
  try { treePath = String(projectItem.treePath || ""); } catch (e) {}
  try { name = String(projectItem.name || ""); } catch (e) {}
  var byTree = null, byName = null;
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    var candidate = app.project.sequences[i];
    if (!candidate || String(candidate.sequenceID) === String(excludeSeqId)) continue;
    var pi = candidate.projectItem;
    if (pi && nodeId && String(pi.nodeId || "") === nodeId) return candidate;
    if (pi && treePath && String(pi.treePath || "") === treePath) byTree = candidate;
    if (name && String(candidate.name || "") === name) byName = candidate;
  }
  return byTree || byName;
}

function smoothyShortsCutsCaptureClipComponents(clip) {
  var out = [];
  if (!clip || !clip.components) return out;
  for (var i = 0; i < clip.components.numItems; i++) {
    var comp = clip.components[i];
    var matchName = String(comp.matchName || "");
    if (!matchName || matchName === "AE.ADBE Time Remapping") continue;
    var props = [];
    try {
      for (var j = 0; j < comp.properties.numItems; j++) {
        var prop = comp.properties[j];
        var pName = String(prop.displayName || "");
        if (!pName) continue;
        var timeVarying = false;
        try { timeVarying = typeof prop.isTimeVarying === "function" && !!prop.isTimeVarying(); } catch (e) {}
        if (timeVarying) {
          var keys = null;
          try { keys = prop.getKeys(); } catch (e) { keys = null; }
          if (keys && keys.length > 0) {
            var kList = [];
            for (var k = 0; k < keys.length; k++) {
              try {
                var kv = smoothyShortsCutsValue(prop.getValueAtKey(keys[k]));
                if (kv === null) continue;
                var interp = null;
                try {
                  if (typeof prop.getInterpolationTypeAtKey === "function") interp = prop.getInterpolationTypeAtKey(keys[k]);
                } catch (ie) {}
                kList.push({ ticks: String(keys[k].ticks), value: kv, interp: interp });
              } catch (ke) {}
            }
            if (kList.length > 0) {
              props.push({ name: pName, index: j, keyframes: kList });
              continue;
            }
          }
        }
        try {
          var val = smoothyShortsCutsValue(prop.getValue());
          if (val !== null) props.push({ name: pName, index: j, value: val });
        } catch (ve) {}
      }
    } catch (e) {}
    out.push({
      matchName: matchName,
      displayName: String(comp.displayName || matchName),
      properties: props
    });
  }
  return out;
}

function smoothyShortsCutsRestoreClipComponents(clip, qeClip, video, components, tickDelta) {
  if (!clip || !components || !components.length) return;
  for (var i = 0; i < components.length; i++) {
    var entry = components[i];
    try {
      var intrinsic = smoothyShortsCutsIsIntrinsic(entry.matchName);
      var target = intrinsic ? smoothyShortsCutsComponent(clip, entry.matchName) : null;
      if (!intrinsic && qeClip) {
        smoothyShortsCutsAddEffect(qeClip, video, entry.displayName || entry.matchName);
        target = smoothyShortsCutsComponent(clip, entry.matchName);
      }
      if (!target || !target.properties) continue;
      for (var j = 0; j < entry.properties.length; j++) {
        var wanted = entry.properties[j];
        var prop = smoothyShortsCutsFindParam(target, [wanted.name], wanted.index);
        if (!prop) continue;
        try {
          if (wanted.keyframes && wanted.keyframes.length) {
            prop.setTimeVarying(true);
            for (var k = 0; k < wanted.keyframes.length; k++) {
              var kf = wanted.keyframes[k];
              var shifted = Number(kf.ticks) + tickDelta;
              var t = new Time();
              t.ticks = String(Math.round(shifted));
              prop.addKey(t);
              prop.setValueAtKey(t, kf.value, true);
              if (kf.interp !== null && typeof prop.setInterpolationTypeAtKey === "function") {
                try { prop.setInterpolationTypeAtKey(t, kf.interp, true); } catch (ie) {}
              }
            }
          } else {
            prop.setValue(wanted.value, true);
          }
        } catch (pe) {}
      }
    } catch (ce) {}
  }
}

function smoothyShortsCutsSaveItemBounds(projectItem, mediaType) {
  var saved = { hasIn: false, hasOut: false, inTicks: "", outTicks: "" };
  try {
    var curIn = projectItem.getInPoint(mediaType);
    if (curIn && curIn.ticks !== undefined && Number(curIn.ticks) >= 0) {
      saved.hasIn = true;
      saved.inTicks = String(curIn.ticks);
    }
  } catch (e) {}
  try {
    var curOut = projectItem.getOutPoint(mediaType);
    if (curOut && curOut.ticks !== undefined && Number(curOut.ticks) >= 0) {
      saved.hasOut = true;
      saved.outTicks = String(curOut.ticks);
    }
  } catch (e) {}
  return saved;
}

function smoothyShortsCutsRestoreItemBounds(projectItem, mediaType, saved) {
  try {
    if (saved && saved.hasIn) projectItem.setInPoint(saved.inTicks, mediaType);
    else if (typeof projectItem.clearInPoint === "function") projectItem.clearInPoint(mediaType);
  } catch (e) {}
  try {
    if (saved && saved.hasOut) projectItem.setOutPoint(saved.outTicks, mediaType);
    else if (typeof projectItem.clearOutPoint === "function") projectItem.clearOutPoint(mediaType);
  } catch (e) {}
}

function smoothyShortsCutsFindClipNear(track, targetStartTicks, nodeId, frameTicks) {
  if (!track || !track.clips) return null;
  var best = null, bestDiff = frameTicks * 4 + 1;
  for (var i = 0; i < track.clips.numItems; i++) {
    var c = track.clips[i];
    var diff = Math.abs(Number(c.start.ticks) - targetStartTicks);
    if (diff >= bestDiff) continue;
    if (nodeId && c.projectItem && String(c.projectItem.nodeId || "") !== nodeId) continue;
    best = { clip: c, index: i };
    bestDiff = diff;
  }
  return best;
}

function smoothyShortsCutsUnnest(seq, qeSeq) {
  var selectedVideo = smoothyShortsCutsSelected(seq, true);
  var selectedAudio = selectedVideo.length ? [] : smoothyShortsCutsSelected(seq, false);
  var candidates = selectedVideo.length ? selectedVideo : selectedAudio;
  var fromVideo = selectedVideo.length > 0;
  if (!candidates.length) {
    return JSON.stringify({ success: false, error: "Select a nested sequence clip first." });
  }
  var nests = [];
  for (var i = 0; i < candidates.length; i++) {
    var pair = candidates[i];
    var inner = smoothyShortsCutsFindSequenceForItem(pair.clip.projectItem, seq.sequenceID);
    if (inner) nests.push({ pair: pair, inner: inner, fromVideo: fromVideo });
  }
  if (!nests.length) {
    return JSON.stringify({ success: false, error: "Select a nested sequence clip to unnest." });
  }

  var frameTicks = 10160640000; // ~25fps fallback
  try { frameTicks = Number(seq.timebase) || frameTicks; } catch (e) {}

  var unnestedCount = 0, placedTotal = 0, details = [], placedClips = [];
  for (var n = 0; n < nests.length; n++) {
    var entry = nests[n];
    var nestClip = entry.pair.clip;
    var innerSeq = entry.inner;
    var nestNodeId = String(nestClip.projectItem.nodeId || "");
    var nestStart = Number(nestClip.start.ticks);
    var nestEnd = Number(nestClip.end.ticks);
    var nestIn = Number(nestClip.inPoint.ticks);
    var nestOut = Number(nestClip.outPoint.ticks);
    var baseVTrack = entry.fromVideo ? entry.pair.track : 0;

    // Locate any linked nested audio clips matching this nested sequence span.
    var parentAudioClips = [];
    var audioBaseTrack = entry.fromVideo ? -1 : entry.pair.track;
    if (entry.fromVideo) {
      for (var at = 0; at < seq.audioTracks.numTracks; at++) {
        var aTrack = seq.audioTracks[at];
        for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
          var aClip = aTrack.clips[ac];
          if (!aClip.projectItem || String(aClip.projectItem.nodeId || "") !== nestNodeId) continue;
          if (Math.abs(Number(aClip.start.ticks) - nestStart) <= frameTicks * 2 &&
              Math.abs(Number(aClip.end.ticks) - nestEnd) <= frameTicks * 2) {
            parentAudioClips.push(aClip);
            if (audioBaseTrack < 0 || at < audioBaseTrack) audioBaseTrack = at;
          }
        }
      }
    } else {
      parentAudioClips.push(nestClip);
    }
    var includeAudio = parentAudioClips.length > 0;
    if (audioBaseTrack < 0) audioBaseTrack = 0;

    // Gather visible inner video and audio clips.
    var innerVideos = [], innerAudios = [];
    var maxVTrack = -1, maxATrack = -1;
    if (entry.fromVideo) {
      for (var vt = 0; vt < innerSeq.videoTracks.numTracks; vt++) {
        var vTrack = innerSeq.videoTracks[vt];
        for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
          var ic = vTrack.clips[vc];
          if (!ic.projectItem) continue;
          var icStart = Number(ic.start.ticks);
          var icEnd = Number(ic.end.ticks);
          var visStart = Math.max(icStart, nestIn);
          var visEnd = Math.min(icEnd, nestOut);
          if (visEnd <= visStart) continue;
          var srcIn = Number(ic.inPoint.ticks) + (visStart - icStart);
          var srcOut = Number(ic.outPoint.ticks) - (icEnd - visEnd);
          innerVideos.push({
            projectItem: ic.projectItem,
            nodeId: String(ic.projectItem.nodeId || ""),
            trackOffset: vt,
            destStart: nestStart + (visStart - nestIn),
            destEnd: nestStart + (visEnd - nestIn),
            srcIn: srcIn,
            srcOut: srcOut,
            tickDelta: (nestStart - nestIn),
            disabled: !!ic.disabled,
            components: smoothyShortsCutsCaptureClipComponents(ic)
          });
          if (vt > maxVTrack) maxVTrack = vt;
        }
      }
    }
    if (includeAudio) {
      for (var iat = 0; iat < innerSeq.audioTracks.numTracks; iat++) {
        var iaTrack = innerSeq.audioTracks[iat];
        for (var iac = 0; iac < iaTrack.clips.numItems; iac++) {
          var ia = iaTrack.clips[iac];
          if (!ia.projectItem) continue;
          var iaStart = Number(ia.start.ticks);
          var iaEnd = Number(ia.end.ticks);
          var aVisStart = Math.max(iaStart, nestIn);
          var aVisEnd = Math.min(iaEnd, nestOut);
          if (aVisEnd <= aVisStart) continue;
          var aSrcIn = Number(ia.inPoint.ticks) + (aVisStart - iaStart);
          var aSrcOut = Number(ia.outPoint.ticks) - (iaEnd - aVisEnd);
          innerAudios.push({
            projectItem: ia.projectItem,
            nodeId: String(ia.projectItem.nodeId || ""),
            trackOffset: iat,
            destStart: nestStart + (aVisStart - nestIn),
            destEnd: nestStart + (aVisEnd - nestIn),
            srcIn: aSrcIn,
            srcOut: aSrcOut,
            tickDelta: (nestStart - nestIn),
            disabled: !!ia.disabled,
            components: smoothyShortsCutsCaptureClipComponents(ia)
          });
          if (iat > maxATrack) maxATrack = iat;
        }
      }
    }

    if (!innerVideos.length && !innerAudios.length) {
      if (details.length < 4) details.push('"' + String(innerSeq.name || "Nested sequence") + '" has no clips in this range.');
      continue;
    }

    // Ensure enough tracks exist on the parent sequence.
    var needV = maxVTrack >= 0 ? (baseVTrack + maxVTrack + 1) - seq.videoTracks.numTracks : 0;
    var needA = maxATrack >= 0 ? (audioBaseTrack + maxATrack + 1) - seq.audioTracks.numTracks : 0;
    if (needV > 0 && typeof qeSeq.addTracks === "function") {
      try { qeSeq.addTracks(needV, seq.videoTracks.numTracks, 0); } catch (e) {}
    }
    if (needA > 0 && typeof qeSeq.addTracks === "function") {
      try { qeSeq.addTracks(0, seq.videoTracks.numTracks, 1, needA, seq.audioTracks.numTracks); } catch (e) {}
    }

    // Remove the nested clip(s) on the parent sequence without rippling.
    try {
      if (entry.fromVideo) nestClip.remove(false, false);
    } catch (e) {}
    for (var pa = 0; pa < parentAudioClips.length; pa++) {
      try { parentAudioClips[pa].remove(false, false); } catch (e) {}
    }

    // Snapshot remaining audio clips so any unwanted auto-linked audio created
    // during video overwriteClip can be removed cleanly before placing audio.
    var audioSnapshot = {};
    for (var sat = 0; sat < seq.audioTracks.numTracks; sat++) {
      var saTrack = seq.audioTracks[sat];
      for (var sac = 0; sac < saTrack.clips.numItems; sac++) {
        var saClip = saTrack.clips[sac];
        var key = sat + "|" + String(saClip.start.ticks) + "|" + (saClip.projectItem ? String(saClip.projectItem.nodeId || "") : "");
        audioSnapshot[key] = true;
      }
    }

    var nestPlaced = 0;
    for (var iv = 0; iv < innerVideos.length; iv++) {
      var vSpec = innerVideos[iv];
      var destVIdx = baseVTrack + vSpec.trackOffset;
      if (destVIdx >= seq.videoTracks.numTracks) continue;
      var destVTrack = seq.videoTracks[destVIdx];
      var savedV = smoothyShortsCutsSaveItemBounds(vSpec.projectItem, 1);
      try {
        try {
          vSpec.projectItem.setInPoint(String(Math.round(vSpec.srcIn)), 1);
          vSpec.projectItem.setOutPoint(String(Math.round(vSpec.srcOut)), 1);
        } catch (bErr) {
          vSpec.projectItem.setInPoint(String(Math.round(vSpec.srcIn)), 4);
          vSpec.projectItem.setOutPoint(String(Math.round(vSpec.srcOut)), 4);
        }
        var vTime = new Time();
        vTime.ticks = String(Math.round(vSpec.destStart));
        destVTrack.overwriteClip(vSpec.projectItem, vTime);
      } catch (ovErr) {
        if (details.length < 4) details.push("Could not place a video clip: " + ovErr.message);
      } finally {
        smoothyShortsCutsRestoreItemBounds(vSpec.projectItem, 1, savedV);
      }
      var foundV = smoothyShortsCutsFindClipNear(destVTrack, vSpec.destStart, vSpec.nodeId, frameTicks);
      if (foundV) {
        try {
          if (Math.abs(Number(foundV.clip.end.ticks) - vSpec.destEnd) > frameTicks) {
            var vEndTime = new Time();
            vEndTime.ticks = String(Math.round(vSpec.destEnd));
            foundV.clip.end = vEndTime;
          }
        } catch (endErr) {}
        try { if (vSpec.disabled) foundV.clip.disabled = true; } catch (disErr) {}
        var qePlacedV = smoothyShortsCutsQeClip(seq, qeSeq, true, destVIdx, foundV.index);
        smoothyShortsCutsRestoreClipComponents(foundV.clip, qePlacedV, true, vSpec.components, vSpec.tickDelta);
        placedClips.push(foundV.clip);
        nestPlaced++;
      }
    }

    // Strip any auto-linked audio clips spawned by video overwriteClip so our
    // inner audio tracks match the nested sequence exactly.
    for (var cat = 0; cat < seq.audioTracks.numTracks; cat++) {
      var caTrack = seq.audioTracks[cat];
      for (var cac = caTrack.clips.numItems - 1; cac >= 0; cac--) {
        var caClip = caTrack.clips[cac];
        var cKey = cat + "|" + String(caClip.start.ticks) + "|" + (caClip.projectItem ? String(caClip.projectItem.nodeId || "") : "");
        if (!audioSnapshot[cKey]) {
          try { caClip.remove(false, false); } catch (e) {}
        }
      }
    }

    for (var iaIdx = 0; iaIdx < innerAudios.length; iaIdx++) {
      var aSpec = innerAudios[iaIdx];
      var destAIdx = audioBaseTrack + aSpec.trackOffset;
      if (destAIdx >= seq.audioTracks.numTracks) continue;
      var destATrack = seq.audioTracks[destAIdx];
      var savedA = smoothyShortsCutsSaveItemBounds(aSpec.projectItem, 2);
      try {
        try {
          aSpec.projectItem.setInPoint(String(Math.round(aSpec.srcIn)), 2);
          aSpec.projectItem.setOutPoint(String(Math.round(aSpec.srcOut)), 2);
        } catch (abErr) {
          aSpec.projectItem.setInPoint(String(Math.round(aSpec.srcIn)), 4);
          aSpec.projectItem.setOutPoint(String(Math.round(aSpec.srcOut)), 4);
        }
        var aTime = new Time();
        aTime.ticks = String(Math.round(aSpec.destStart));
        destATrack.overwriteClip(aSpec.projectItem, aTime);
      } catch (aovErr) {
        if (details.length < 4) details.push("Could not place an audio clip: " + aovErr.message);
      } finally {
        smoothyShortsCutsRestoreItemBounds(aSpec.projectItem, 2, savedA);
      }
      var foundA = smoothyShortsCutsFindClipNear(destATrack, aSpec.destStart, aSpec.nodeId, frameTicks);
      if (foundA) {
        try {
          if (Math.abs(Number(foundA.clip.end.ticks) - aSpec.destEnd) > frameTicks) {
            var aEndTime = new Time();
            aEndTime.ticks = String(Math.round(aSpec.destEnd));
            foundA.clip.end = aEndTime;
          }
        } catch (aEndErr) {}
        try { if (aSpec.disabled) foundA.clip.disabled = true; } catch (aDisErr) {}
        var qePlacedA = smoothyShortsCutsQeClip(seq, qeSeq, false, destAIdx, foundA.index);
        smoothyShortsCutsRestoreClipComponents(foundA.clip, qePlacedA, false, aSpec.components, aSpec.tickDelta);
        placedClips.push(foundA.clip);
        nestPlaced++;
      }
    }

    if (nestPlaced > 0) {
      unnestedCount++;
      placedTotal += nestPlaced;
    }
  }

  for (var pc = 0; pc < placedClips.length; pc++) {
    try { placedClips[pc].setSelected(true, false); } catch (e) {}
  }

  if (!unnestedCount) {
    return JSON.stringify({ success: false, error: "Could not unnest the selected sequence.", details: details });
  }
  var message = "Unnested " + unnestedCount + (unnestedCount === 1 ? " sequence (" : " sequences (") + placedTotal + (placedTotal === 1 ? " clip)." : " clips).");
  return JSON.stringify({ success: true, applied: placedTotal, message: message, details: details });
}

function smoothyShortsCutsScanForAdjustmentLayer(bin) {
  if (!bin || !bin.children) return null;
  var fallback = null;
  for (var i = 0; i < bin.children.numItems; i++) {
    var child = bin.children[i];
    if (!child) continue;
    if (child.type === ProjectItemType.BIN) {
      var nested = smoothyShortsCutsScanForAdjustmentLayer(child);
      if (nested) return nested;
      continue;
    }
    try {
      if (typeof child.isAdjustmentLayer === "function" && child.isAdjustmentLayer()) return child;
    } catch (e) {}
    if (!fallback) {
      try {
        var isSeq = typeof child.isSequence === "function" && child.isSequence();
        var mediaPath = typeof child.getMediaPath === "function" ? String(child.getMediaPath() || "") : "";
        if (child.type === ProjectItemType.CLIP && !isSeq && !mediaPath && /adjustment\s*layer/i.test(String(child.name || ""))) {
          fallback = child;
        }
      } catch (e) {}
    }
  }
  return fallback;
}

function smoothyShortsCutsFindAdjustmentLayerItem(seq) {
  // Check clips already on the active sequence first (exact match for sequence settings).
  if (seq && seq.videoTracks) {
    for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
      var track = seq.videoTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        try {
          if (typeof clip.isAdjustmentLayer === "function" && clip.isAdjustmentLayer() && clip.projectItem) {
            return clip.projectItem;
          }
        } catch (e) {}
      }
    }
  }
  return smoothyShortsCutsScanForAdjustmentLayer(app.project.rootItem);
}

function smoothyShortsCutsTrackHasOverlap(track, startTicks, endTicks) {
  if (!track || !track.clips) return false;
  for (var i = 0; i < track.clips.numItems; i++) {
    var clip = track.clips[i];
    var cs = Number(clip.start.ticks);
    var ce = Number(clip.end.ticks);
    if (ce > startTicks && cs < endTicks) return true;
  }
  return false;
}

function smoothyShortsCutsAddAdjustmentLayer(seq, qeSeq, payload) {
  var adjItem = smoothyShortsCutsFindAdjustmentLayerItem(seq);
  if (!adjItem) {
    return JSON.stringify({
      success: false,
      code: "NO_ADJUSTMENT_LAYER",
      error: "No Adjustment Layer in this project yet."
    });
  }

  var TICKS_PER_SECOND = 254016000000;
  var selected = smoothyShortsCutsSelected(seq, true);
  var startTicks = 0, endTicks = 0, minTrack = 0;

  if (selected.length > 0) {
    startTicks = Number(selected[0].clip.start.ticks);
    endTicks = Number(selected[0].clip.end.ticks);
    minTrack = selected[0].track + 1;
    for (var i = 1; i < selected.length; i++) {
      var s = Number(selected[i].clip.start.ticks);
      var e = Number(selected[i].clip.end.ticks);
      if (s < startTicks) startTicks = s;
      if (e > endTicks) endTicks = e;
      if (selected[i].track + 1 > minTrack) minTrack = selected[i].track + 1;
    }
  } else {
    var hasInOut = false;
    try {
      var inT = seq.getInPointAsTime ? Number(seq.getInPointAsTime().ticks) : -1;
      var outT = seq.getOutPointAsTime ? Number(seq.getOutPointAsTime().ticks) : -1;
      if (inT >= 0 && outT > inT) {
        startTicks = inT;
        endTicks = outT;
        hasInOut = true;
      }
    } catch (e) {}
    if (!hasInOut) {
      startTicks = Number(seq.getPlayerPosition().ticks) || 0;
      var durSec = Number(payload && payload.duration) > 0 ? Number(payload.duration) : 5;
      endTicks = startTicks + Math.round(durSec * TICKS_PER_SECOND);
    }
    var highestOccupied = -1;
    for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
      if (smoothyShortsCutsTrackHasOverlap(seq.videoTracks[vt], startTicks, endTicks)) {
        highestOccupied = vt;
      }
    }
    minTrack = highestOccupied + 1;
  }

  var targetTrackIdx = minTrack;
  while (targetTrackIdx < seq.videoTracks.numTracks &&
         smoothyShortsCutsTrackHasOverlap(seq.videoTracks[targetTrackIdx], startTicks, endTicks)) {
    targetTrackIdx++;
  }
  if (targetTrackIdx >= seq.videoTracks.numTracks) {
    var toAdd = targetTrackIdx - seq.videoTracks.numTracks + 1;
    if (typeof qeSeq.addTracks === "function") {
      try { qeSeq.addTracks(toAdd, seq.videoTracks.numTracks, 0); } catch (e) {}
    }
  }
  if (targetTrackIdx >= seq.videoTracks.numTracks) {
    return JSON.stringify({ success: false, error: "Could not add a video track for the Adjustment Layer." });
  }

  var destTrack = seq.videoTracks[targetTrackIdx];
  var wantedDur = Math.max(1, Math.round(endTicks - startTicks));
  var savedBounds = smoothyShortsCutsSaveItemBounds(adjItem, 1);
  try {
    try {
      adjItem.setInPoint("0", 1);
      adjItem.setOutPoint(String(wantedDur), 1);
    } catch (bErr) {}
    var placeTime = new Time();
    placeTime.ticks = String(Math.round(startTicks));
    destTrack.overwriteClip(adjItem, placeTime);
  } finally {
    smoothyShortsCutsRestoreItemBounds(adjItem, 1, savedBounds);
  }

  var frameTicks = 10160640000;
  try { frameTicks = Number(seq.timebase) || frameTicks; } catch (e) {}
  var placed = smoothyShortsCutsFindClipNear(destTrack, startTicks, String(adjItem.nodeId || ""), frameTicks);
  if (placed) {
    try {
      var targetEnd = new Time();
      targetEnd.ticks = String(Math.round(endTicks));
      placed.clip.end = targetEnd;
    } catch (endErr) {}
    // Select only the new Adjustment Layer so subsequent effects or multi-action steps target it.
    for (var st = 0; st < seq.videoTracks.numTracks; st++) {
      var tr = seq.videoTracks[st];
      for (var sc = 0; sc < tr.clips.numItems; sc++) {
        try { tr.clips[sc].setSelected(false, false); } catch (e) {}
      }
    }
    try { placed.clip.setSelected(true, false); } catch (e) {}
  }

  return JSON.stringify({
    success: true,
    applied: 1,
    message: "Added Adjustment Layer on V" + (targetTrackIdx + 1) + "."
  });
}

function applyShortsCut(payloadJSON) {
  try {
    var payload = JSON.parse(payloadJSON);
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Open a sequence first." });
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return JSON.stringify({ success: false, error: "Could not read the active sequence." });
    if (payload.kind === "preset") return smoothyShortsCutsApplyPreset(seq, qeSeq, payload);
    if (payload.kind === "motion-to-transform") return smoothyShortsCutsMoveMotionToTransform(seq, qeSeq);
    if (payload.kind === "unnest") return smoothyShortsCutsUnnest(seq, qeSeq);
    if (payload.kind === "adjustment-layer") return smoothyShortsCutsAddAdjustmentLayer(seq, qeSeq, payload);
    var video = payload.kind === "video-effect" || payload.kind === "video-transition";
    var pairs = smoothyShortsCutsSelected(seq, video);
    if (!pairs.length) {
      return JSON.stringify({ success: false, error: video ? "Select one or more video clips." : "Select one or more audio clips." });
    }
    var isTransition = payload.kind === "video-transition" || payload.kind === "audio-transition";
    var sequenceFps = 25;
    try { sequenceFps = 1 / seq.getSettings().videoFrameRate.seconds; } catch (fpsError) { sequenceFps = 25; }
    var applied = 0, failed = 0, details = [];
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var qeClip = smoothyShortsCutsQeClip(seq, qeSeq, video, pair.track, pair.index);
      if (!qeClip) {
        failed++;
        if (details.length < 4) details.push("Could not map the selected clip on track " + (pair.track + 1) + ".");
        continue;
      }
      try {
        if (isTransition) {
          var edges = payload.edge === "both" ? [false, true] : [payload.edge === "start" ? false : true];
          for (var e = 0; e < edges.length; e++) {
            smoothyShortsCutsAddTransition(qeClip, video, payload.target || "", edges[e], payload.duration, sequenceFps);
          }
          applied++;
        } else {
          smoothyShortsCutsAddEffect(qeClip, video, payload.target || "");
          applied++;
        }
      } catch (error) {
        failed++;
        if (details.length < 4) details.push(error.message || "Premiere rejected the change.");
      }
    }
    var noun = isTransition ? "transition" : "effect";
    var message = "Applied " + (payload.target || (isTransition ? "the default transition" : noun)) + " to " + applied + (applied === 1 ? " clip." : " clips.");
    if (failed) message += " " + failed + " clip(s) could not be changed.";
    return JSON.stringify({ success: applied > 0, applied: applied, failed: failed, message: message, details: details });
  } catch (e) {
    return JSON.stringify({ success: false, error: "ShortsCuts failed: " + e.message });
  }
}

function captureShortsCutPreset() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Open a sequence first." });
    var videoPairs = smoothyShortsCutsSelected(seq, true);
    var audioPairs = smoothyShortsCutsSelected(seq, false);
    var mediaType = videoPairs.length ? "video" : (audioPairs.length ? "audio" : null);
    var pair = mediaType === "video" ? videoPairs[0] : audioPairs[0];
    if (!pair) return JSON.stringify({ success: false, error: "Select a clip with effects first." });
    var components = [], total = 0;
    for (var i = 0; i < pair.clip.components.numItems; i++) {
      var component = pair.clip.components[i];
      if (String(component.matchName) === "AE.ADBE Time Remapping") continue;
      var properties = [];
      try {
        for (var j = 0; j < component.properties.numItems && total < 600; j++) {
          var property = component.properties[j];
          var value = smoothyShortsCutsValue(property.getValue());
          if (value === null) continue;
          properties.push({ name: String(property.displayName || ""), value: value });
          total++;
        }
      } catch (e) {
        // Skip properties this Premiere build cannot read.
      }
      components.push({
        matchName: String(component.matchName || ""),
        displayName: String(component.displayName || component.matchName || ""),
        properties: properties
      });
    }
    if (!components.length) return JSON.stringify({ success: false, error: "This clip has no readable effects to capture." });
    return JSON.stringify({ success: true, name: String(pair.clip.name || "Selected clip"), mediaType: mediaType, components: components });
  } catch (e) {
    return JSON.stringify({ success: false, error: "Could not capture this preset: " + e.message });
  }
}

// ---------------------------------------------------------------------------
// Smoothy Pro animated captions
// ---------------------------------------------------------------------------
// Places one Motion Graphics Template clip per caption (Box Highlight, Word
// Rise, Word Slide or Outline; the panel picks the template file through
// payload.mogrtPath) on a
// new video track at the top of the active sequence. The template animates
// each word while it is spoken, driven by its "Word Timings" parameter
// ("start,end;…" seconds from the clip start). Templates are built by
// smoothyedit-app/scripts/pro-captions/build-mogrt.mjs. A template that lacks
// a parameter (Rise has no box, only Outline has a stroke) skips that value.
// Every setter takes updateUI: only the last write on a clip refreshes
// Premiere, which keeps a long caption send from redrawing on every value.
function smoothyProCaptionSetText(param, value, updateUI) {
  if (!param) return;
  var text = String(value).replace(/\r\n|\n/g, "\r");
  var raw = param.getValue();
  var parsed = null;
  try { parsed = JSON.parse(raw); } catch (ignored) { parsed = null; }
  if (parsed && typeof parsed === "object" && typeof parsed.textEditValue !== "undefined") {
    parsed.textEditValue = text;
    parsed.fontTextRunLength = [text.length];
    param.setValue(JSON.stringify(parsed), updateUI);
  } else {
    param.setValue(text, updateUI);
  }
}
function smoothyProCaptionByte(v) { return Math.max(0, Math.min(255, Math.round(Number(v) || 0))); }
function smoothyProCaptionSetColor(param, rgb, updateUI) {
  if (!param || !rgb || rgb.length < 3) return;
  param.setColorValue(255, smoothyProCaptionByte(rgb[0]), smoothyProCaptionByte(rgb[1]), smoothyProCaptionByte(rgb[2]), updateUI);
}
function smoothyProCaptionSetNumber(param, value, updateUI) {
  if (!param || typeof value !== "number" || !isFinite(value)) return;
  param.setValue(value, updateUI);
}
// Caption templates are authored at 3840x2160 (sharp in 4K); Premiere places a
// template at its own size, so scale each clip to the sequence frame.
var SMOOTHY_PRO_CAPTION_COMP_WIDTH = 3840, SMOOTHY_PRO_CAPTION_COMP_HEIGHT = 2160;
function smoothyProCaptionFitToSequence(clip, seq) {
  var w = Number(seq.frameSizeHorizontal), h = Number(seq.frameSizeVertical);
  if (!(w > 0 && h > 0)) return;
  var scale = 100 * Math.min(w / SMOOTHY_PRO_CAPTION_COMP_WIDTH, h / SMOOTHY_PRO_CAPTION_COMP_HEIGHT);
  if (Math.abs(scale - 100) < 0.001) return;
  for (var c = 0; c < clip.components.numItems; c++) {
    var component = clip.components[c];
    if (component.displayName !== "Motion") continue;
    for (var p = 0; p < component.properties.numItems; p++) {
      if (component.properties[p].displayName === "Scale") { component.properties[p].setValue(scale, false); return; }
    }
  }
}
function smoothyProCaptionSetCheckbox(param, value, updateUI) {
  if (!param || typeof value !== "boolean") return;
  param.setValue(value, updateUI);
}
// True when the template already holds this value, so the write can be skipped.
// Any read problem returns false and the value is written as before.
function smoothyProCaptionMatches(param, kind, value) {
  try {
    if (!param) return true;
    if (kind === "color") {
      var current = param.getColorValue();
      if (!current || current.length < 4 || !value || value.length < 3) return false;
      for (var i = 0; i < 3; i++) if (Number(current[i + 1]) !== smoothyProCaptionByte(value[i])) return false;
      var alpha = Number(current[0]); // Premiere 26.5 reports opaque as 1
      return alpha === 255 || alpha === 1;
    }
    if (kind === "checkbox") { var on = param.getValue(); return typeof on === "boolean" && on === value; }
    if (typeof value !== "number" || !isFinite(value)) return true;
    return Math.abs(Number(param.getValue()) - value) < 0.0001;
  } catch (ignored) { return false; }
}
function smoothyProCaptionWrite(param, kind, value, updateUI) {
  if (kind === "text") smoothyProCaptionSetText(param, value, updateUI);
  else if (kind === "color") smoothyProCaptionSetColor(param, value, updateUI);
  else if (kind === "checkbox") smoothyProCaptionSetCheckbox(param, value, updateUI);
  else smoothyProCaptionSetNumber(param, value, updateUI);
}
// Places another instance of the already imported template item. Each
// instance keeps its own Graphic Parameters (verified in Premiere 26.5: a copy
// starts at the template defaults, and its text renders independently), and
// this skips re-reading the .mogrt that importMGT does per call. Returns null
// when the copy cannot be confirmed so the caller falls back to importMGT.
function smoothyProCaptionPlaceCopy(track, item, startTicks) {
  try {
    var before = track.clips.numItems;
    track.overwriteClip(item, startTicks);
    if (track.clips.numItems !== before + 1) return null;
    for (var i = track.clips.numItems - 1; i >= 0; i--) {
      var candidate = track.clips[i];
      if (String(candidate.start.ticks) !== startTicks) continue;
      return candidate.getMGTComponent() ? candidate : null;
    }
  } catch (ignored) {}
  return null;
}
// Clip name in the timeline: the words of the caption on one line.
function smoothyProCaptionName(text) {
  var name = String(text).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  return name.length > 120 ? name.substring(0, 119) + "\u2026" : (name || "Caption");
}
function smoothyImportProCaptions(payloadJSON) {
  var TICKS = 254016000000;
  try {
    var payload = JSON.parse(payloadJSON);
    if (!app.project) return JSON.stringify({ success: false, error: "Open a Premiere project first." });
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "Open a sequence in Premiere first." });
    if (payload.sequenceId && String(seq.sequenceID) !== String(payload.sequenceId)) {
      return JSON.stringify({ success: false, error: "The active sequence changed. Refresh the sequence in Smoothy and try again." });
    }
    var captions = payload.captions || [];
    if (!captions.length) return JSON.stringify({ success: false, error: "No captions to place." });
    var mogrt = new File(payload.mogrtPath);
    if (!mogrt.exists) return JSON.stringify({ success: false, error: "The Pro caption template is missing. Reinstall the Premiere panel from Smoothy." });

    // Always add a fresh top track so existing edits are never overwritten.
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq || typeof qeSeq.addTracks !== "function") return JSON.stringify({ success: false, error: "This Premiere version cannot add a caption track." });
    var before = seq.videoTracks.numTracks;
    qeSeq.addTracks(1, before, 0);
    if (seq.videoTracks.numTracks !== before + 1 || seq.videoTracks[before].clips.numItems) {
      return JSON.stringify({ success: false, error: "Premiere could not add an empty video track for the captions." });
    }
    var trackIndex = before;
    var track = seq.videoTracks[trackIndex];
    try { track.name = "Smoothy Captions"; } catch (ignored) {}

    var style = payload.style || {};
    // Style values are the same on every caption. The first clip shows which
    // differ from the template defaults; later clips only write those.
    var styleWrites = [
      ["Text Color", "color", style.textColor],
      ["Caption Size", "number", style.size],
      ["Vertical Position", "number", style.verticalPosition],
      ["Upcoming Word Opacity", "number", style.upcomingOpacity],
      ["Box Color", "color", style.boxColor],
      ["Box Opacity", "number", style.boxOpacity],
      ["Box Radius", "number", style.boxRadius],
      ["Box Padding", "number", style.boxPadding],
      ["Box Height", "number", style.boxHeight],
      ["Shadow Opacity", "number", style.shadowOpacity],
      ["Highlight Color", "color", style.highlightColor],
      ["Stroke Color", "color", style.strokeColor],
      ["Stroke Width", "number", style.strokeWidth]
    ];
    var styleChecked = false, popInDefault = null;
    // The first caption imports the template; later ones place copies of it.
    var templateItem = null, trackEndTicks = 0, copied = 0;
    var placed = 0, failed = 0, firstError = "";
    var started = new Date().getTime();
    for (var i = 0; i < captions.length; i++) {
      var cap = captions[i];
      try {
        var start = Number(cap.start), end = Number(cap.end);
        if (!(end > start) || start < 0) throw new Error("invalid timing");
        var startTicks = String(Math.round(start * TICKS));
        var clip = null;
        // Copies are placed only after the last caption so their default
        // length never covers a caption already on the track.
        if (templateItem && Math.round(start * TICKS) >= trackEndTicks) {
          clip = smoothyProCaptionPlaceCopy(track, templateItem, startTicks);
          if (clip) copied++; else templateItem = null;
        }
        if (!clip) {
          clip = seq.importMGT(mogrt.fsName, startTicks, trackIndex, 0);
          if (!clip) throw new Error("Premiere did not place the template");
          if (!templateItem && !placed) { try { templateItem = clip.projectItem || null; } catch (ignored) { templateItem = null; } }
        }
        clip.end = end;
        trackEndTicks = Math.max(trackEndTicks, Math.round(end * TICKS));
        try { clip.name = smoothyProCaptionName(cap.text); } catch (ignored) {}
        smoothyProCaptionFitToSequence(clip, seq);
        var params = clip.getMGTComponent().properties;
        if (!styleChecked) {
          var changed = [];
          for (var s = 0; s < styleWrites.length; s++) {
            if (!smoothyProCaptionMatches(params.getParamForDisplayName(styleWrites[s][0]), styleWrites[s][1], styleWrites[s][2])) changed.push(styleWrites[s]);
          }
          styleWrites = changed;
          try { var popParam = params.getParamForDisplayName("Pop In"); var pop = popParam ? popParam.getValue() : null; popInDefault = typeof pop === "boolean" ? pop : null; } catch (ignored) { popInDefault = null; }
          styleChecked = true;
        }
        var writes = [["Caption Text", "text", cap.text], ["Word Timings", "text", cap.timings]].concat(styleWrites);
        if (typeof cap.popIn === "boolean" && cap.popIn !== popInDefault) writes.push(["Pop In", "checkbox", cap.popIn]);
        for (var w = 0; w < writes.length; w++) {
          smoothyProCaptionWrite(params.getParamForDisplayName(writes[w][0]), writes[w][1], writes[w][2], w === writes.length - 1);
        }
        placed++;
      } catch (capError) {
        failed++;
        if (!firstError) firstError = "Caption " + (i + 1) + ": " + capError.message;
      }
    }
    if (!placed) return JSON.stringify({ success: false, error: firstError || "No captions were placed." });
    return JSON.stringify({
      success: true,
      count: placed,
      failed: failed,
      track: trackIndex + 1,
      copied: copied,
      seconds: Math.round((new Date().getTime() - started) / 100) / 10,
      message: "Placed " + placed + " animated caption" + (placed === 1 ? "" : "s") + " on V" + (trackIndex + 1) + (failed ? " (" + failed + " skipped: " + firstError + ")" : "") + "."
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: "Could not place Pro captions: " + e.message });
  }
}
