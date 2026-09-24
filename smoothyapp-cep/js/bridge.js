/**
 * SmoothyEdit CEP Bridge
 *
 * Headless bridge between Electron app and Premiere Pro.
 * Shows connection status and relays commands.
 */

(function() {
  'use strict';

  const csInterface = new CSInterface();
  const HOST_SCRIPT_VERSION = '20260419-marker-host-v5';
  const MARKER_PAYLOAD_CHUNK_SIZE = 8000;
  let ws = null;
  let isConnected = false;
  let reconnectTimer = null;
  let hostScriptLoaded = false;

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  function updateStatus(connected, message) {
    isConnected = connected;
    statusDot.className = 'status-dot' + (connected ? ' connected' : '');
    statusText.textContent = message;
  }

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    try {
      ws = new WebSocket('ws://localhost:3456');

      ws.onopen = function() {
        updateStatus(true, 'Connected to SmoothyEdit');
        clearInterval(reconnectTimer);

        // Identify ourselves
        send({ type: 'pluginConnected', pluginType: 'cep', bridgeVersion: HOST_SCRIPT_VERSION });

        // Send initial sequence info
        sendSequenceInfo();
      };

      ws.onclose = function() {
        updateStatus(false, 'Disconnected - Reconnecting...');
        startReconnect();
      };

      ws.onerror = function() {
        updateStatus(false, 'Connection failed');
      };

      ws.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (e) {
          console.error('Invalid message:', e);
        }
      };
    } catch (e) {
      updateStatus(false, 'Failed to connect');
      startReconnect();
    }
  }

  function startReconnect() {
    if (reconnectTimer) clearInterval(reconnectTimer);
    reconnectTimer = setInterval(connect, 3000);
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function getHostScriptPath() {
    return csInterface.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/') + '/jsx/host.jsx';
  }

  function ensureHostScriptLoaded(callback) {
    if (hostScriptLoaded) {
      callback({ success: true, version: HOST_SCRIPT_VERSION });
      return;
    }

    const hostScriptPath = JSON.stringify(getHostScriptPath());
    const script = [
      'var __smoothyHostLoadResult = "";',
      'try {',
      '  $.evalFile(' + hostScriptPath + ');',
      '  if (typeof getSmoothyCepHostVersion === "function") {',
      '    __smoothyHostLoadResult = getSmoothyCepHostVersion();',
      '  } else {',
      '    __smoothyHostLoadResult = "missing-host-version";',
      '  }',
      '} catch (e) {',
      '  __smoothyHostLoadResult = "HOST_LOAD_ERROR: " + e.message;',
      '}',
      '__smoothyHostLoadResult;'
    ].join('\n');

    csInterface.evalScript(script, function(result) {
      if (result === HOST_SCRIPT_VERSION) {
        hostScriptLoaded = true;
        callback({ success: true, version: result });
        return;
      }

      callback({
        success: false,
        error: 'Failed to load SmoothyEdit host script from ' + getHostScriptPath() + ' | Result: ' + result
      });
    });
  }

  function handleMessage(data) {
    console.log('[Bridge] Received:', data.type);

    switch (data.type) {
      case 'welcome':
        break;

      case 'getSequenceInfo':
        sendSequenceInfo();
        break;

      case 'importXML':
        importXML(data.xmlPath);
        break;

      case 'removeSilence':
        removeSilenceInPlace(data.silenceSegments);
        break;

      case 'exportAudio':
        exportAudioForWebsite();
        break;

      case 'addMarkers':
        addMarkersToSequence(data.markers);
        break;

      case 'clearMarkers':
        clearAllMarkers();
        break;

      case 'cutMarkedShorts':
        cutMarkedShorts(data.options);
        break;

      case 'exportSubtitles':
        exportSubtitles();
        break;

      case 'importCaptions':
        importCaptions(data.captions);
        break;
    }
  }

  function importCaptions(captions) {
    const captionsJson = JSON.stringify(captions).replace(/'/g, "\\'");
    csInterface.evalScript(`importCaptions('${captionsJson}')`, function(result) {
      try {
        const res = JSON.parse(result);
        send({
          type: 'captionsImported',
          success: res.success,
          count: res.count,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        send({ type: 'captionsImported', success: false, error: 'Failed to import captions: ' + e.message });
      }
    });
  }

  function exportSubtitles() {
    csInterface.evalScript('exportSubtitles()', function(result) {
      try {
        var res = JSON.parse(result);
        send({
          type: 'subtitlesExported',
          success: res.success,
          subtitles: res.subtitles,
          srt: res.srt,
          count: res.count,
          sequenceName: res.sequenceName,
          source: res.source,
          error: res.error
        });
      } catch (e) {
        send({ type: 'subtitlesExported', success: false, error: 'Failed to export subtitles: ' + e.message });
      }
    });
  }

  function clearAllMarkers() {
    csInterface.evalScript('clearAllMarkers()', function(result) {
      try {
        var res = JSON.parse(result);
        send({
          type: 'markersCleared',
          success: res.success,
          count: res.count,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        send({ type: 'markersCleared', success: false, error: 'Failed to parse response: ' + result });
      }
    });
  }

  function cutMarkedShorts(options) {
    var optionsStr = options ? JSON.stringify(options) : "{}";
    csInterface.evalScript('cutMarkedShorts(' + JSON.stringify(optionsStr) + ')', function(result) {
      try {
        var res = JSON.parse(result);
        send({
          type: 'markedShortsCut',
          success: res.success,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        send({ type: 'markedShortsCut', success: false, error: 'Failed to parse response: ' + result });
      }
    });
  }

  function sendSequenceInfo() {
    csInterface.evalScript('getSequenceInfo()', function(result) {
      try {
        const info = JSON.parse(result);
        send({
          type: 'sequenceInfo',
          ...info
        });
      } catch (e) {
        send({ type: 'sequenceInfo', error: 'Failed to get sequence' });
      }
    });
  }

  function importXML(xmlPath) {
    const escaped = xmlPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    csInterface.evalScript(`importFCPXML('${escaped}')`, function(result) {
      try {
        const res = JSON.parse(result);
        send({
          type: 'xmlImported',
          success: res.success,
          error: res.error
        });
      } catch (e) {
        send({ type: 'xmlImported', success: false, error: 'Import failed' });
      }
    });
  }

  function removeSilenceInPlace(silenceSegments) {
    // Convert to JSON string for ExtendScript
    const segmentsJson = JSON.stringify(silenceSegments).replace(/'/g, "\\'");
    // Use QE DOM to extract (ripple delete) silence regions
    csInterface.evalScript(`removeSilenceWithQE('${segmentsJson}')`, function(result) {
      try {
        const res = JSON.parse(result);
        send({
          type: 'silenceRemoved',
          success: res.success,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        send({ type: 'silenceRemoved', success: false, error: 'Failed to remove silence: ' + e.message });
      }
    });
  }

  function exportAudioForWebsite() {
    csInterface.evalScript('exportSequenceAudio()', function(result) {
      try {
        const res = JSON.parse(result);
        if (!res.success || !res.filePath) {
          send({ type: 'audioExported', success: false, error: res.error || 'Premiere did not create an audio file.' });
          return;
        }
        const nodeRequire = window.cep_node && window.cep_node.require;
        if (!nodeRequire) {
          send({ type: 'audioExported', success: false, error: 'CEP Node access is unavailable, so the temporary audio file cannot be read.' });
          return;
        }
        const fs = nodeRequire('fs');
        fs.readFile(res.filePath, function(readError, buffer) {
          if (readError) {
            send({ type: 'audioExported', success: false, error: 'Failed to read exported audio: ' + readError.message });
            return;
          }
          try { fs.unlinkSync(res.filePath); } catch (_) {}
          send({
            type: 'audioExported',
            success: true,
            audioBase64: buffer.toString('base64'),
            fileName: res.fileName,
            fileSize: res.fileSize || buffer.length,
            duration: res.duration
          });
        });
      } catch (e) {
        send({ type: 'audioExported', success: false, error: 'Export failed: ' + e.message });
      }
    });
  }

  function stageEncodedMarkerPayload(encodedMarkers, callback) {
    const chunks = [];
    for (let i = 0; i < encodedMarkers.length; i += MARKER_PAYLOAD_CHUNK_SIZE) {
      chunks.push(encodedMarkers.slice(i, i + MARKER_PAYLOAD_CHUNK_SIZE));
    }

    csInterface.evalScript('$.global.SMOOTHY_MARKER_PAYLOAD_ENCODED = ""; "OK";', function(resetResult) {
      if (resetResult !== 'OK') {
        callback({
          success: false,
          error: 'Failed to initialize marker payload in Premiere: ' + resetResult
        });
        return;
      }

      let index = 0;
      function appendNextChunk() {
        if (index >= chunks.length) {
          callback({ success: true, chunks: chunks.length, bytes: encodedMarkers.length });
          return;
        }

        const chunk = chunks[index];
        const script = '$.global.SMOOTHY_MARKER_PAYLOAD_ENCODED += ' + JSON.stringify(chunk) + '; "OK";';
        csInterface.evalScript(script, function(chunkResult) {
          if (chunkResult !== 'OK') {
            callback({
              success: false,
              error: 'Failed to stage marker payload chunk ' + (index + 1) + '/' + chunks.length + ': ' + chunkResult
            });
            return;
          }

          index++;
          appendNextChunk();
        });
      }

      appendNextChunk();
    });
  }

  function evalMarkerResultScript(script, loadResult, stageResult) {
    csInterface.evalScript(script, function(result) {
      try {
        const res = JSON.parse(result);
        console.log('[Bridge] Markers result:', res);
        if (res.debug) {
          console.log('[Bridge] Debug:', res.debug);
        }
        send({
          type: 'markersAdded',
          success: res.success,
          count: res.count,
          error: res.error,
          debug: res.debug
        });
      } catch (e) {
        const raw = typeof result === 'string' ? result.slice(0, 300) : String(result);
        console.error('[Bridge] Failed to parse marker result:', raw);
        const diagnosticsScript = [
          'var __smoothyDiag = "";',
          'try {',
          '  if (typeof getSmoothyMarkerDiagnostics === "function") {',
          '    __smoothyDiag = getSmoothyMarkerDiagnostics();',
          '  } else {',
          '    __smoothyDiag = "diagnostics unavailable";',
          '  }',
          '} catch (e) {',
          '  __smoothyDiag = "diagnostics failed: " + e.message;',
          '}',
          '__smoothyDiag;'
        ].join('\n');
        csInterface.evalScript(diagnosticsScript, function(diagnostics) {
          send({
            type: 'markersAdded',
            success: false,
            error: 'Failed to add markers: ' + e.message + ' | Premiere response: ' + raw + ' | Host script: ' + loadResult.version + ' | Payload chunks: ' + stageResult.chunks + ' | Diagnostics: ' + diagnostics
          });
        });
      }
    });
  }

  function addMarkersToSequence(markers) {
    const markersJson = JSON.stringify(markers || []);
    const encodedMarkers = encodeURIComponent(markersJson);

    ensureHostScriptLoaded(function(loadResult) {
      if (!loadResult.success) {
        send({
          type: 'markersAdded',
          success: false,
          error: loadResult.error
        });
        return;
      }

      if (encodedMarkers.length <= MARKER_PAYLOAD_CHUNK_SIZE) {
        const directScript = [
          'function __smoothyJsonEscape(value) {',
          '  return String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\"").replace(/\\r/g, " ").replace(/\\n/g, " ");',
          '}',
          'var __smoothyMarkerResult = "";',
          'try {',
          '  __smoothyMarkerResult = addMarkersFromWebsiteEncoded(' + JSON.stringify(encodedMarkers) + ');',
          '} catch (e) {',
          '  __smoothyMarkerResult = "{\\"success\\":false,\\"error\\":\\"Marker eval failed: " + __smoothyJsonEscape(e.message) + "\\"}";',
          '}',
          '__smoothyMarkerResult;'
        ].join('\n');
        evalMarkerResultScript(directScript, loadResult, { chunks: 0, direct: true });
        return;
      }

      stageEncodedMarkerPayload(encodedMarkers, function(stageResult) {
        if (!stageResult.success) {
          send({
            type: 'markersAdded',
            success: false,
            error: stageResult.error + ' | Host script: ' + loadResult.version
          });
          return;
        }

        const script = [
          'var __smoothyMarkerResult = "";',
          'try {',
          '  __smoothyMarkerResult = addMarkersFromStagedWebsitePayload();',
          '} catch (e) {',
          '  __smoothyMarkerResult = JSON.stringify({ success: false, error: "Marker eval failed: " + e.message });',
          '}',
          '__smoothyMarkerResult;'
        ].join('\n');

        evalMarkerResultScript(script, loadResult, stageResult);
      });
    });
  }

  // Initialize
  updateStatus(false, 'Starting...');
  connect();

})();
