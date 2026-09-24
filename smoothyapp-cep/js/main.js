/**
 * AutoCut Panel - Main JavaScript
 *
 * Reads audio/video tracks from the active Premiere sequence,
 * lets user map audio tracks to speakers and video tracks to cameras,
 * then generates cuts based on who is speaking.
 */

(function() {
  'use strict';

  const CONFIG = {
    serverUrl: 'http://localhost:3847',
  };

  const state = {
    csInterface: null,
    inPremiere: false,
    sequenceInfo: null,
    isProcessing: false,
  };

  // ==================================================
  // Initialization
  // ==================================================

  function init() {
    console.log('AutoCut Panel initializing...');

    // Initialize CEP interface
    try {
      state.csInterface = new CSInterface();
      const hostEnv = state.csInterface.getHostEnvironment();
      if (hostEnv && hostEnv.appName) {
        state.inPremiere = true;
        console.log('Running in:', hostEnv.appName);
      }
    } catch (e) {
      console.log('Running outside Premiere');
      state.csInterface = null;
      state.inPremiere = false;
    }

    setupEventListeners();
    checkServerHealth();

    // Auto-load sequence info
    if (state.inPremiere) {
      setTimeout(loadSequenceInfo, 500);
    }
  }

  function setupEventListeners() {
    document.getElementById('refresh-btn').addEventListener('click', loadSequenceInfo);
    document.getElementById('autocut-btn').addEventListener('click', runAutoCut);
    document.getElementById('error-close-btn').addEventListener('click', () => {
      document.getElementById('error-modal').classList.add('hidden');
    });

    document.getElementById('use-wide-shot').addEventListener('change', (e) => {
      document.getElementById('wide-shot-config').classList.toggle('hidden', !e.target.checked);
    });

    document.getElementById('min-cut-duration').addEventListener('input', (e) => {
      document.getElementById('min-cut-value').textContent = `${e.target.value}s`;
    });

    document.getElementById('hold-time').addEventListener('input', (e) => {
      document.getElementById('hold-time-value').textContent = `${e.target.value}s`;
    });
  }

  // ==================================================
  // Load Sequence Info from Premiere
  // ==================================================

  function loadSequenceInfo() {
    if (!state.inPremiere || !state.csInterface) {
      showError('Not running in Premiere Pro');
      return;
    }

    setStatus('Loading sequence...', 'idle');

    state.csInterface.evalScript('getSequenceInfo()', (result) => {
      console.log('Sequence info result:', result);

      try {
        const info = JSON.parse(result);

        if (info.error) {
          document.getElementById('sequence-name').textContent = 'No sequence loaded';
          document.getElementById('sequence-details').textContent = info.error;
          document.getElementById('audio-tracks-list').innerHTML = '<p class="empty-message">Open a sequence first</p>';
          document.getElementById('video-tracks-list').innerHTML = '<p class="empty-message">Open a sequence first</p>';
          document.getElementById('autocut-btn').disabled = true;
          document.getElementById('footer-status').textContent = 'Open a sequence to begin';
          return;
        }

        state.sequenceInfo = info;
        displaySequenceInfo(info);
        setStatus('Ready', 'idle');

      } catch (e) {
        console.error('Failed to parse sequence info:', e);
        showError('Failed to read sequence: ' + e.message);
      }
    });
  }

  function displaySequenceInfo(info) {
    // Sequence name and details
    document.getElementById('sequence-name').textContent = info.name;
    document.getElementById('sequence-details').textContent =
      `${Math.round(info.duration)}s | ${Math.round(info.fps)}fps | ${info.width}x${info.height}`;

    // Audio tracks
    const audioList = document.getElementById('audio-tracks-list');
    if (info.audioTracks.length === 0) {
      audioList.innerHTML = '<p class="empty-message">No audio tracks with clips found</p>';
    } else {
      audioList.innerHTML = '';
      info.audioTracks.forEach((track, index) => {
        const clipNames = track.clips.map(c => c.name).join(', ');
        const trackEl = document.createElement('div');
        trackEl.className = 'track-item';
        trackEl.innerHTML = `
          <div class="track-info">
            <input type="checkbox" class="track-checkbox audio-track-cb" data-track-index="${track.index}" checked>
            <span class="track-name">${track.name}</span>
            <span class="track-clips">${clipNames}</span>
          </div>
          <div class="track-mapping">
            <label>Speaker:</label>
            <input type="text" class="speaker-name" data-track-index="${track.index}" value="Speaker ${index + 1}" placeholder="Speaker name">
          </div>
        `;
        audioList.appendChild(trackEl);
      });
    }

    // Video tracks
    const videoList = document.getElementById('video-tracks-list');
    const wideSelect = document.getElementById('wide-camera-select');
    wideSelect.innerHTML = '<option value="-1">None</option>';

    if (info.videoTracks.length === 0) {
      videoList.innerHTML = '<p class="empty-message">No video tracks with clips found</p>';
    } else {
      videoList.innerHTML = '';
      info.videoTracks.forEach((track, index) => {
        const clipNames = track.clips.map(c => c.name).join(', ');
        const trackEl = document.createElement('div');
        trackEl.className = 'track-item';
        trackEl.innerHTML = `
          <div class="track-info">
            <input type="checkbox" class="track-checkbox video-track-cb" data-track-index="${track.index}" checked>
            <span class="track-name">${track.name}</span>
            <span class="track-clips">${clipNames}</span>
          </div>
          <div class="track-mapping">
            <label>Camera:</label>
            <select class="camera-index" data-track-index="${track.index}">
              ${generateCameraOptions(info.videoTracks.length, index)}
            </select>
          </div>
        `;
        videoList.appendChild(trackEl);

        // Add to wide shot dropdown
        wideSelect.innerHTML += `<option value="${index}">Camera ${index + 1} (${track.name})</option>`;
      });
    }

    // Enable button if we have both audio and video
    const hasAudio = info.audioTracks.length > 0;
    const hasVideo = info.videoTracks.length > 0;
    document.getElementById('autocut-btn').disabled = !(hasAudio && hasVideo);
    document.getElementById('footer-status').textContent =
      hasAudio && hasVideo ? 'Ready to process' : 'Need audio and video tracks';
  }

  function generateCameraOptions(count, defaultIndex) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `<option value="${i}" ${i === defaultIndex ? 'selected' : ''}>Camera ${i + 1}</option>`;
    }
    return html;
  }

  // ==================================================
  // Server Communication
  // ==================================================

  async function checkServerHealth() {
    try {
      const response = await fetch(`${CONFIG.serverUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await response.json();
      if (data.status === 'ok') {
        console.log('Server healthy');
      }
    } catch (e) {
      setStatus('Server offline - start Node server', 'error');
      console.error('Server check failed:', e);
    }
  }

  async function runAutoCut() {
    if (state.isProcessing || !state.sequenceInfo) return;

    // Gather selected audio tracks and their speaker mappings
    const audioMappings = [];
    document.querySelectorAll('.audio-track-cb:checked').forEach(cb => {
      const trackIndex = parseInt(cb.dataset.trackIndex);
      const track = state.sequenceInfo.audioTracks.find(t => t.index === trackIndex);
      const speakerInput = document.querySelector(`.speaker-name[data-track-index="${trackIndex}"]`);
      const speakerName = speakerInput ? speakerInput.value : `speaker_${trackIndex}`;

      if (track && track.clips.length > 0) {
        audioMappings.push({
          trackIndex: trackIndex,
          speaker: speakerName.toLowerCase().replace(/\s+/g, '_'),
          path: track.clips[0].path,  // Use first clip's path
          trackName: track.name
        });
      }
    });

    // Gather selected video tracks and their camera mappings
    const videoMappings = [];
    document.querySelectorAll('.video-track-cb:checked').forEach(cb => {
      const trackIndex = parseInt(cb.dataset.trackIndex);
      const track = state.sequenceInfo.videoTracks.find(t => t.index === trackIndex);
      const cameraSelect = document.querySelector(`.camera-index[data-track-index="${trackIndex}"]`);
      const cameraIndex = cameraSelect ? parseInt(cameraSelect.value) : trackIndex;

      if (track && track.clips.length > 0) {
        videoMappings.push({
          trackIndex: trackIndex,
          camera: cameraIndex,
          path: track.clips[0].path,
          trackName: track.name
        });
      }
    });

    if (audioMappings.length === 0) {
      showError('Please select at least one audio track');
      return;
    }

    if (videoMappings.length === 0) {
      showError('Please select at least one video track');
      return;
    }

    // Build sources for the server
    // Each audio track becomes a "source" with its speaker name
    // We map speakers to cameras
    const sources = audioMappings.map((audio, index) => {
      // Try to find matching video by index or use first video
      const video = videoMappings[index] || videoMappings[0];
      return {
        path: audio.path,
        speaker: audio.speaker,
        camera: video ? video.camera : index
      };
    });

    // Build clip info for XML (one per video track/camera)
    const clips = videoMappings.map(v => ({
      name: v.trackName,
      path: v.path,
      camera: v.camera
    }));

    const useWideShot = document.getElementById('use-wide-shot').checked;
    const wideIndex = useWideShot ? parseInt(document.getElementById('wide-camera-select').value) : -1;

    const options = {
      sequenceName: state.sequenceInfo.name + ' - AutoCut',
      fps: state.sequenceInfo.fps,
      width: state.sequenceInfo.width,
      height: state.sequenceInfo.height,
      duration: state.sequenceInfo.duration,
      minCutDuration: parseFloat(document.getElementById('min-cut-duration').value),
      holdTime: parseFloat(document.getElementById('hold-time').value),
      wideCameraIndex: wideIndex,
      clips: clips  // Send video clip info for XML generation
    };

    console.log('AutoCut request:', { sources, options });

    state.isProcessing = true;
    showProgress('Extracting audio...');

    try {
      setProgress(10, 'Sending to server...');

      const response = await fetch(`${CONFIG.serverUrl}/autocut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, options })
      });

      setProgress(50, 'Analyzing speech...');

      const result = await response.json();

      if (result.success) {
        setProgress(80, 'Importing XML...');

        // Import the XML into Premiere
        await importXML(result.xmlPath);

        hideProgress();
        setStatus(`Done! ${result.stats.shots} cuts`, 'success');
        document.getElementById('footer-status').textContent =
          `Created ${result.stats.shots} cuts from ${result.stats.segments} speech segments`;
      } else {
        throw new Error(result.error || 'Processing failed');
      }

    } catch (e) {
      hideProgress();
      setStatus('Error', 'error');
      showError('AutoCut failed: ' + e.message);
      console.error('AutoCut error:', e);
    }

    state.isProcessing = false;
  }

  async function importXML(xmlPath) {
    return new Promise((resolve) => {
      if (!state.csInterface || !state.inPremiere) {
        console.log('Dev mode: XML at', xmlPath);
        resolve();
        return;
      }

      const escaped = xmlPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      state.csInterface.evalScript(`importFCPXML('${escaped}')`, (result) => {
        console.log('Import result:', result);
        resolve();
      });
    });
  }

  // ==================================================
  // UI Helpers
  // ==================================================

  function setStatus(text, type) {
    const bar = document.getElementById('status-bar');
    const txt = document.getElementById('status-text');
    bar.className = `status-bar status-${type}`;
    txt.textContent = text;
  }

  function showProgress(msg) {
    document.getElementById('progress-overlay').classList.remove('hidden');
    document.getElementById('progress-text').textContent = msg;
    document.getElementById('progress-fill').style.width = '0%';
  }

  function setProgress(pct, msg) {
    if (msg) document.getElementById('progress-text').textContent = msg;
    document.getElementById('progress-fill').style.width = `${pct}%`;
  }

  function hideProgress() {
    document.getElementById('progress-overlay').classList.add('hidden');
  }

  function showError(msg) {
    document.getElementById('error-message').textContent = msg;
    document.getElementById('error-modal').classList.remove('hidden');
  }

  // ==================================================
  // Start
  // ==================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
