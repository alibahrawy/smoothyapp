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

var SMOOTHY_CEP_HOST_VERSION = "20261001-review-host-v22";

function getSmoothyCepHostVersion() {
  return SMOOTHY_CEP_HOST_VERSION;
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
function getSequenceInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) {
      return JSON.stringify({ hasSequence: false, error: "No active sequence" });
    }

    var settings = seq.getSettings();

    var info = {
      hasSequence: true,
      name: seq.name,
      id: seq.sequenceID,
      duration: seq.end.seconds,
      fps: settings.videoFrameRate ? (1 / settings.videoFrameRate.seconds) : 30,
      width: settings.videoFrameWidth,
      height: settings.videoFrameHeight,
      markerCount: seq.markers.numMarkers,
      audioTracks: [],
      videoTracks: []
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
            path: aClip.projectItem.getMediaPath(),
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
            path: vClip.projectItem.getMediaPath(),
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

    // Try to find an audio preset
    var presetsFolder = new Folder(Folder.appPackage.fsName + "/MediaIO/systempresets/58444341_4d703300/");
    if (presetsFolder.exists) {
      var presets = presetsFolder.getFiles("*.epr");
      if (presets.length > 0) {
        presetPath = presets[0].fsName;
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
        var startTime = safeMarkerTime(m.time || m.startTime || m.start);
        var endTime = safeMarkerTime(m.endTime || m.end || m.outTime || m.out);
        if (endTime <= 0 || endTime <= startTime) {
          endTime = startTime + 60; // Default 60 second duration
        }

        // Short number for display
        var shortNum = i + 1;
        var shortName = "Short " + shortNum;

        // Pick a color for this short (cycles through 7 distinct colors)
        var colorIndex = colors[i % colors.length];

        // Create START marker
        var startMarker = seqMarkers.createMarker(startTime);
        if (startMarker) {
          safeSetMarkerName(startMarker, "START: " + shortName);
          startMarker.comments = "[SmoothyEdit] Short start";
          safeSetMarkerColor(startMarker, colorIndex);
          addedCount++;
        }

        // Create END marker
        var endMarker = seqMarkers.createMarker(endTime);
        if (endMarker) {
          safeSetMarkerName(endMarker, "END: " + shortName);
          endMarker.comments = "[SmoothyEdit] Short end";
          safeSetMarkerColor(endMarker, colorIndex);
          addedCount++;
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
    if (!sequenceId || String(seq.sequenceID) !== String(sequenceId)) {
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
