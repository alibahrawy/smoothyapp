import { createLocalAudioPlayer } from './local-audio-player.js';

const MODES = {
  denoise: {
    button: 'Remove Noise',
    rerun: 'Re-run Remove Noise',
    task: 'Removing background noise',
    startMessage: 'Removing background noise directly from your recording…',
    doneMessage: 'Background noise removed. Compare Original vs Clean Audio below.',
    retry: 'Retry noise removal',
  },
  separate: {
    button: 'Separate Tracks',
    rerun: 'Re-run Separation',
    task: 'Separating voice and music',
    startMessage: 'Separating voice and music into two tracks…',
    doneMessage: 'Voice and Music tracks are ready.',
    retry: 'Retry separation',
  },
  isolate: {
    button: 'Isolate Clean Voice',
    rerun: 'Re-run Isolate Voice',
    task: 'Isolating clean voice',
    startMessage: 'Removing background music and noise to isolate clean voice…',
    doneMessage: 'Clean voice is ready. Music and noise are removed.',
    retry: 'Retry voice isolation',
  },
};

const BACKEND_NAMES = {
  mps: 'Apple Metal',
  cuda: 'NVIDIA CUDA',
  directml: 'Windows DirectML',
  cpu: 'CPU',
};

export function initLocalAudio() {
  const api = window.electronAPI;
  const el = id => document.getElementById(`local-audio-${id}`);
  const root = el('root');
  const dropzone = el('dropzone');
  const modeButtons = Array.from(document.querySelectorAll('[data-audio-mode]'));

  let activeMode = 'denoise';
  let source = null;
  const cache = { denoise: null, separate: null, isolate: null };
  let ready = null;
  let backend = null;
  let busy = false;
  let operation = null;
  let canceling = false;
  let actionId = 0;
  let timer;
  let retry = false;
  let retryMode = 'denoise';
  let stateFailure = null;
  let measured = null;

  const playbackStatus = (text, isError = false) => {
    const node = el('playback-status');
    node.textContent = text;
    node.classList.toggle('hidden', !text);
    node.classList.toggle('cleanup-playback-error', isError);
    node.setAttribute('role', isError ? 'alert' : 'status');
  };

  const player = createLocalAudioPlayer(el('results'), {
    preview: id => api.localAudioPreview(id),
    error: text => playbackStatus(text, true),
    save: async (output, options = {}) => {
      const payload = options.strength !== undefined && options.strength < 100
        ? { id: output.id, strength: options.strength }
        : output.id;
      const result = await api.localAudioSave(payload);
      if (!busy) {
        const savedLabel = options.strength !== undefined && options.strength < 100
          ? `${output.label} (${options.strength}%) saved.`
          : `${output.label} saved.`;
        playbackStatus(result.canceled ? 'Save canceled.' : result.error || savedLabel, Boolean(result.error));
      }
    },
    onCleanVoiceFromSeparated: context => {
      selectMode('isolate', { preserveStatus: true });
      void processAudio('isolate', context);
    },
  });

  const status = (text, isError = false) => {
    measured = null;
    renderProgress();
    el('feedback').classList.toggle('hidden', !text && !busy);
    el('feedback').classList.toggle('has-error', isError);
    el('status').setAttribute('role', isError ? 'alert' : 'status');
    el('status').setAttribute('aria-live', isError ? 'assertive' : 'polite');
    el('status').textContent = text;
  };

  function renderProgress() {
    const bar = el('progress');
    const known = busy && measured && measured.total > 0;
    bar.classList.toggle('hidden', !known);
    for (const attr of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) bar.removeAttribute(attr);
    if (known) {
      const completed = Math.min(measured.completed || 0, measured.total);
      const percent = Math.floor((completed / measured.total) * 100);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(measured.total));
      bar.setAttribute('aria-valuenow', String(completed));
      const counts = measured.unit === 'bytes'
        ? `${(completed / 1048576).toFixed(1)} / ${(measured.total / 1048576).toFixed(1)} MB`
        : `${completed} / ${measured.total} ${measured.unit || 'steps'}`;
      const text = `${counts} · ${percent}% of this stage`;
      bar.setAttribute('aria-valuetext', text);
      bar.querySelector('span').style.width = `${percent}%`;
      el('progress-hint').textContent = text;
    } else {
      bar.querySelector('span').style.width = '0%';
      el('progress-hint').textContent = operation === 'setup'
        ? 'Installing the local runtime and checking models. Progress appears when the download size is known.'
        : operation === 'pick'
          ? 'Decoding your recording…'
          : 'Loading or writing audio. Progress appears as chunks are processed.';
    }
  }

  function taskLabel(kind) {
    if (kind === 'pick') return 'Preparing original audio';
    if (kind === 'setup') return 'Setting up local audio engine';
    return MODES[kind]?.task || 'Processing audio';
  }

  const sync = () => {
    const info = MODES[activeMode] || MODES.denoise;
    const hasCached = Boolean(source && cache[activeMode]);

    for (const button of modeButtons) {
      const selected = button.dataset.audioMode === activeMode;
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('has-result', Boolean(source && cache[button.dataset.audioMode]));
      button.setAttribute('aria-checked', String(selected));
      button.disabled = busy;
    }

    el('pick').disabled = busy;
    el('pick').textContent = source ? 'Change file' : 'Choose file';
    el('run').disabled = busy || !source;
    el('run').textContent = hasCached ? info.rerun : info.button;
    el('run').classList.toggle('btn-primary', !hasCached);
    el('run').classList.toggle('btn-secondary', hasCached);

    el('source').classList.toggle('is-empty', !source);
    el('setup-note').classList.toggle('hidden', ready !== false);
    if (!el('device').textContent && ready === true && backend) {
      el('device').textContent = `Runs locally on ${BACKEND_NAMES[backend] || backend}.`;
    }

    el('cancel').classList.toggle('hidden', !busy);
    el('cancel').disabled = canceling;
    el('cancel').textContent = canceling ? 'Canceling…' : 'Cancel';

    el('retry').classList.toggle('hidden', busy || !retry || !source);
    el('retry').textContent = MODES[retryMode]?.retry || 'Retry';

    el('setup').classList.toggle('hidden', busy || !retry || !source || !el('feedback').classList.contains('has-error'));
    el('feedback').classList.toggle('is-processing', busy);
    el('activity').classList.toggle('hidden', !busy);
    el('progress').setAttribute('aria-label', busy ? taskLabel(operation) : 'Audio processing in progress');
    el('progress-hint').classList.toggle('hidden', !busy);
    renderProgress();
    el('task').textContent = busy ? (canceling ? 'Canceling audio operation' : taskLabel(operation)) : '';
    player.setBusy(busy);
  };

  function loadViewForMode(context = {}) {
    if (!source) {
      player.load({});
      return;
    }
    const outputs = cache[activeMode] || [];
    player.load({ source, mode: activeMode, outputs }, { time: context.time });
  }

  function selectMode(mode, options = {}) {
    if (busy || !MODES[mode] || mode === activeMode) return;
    const context = player.getState();
    activeMode = mode;
    retry = false;
    if (!options.preserveStatus) {
      status(source && cache[activeMode] ? MODES[activeMode].doneMessage : '');
      playbackStatus('');
    }
    loadViewForMode(context);
    sync();
  }

  for (const button of modeButtons) {
    button.addEventListener('click', () => selectMode(button.dataset.audioMode));
  }

  const runAction = async (kind, work) => {
    if (busy) return false;
    busy = true;
    operation = kind;
    canceling = false;
    retry = false;
    actionId++;
    player.pause();
    playbackStatus('');
    const started = performance.now();
    const elapsed = () => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      el('elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`;
    };
    elapsed();
    timer = setInterval(elapsed, 1000);
    status(kind === 'pick' ? 'Preparing your recording…' : 'Starting audio processing…');
    sync();
    el('operation').scrollIntoView({ block: 'nearest' });
    try { return await work(); }
    catch (err) {
      retry = kind !== 'pick';
      status(err.message || 'Audio action failed.', true);
      return false;
    } finally {
      clearInterval(timer);
      busy = false;
      canceling = false;
      operation = null;
      sync();
      if (!el('status').textContent) el('feedback').classList.add('hidden');
      if (el('feedback').classList.contains('has-error')) el('operation').scrollIntoView({ block: 'nearest' });
    }
  };

  const statePromise = api.localAudioState().then(result => {
    if (result.success === false) throw Error(result.error || 'Could not check the audio engine.');
    ready = result.ready === true;
    backend = result.backend || null;
    sync();
    return ready;
  }).catch(err => { stateFailure = err; });

  api.onLocalAudioProgress(data => {
    if (!busy || canceling || typeof data?.message !== 'string') return;
    if (data.backend) {
      el('device').textContent = data.message;
      return;
    }
    status(data.message);
    if (Number.isFinite(data.completed) && data.completed >= 0 && Number.isFinite(data.total) && data.total > 0) {
      measured = data;
      renderProgress();
    }
  });

  async function acceptSelectedSource(loader) {
    await runAction('pick', async () => {
      const result = await loader();
      if (result?.source) {
        source = result.source;
        cache.denoise = null;
        cache.separate = null;
        cache.isolate = null;
        el('source').textContent = source.name;
        el('source').title = source.name;
        loadViewForMode();
        status('');
        return true;
      }
      if (result?.error) throw Error(result.error);
      status(result?.canceled && canceling ? 'Canceled. Your previous audio is unchanged.' : '');
      return false;
    });
  }

  el('pick').addEventListener('click', () => void acceptSelectedSource(() => api.localAudioPick()));

  if (root && dropzone) {
    root.addEventListener('dragover', event => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      dropzone.classList.toggle('drag-over', !busy);
    });
    root.addEventListener('dragleave', event => {
      if (!event.relatedTarget || !root.contains(event.relatedTarget)) dropzone.classList.remove('drag-over');
    });
    root.addEventListener('drop', async event => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length && !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dropzone.classList.remove('drag-over');
      if (busy) return;
      if (files.length !== 1) { status('Drop one audio or video file at a time.', true); return; }
      const filePath = api.getDroppedFilePath?.(files[0]);
      if (!filePath) { status('Could not read the dropped file path. Use Choose file.', true); return; }
      await acceptSelectedSource(() => api.localAudioSelect(filePath));
    });
  }

  async function processAudio(mode = activeMode, context = player.getState(), repair = false) {
    if (!source || busy || !MODES[mode]) return;
    retryMode = mode;
    const info = MODES[mode];
    const completed = await runAction(mode, async () => {
      await statePromise;
      if (stateFailure) {
        const result = await api.localAudioState();
        if (result.success === false) throw Error(result.error || 'Could not check the audio engine.');
        ready = result.ready === true;
        backend = result.backend || null;
        stateFailure = null;
      }
      if (!ready || repair) {
        operation = 'setup';
        sync();
        status('Downloading and preparing the local audio engine…');
        const result = await api.localAudioSetup();
        ready = result.ready === true;
        if (result.backend) backend = result.backend;
        if (!result.success) {
          retry = true;
          status(result.canceled ? 'Setup canceled. You can retry.' : result.error || 'Audio engine setup failed.', !result.canceled);
          return false;
        }
        if (!ready) throw Error('Audio engine setup did not finish. Try again.');
      }
      if (canceling) { retry = true; status('Canceled. Your original audio is unchanged.'); return false; }

      operation = mode;
      sync();
      status(info.startMessage);
      const result = await api.localAudioRun({ source: source.id, mode });
      if (!result.success) {
        retry = true;
        status(result.canceled ? 'Canceled. Your original audio is unchanged.' : result.error || 'Audio processing failed. Try again.', !result.canceled);
        return false;
      }
      cache[mode] = result.outputs;
      activeMode = mode;
      loadViewForMode(context);
      status(info.doneMessage);
      return true;
    });

    if (completed) {
      el('results').scrollIntoView({ block: 'nearest' });
      if (context.resume && document.getElementById('tab-local-audio').classList.contains('active')) {
        void player.play();
      }
    }
  }

  el('run').addEventListener('click', () => void processAudio(activeMode));
  el('retry').addEventListener('click', () => void processAudio(retryMode));
  el('setup').addEventListener('click', () => void processAudio(retryMode, player.getState(), true));
  el('cancel').addEventListener('click', async () => {
    if (!busy || canceling) return;
    const current = actionId;
    canceling = true;
    sync();
    status('Canceling… Waiting for the audio engine to stop.');
    try {
      const result = await api.localAudioCancel();
      if (result?.success === false) throw Error(result.error || 'Could not cancel audio processing.');
    } catch (err) {
      if (busy && current === actionId) {
        canceling = false;
        sync();
        status(err.message || 'Could not cancel audio processing.', true);
      }
    }
  });

  sync();
}
