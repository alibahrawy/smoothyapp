/**
 * SmoothyEdit CEP Bridge
 *
 * Headless bridge between Electron app and Premiere Pro.
 * Shows connection status and relays commands.
 */

(function() {
  'use strict';

  const csInterface = new CSInterface();
  const HOST_SCRIPT_VERSION = '20261001-review-host-v22';
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

  // The Electron app writes a per-install secret next to the panel. Presenting
  // it lets the local WebSocket server trust this panel over any other client.
  function getBridgeToken() {
    var configPath;
    try {
      var ext = csInterface.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, '/');
      configPath = ext + '/smoothy-config.json';
    } catch (e) {
      return null;
    }

    // Preferred: Node's fs (available when the panel loads with --enable-nodejs).
    try {
      var nodeRequire = window.cep_node && window.cep_node.require;
      if (nodeRequire) {
        var fs = nodeRequire('fs');
        if (fs.existsSync(configPath)) {
          var parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (parsed && typeof parsed.bridgeToken === 'string') return parsed.bridgeToken;
        }
      }
    } catch (e) {
      // Fall through to the CEP fs bridge.
    }

    // Fallback: the built-in CEP fs API, which does not require Node.
    try {
      if (window.cep && window.cep.fs && window.cep.fs.readFile) {
        var result = window.cep.fs.readFile(configPath);
        if (result && result.err === 0 && result.data) {
          var parsedCep = JSON.parse(result.data);
          if (parsedCep && typeof parsedCep.bridgeToken === 'string') return parsedCep.bridgeToken;
        }
      }
    } catch (e) {
      // Ignore; treated as "no token".
    }

    return null;
  }

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    try {
      // Loopback only — the server does not listen on the network.
      const token = getBridgeToken();
      const wsUrl = 'ws://127.0.0.1:3456' + (token ? '?token=' + encodeURIComponent(token) : '');
      ws = new WebSocket(wsUrl);

      ws.onopen = function() {
        updateStatus(true, 'Connected to SmoothyEdit');
        clearInterval(reconnectTimer);

        // Identify ourselves
        send({ type: 'pluginConnected', pluginType: 'cep', bridgeVersion: HOST_SCRIPT_VERSION, protocolVersion: 2 });

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
    // Re-read host.jsx before each call that needs it, so an edit is picked up
    // after the panel reloads once, without requiring a Premiere restart.
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

      // A version that still loads but does not match means Premiere is running
      // an older copy of the panel.
      if (typeof result === 'string' && result.indexOf('HOST_LOAD_ERROR') !== 0 && result !== 'missing-host-version') {
        callback({
          success: false,
          stale: true,
          error: 'The SmoothyEdit panel in Premiere is out of date (' + result + '). Reinstall the latest app, then reopen the panel in Premiere.'
        });
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
        importXML(data.xmlPath, data.requestId);
        break;

      case 'removeSilence':
        removeSilenceInPlace(data.silenceSegments, data.sequenceId, data.requestId);
        break;

      case 'exportAudio':
        exportAudioForWebsite(data.requestId);
        break;

      case 'addMarkers':
        addMarkersToSequence(data.markers, data.requestId);
        break;

      case 'clearMarkers':
        clearAllMarkers(data.scope, data.sequenceId, data.requestId);
        break;

      case 'cutMarkedShorts':
        cutMarkedShorts(data.options);
        break;

      case 'exportSubtitles':
        exportSubtitles(data.requestId);
        break;

      case 'importCaptions':
        importCaptions(data.srtPath, data.requestId);
        break;

      case 'importImage':
        importImageToTimeline(data.imagePath, data.durationSeconds, data.requestId);
        break;
    }
  }

  function importImageToTimeline(imagePath, durationSeconds, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    if (!imagePath) {
      reply({ type: 'imageImported', success: false, error: 'No image path provided' });
      return;
    }

    ensureHostScriptLoaded(function(loadResult) {
      if (!loadResult.success) {
        reply({ type: 'imageImported', success: false, error: loadResult.error });
        return;
      }

      const escaped = String(imagePath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : 5;

      csInterface.evalScript("importImageToTimeline('" + escaped + "', " + duration + ")", function(result) {
        try {
          const res = JSON.parse(result);
          reply({
            type: 'imageImported',
            success: res.success,
            message: res.message,
            error: res.error
          });
        } catch (e) {
          const raw = typeof result === 'string' ? result.slice(0, 300) : String(result);
          reply({
            type: 'imageImported',
            success: false,
            error: 'Failed to import image: ' + e.message + ' | Premiere response: ' + raw
          });
        }
      });
    });
  }

  function importCaptions(srtPath, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    if (!srtPath) {
      reply({ type: 'captionsImported', success: false, error: 'No caption file path provided' });
      return;
    }
    const escaped = String(srtPath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    csInterface.evalScript(`importCaptions('${escaped}')`, function(result) {
      try {
        const res = JSON.parse(result);
        reply({
          type: 'captionsImported',
          success: res.success,
          count: res.count,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        const raw = typeof result === 'string' ? result.slice(0, 300) : String(result);
        reply({ type: 'captionsImported', success: false, error: 'Failed to import captions: ' + e.message + ' | Premiere response: ' + raw });
      }
    });
  }

  function exportSubtitles(requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    csInterface.evalScript('exportSubtitles()', function(result) {
      try {
        var res = JSON.parse(result);
        reply({
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
        reply({ type: 'subtitlesExported', success: false, error: 'Failed to export subtitles: ' + e.message });
      }
    });
  }

  function clearAllMarkers(scope, sequenceId, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    csInterface.evalScript('clearAllMarkers(' + JSON.stringify(scope || 'smoothy') + ', ' + JSON.stringify(sequenceId || '') + ')', function(result) {
      try {
        var res = JSON.parse(result);
        reply({
          type: 'markersCleared',
          success: res.success,
          count: res.count,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        reply({ type: 'markersCleared', success: false, error: 'Failed to parse response: ' + result });
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

  function importXML(xmlPath, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    const escaped = xmlPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    csInterface.evalScript(`importFCPXML('${escaped}')`, function(result) {
      try {
        const res = JSON.parse(result);
        reply({
          type: 'xmlImported',
          success: res.success,
          error: res.error
        });
      } catch (e) {
        reply({ type: 'xmlImported', success: false, error: 'Import failed' });
      }
    });
  }

  function removeSilenceInPlace(silenceSegments, sequenceId, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    // Convert to JSON string for ExtendScript
    const segmentsJson = JSON.stringify({ segments: silenceSegments, sequenceId: sequenceId });
    const encoded = encodeURIComponent(segmentsJson);
    // Use QE DOM to extract (ripple delete) silence regions
    csInterface.evalScript(`removeSilenceWithQE(decodeURIComponent('${encoded}'))`, function(result) {
      try {
        const res = JSON.parse(result);
        reply({
          type: 'silenceRemoved',
          success: res.success,
          message: res.message,
          error: res.error
        });
      } catch (e) {
        reply({ type: 'silenceRemoved', success: false, error: 'Failed to remove silence: ' + e.message });
      }
    });
  }

  function exportAudioForWebsite(requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    csInterface.evalScript('exportSequenceAudio()', function(result) {
      try {
        const res = JSON.parse(result);
        if (!res.success || !res.filePath) {
          reply({ type: 'audioExported', success: false, error: res.error || 'Premiere did not create an audio file.' });
          return;
        }
        const nodeRequire = window.cep_node && window.cep_node.require;
        if (!nodeRequire) {
          reply({ type: 'audioExported', success: false, error: 'CEP Node access is unavailable, so the temporary audio file cannot be read.' });
          return;
        }
        const fs = nodeRequire('fs');
        fs.readFile(res.filePath, function(readError, buffer) {
          if (readError) {
            reply({ type: 'audioExported', success: false, error: 'Failed to read exported audio: ' + readError.message });
            return;
          }
          try { fs.unlinkSync(res.filePath); } catch (_) {}
          reply({
            type: 'audioExported',
            success: true,
            audioBase64: buffer.toString('base64'),
            fileName: res.fileName,
            fileSize: res.fileSize || buffer.length,
            duration: res.duration
          });
        });
      } catch (e) {
        reply({ type: 'audioExported', success: false, error: 'Export failed: ' + e.message });
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

  function evalMarkerResultScript(script, loadResult, stageResult, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    csInterface.evalScript(script, function(result) {
      try {
        const res = JSON.parse(result);
        console.log('[Bridge] Markers result:', res);
        if (res.debug) {
          console.log('[Bridge] Debug:', res.debug);
        }
        reply({
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
          reply({
            type: 'markersAdded',
            success: false,
            error: 'Failed to add markers: ' + e.message + ' | Premiere response: ' + raw + ' | Host script: ' + loadResult.version + ' | Payload chunks: ' + stageResult.chunks + ' | Diagnostics: ' + diagnostics
          });
        });
      }
    });
  }

  function addMarkersToSequence(markers, requestId) {
    const reply = (message) => send(Object.assign({}, message, { requestId: requestId }));
    const markersJson = JSON.stringify(markers || []);
    const encodedMarkers = encodeURIComponent(markersJson);

    ensureHostScriptLoaded(function(loadResult) {
      if (!loadResult.success) {
        reply({
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
        evalMarkerResultScript(directScript, loadResult, { chunks: 0, direct: true }, requestId);
        return;
      }

      stageEncodedMarkerPayload(encodedMarkers, function(stageResult) {
        if (!stageResult.success) {
          reply({
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

        evalMarkerResultScript(script, loadResult, stageResult, requestId);
      });
    });
  }

  // Initialize
  updateStatus(false, 'Starting...');
  connect();

})();
