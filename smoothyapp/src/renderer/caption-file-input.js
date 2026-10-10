/** Local input only: drop/pick never starts transcription or emits telemetry. */
export function initCaptionFileInput({ api, root, zone, browse, busy, selected, error }) {
  let pending = false;
  const accept = result => {
    if (busy() || result?.canceled) return;
    if (result?.path && result.success !== false) selected(result.path);
    else if (result?.error) error(result.error);
  };
  const choose = async () => {
    if (busy() || pending) return;
    pending = true;
    try { accept(await api.selectCaptionAudio()); }
    catch (err) { error(err.message || 'Could not open file picker.'); }
    finally { pending = false; }
  };
  browse?.addEventListener('click', choose);
  zone?.addEventListener('click', choose);
  zone?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
  });
  root?.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy() || pending ? 'none' : 'copy';
    zone?.classList.toggle('drag-over', !busy() && !pending);
  });
  root?.addEventListener('dragleave', event => {
    if (!event.relatedTarget || !root.contains(event.relatedTarget)) zone?.classList.remove('drag-over');
  });
  root?.addEventListener('drop', async event => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length && !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    zone?.classList.remove('drag-over');
    if (busy() || pending) return;
    if (files.length !== 1) { error('Drop one audio or video file at a time.'); return; }
    pending = true;
    try {
      const filePath = api.getDroppedFilePath(files[0]);
      if (!filePath) throw new Error('This item has no local file path. Use Choose File.');
      accept(await api.validateCaptionAudio(filePath));
    } catch (err) { error(err.message || 'Could not read the dropped file.'); }
    finally { pending = false; }
  });
  return { choose };
}
