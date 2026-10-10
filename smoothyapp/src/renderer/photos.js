import catalog from '../shared/photo-catalog.json';
import { createPhotoPicker } from './photo-picker.js';
import { estimatePhotoCredits, formatPhotoEstimate } from './photo-credit-estimate.js';
import googleLogo from './model-logos/google.png';
import openaiLogo from './model-logos/openai.png';
import fluxLogo from './model-logos/black-forest-labs.png';
import seedLogo from './model-logos/bytedance-seed.png';
import grokLogo from './model-logos/x-ai.png';
import riverflowLogo from './model-logos/sourceful.png';

export function initPhotos({ getUser, signIn, refreshCredits }) {
  const $ = id => document.getElementById(id);
  const api = window.electronAPI;
  let messages = [], history = [], references = [], selected = null, showHistory = false;
  let page = 1, pages = 1, busy = false, stopBatch = false, account = null, generation = 0, historyLoading = false, filesLoading = false;
  const presets = new Set();
  let viewerPhoto = null;
  const viewer = $('photos-viewer');
  const status = (message, error = false, notice = false) => {
    const visible = (error || notice) && Boolean(message);
    $('photos-status').textContent = visible ? message : '';
    $('photos-status').classList.toggle('hidden', !visible);
    $('photos-status').classList.toggle('photo-error', visible && error);
  };
  const hasSource = () => Boolean(selected || references.length);
  const action = () => presets.size ? 'preset' : hasSource() ? 'edit' : 'generate';
  const actionNames = { generate: 'Generate image', edit: 'Edit image', preset: 'Generate reactions' };
  const modelPicker = createPhotoPicker('photos-model', { searchable: true, menuWidth: 460, onChange: modelChanged });
  const ratioPicker = createPhotoPicker('photos-ratio', { onChange: availability });
  const sizePicker = createPhotoPicker('photos-size', { onChange: availability });
  const family = id => id.startsWith('google/') ? 'Google' : id.startsWith('openai/') ? 'OpenAI' : id.startsWith('black-forest-labs/') ? 'Black Forest Labs' : id.startsWith('bytedance-seed/') ? 'ByteDance' : id.startsWith('x-ai/') ? 'xAI' : id.startsWith('sourceful/') ? 'Sourceful' : id.startsWith('microsoft/') ? 'Microsoft' : id.startsWith('tencent/') ? 'Tencent' : id.startsWith('meta/') ? 'Meta' : id.startsWith('qwen/') ? 'Qwen' : id.startsWith('krea/') ? 'Krea' : id.startsWith('recraft/') ? 'Recraft' : id.startsWith('inclusionai/') ? 'inclusionAI' : 'Image model';
  const logos = { Google: googleLogo, OpenAI: openaiLogo, 'Black Forest Labs': fluxLogo, ByteDance: seedLogo, xAI: grokLogo, Sourceful: riverflowLogo };
  const monograms = { Microsoft: 'MS', Tencent: 'T', Meta: 'M', Qwen: 'Q', Krea: 'K', Recraft: 'R', inclusionAI: 'iA' };
  $('photos-estimate').classList.add('hidden');
  modelPicker.setItems(catalog.IMAGE_MODELS.map(model => {
    const description = catalog.IMAGE_MODEL_DESCRIPTIONS[model.id] || '', provider = family(model.id);
    const caps = catalog.MODEL_CAPABILITIES[model.id] || {};
    const tags = [...(/fast/i.test(description) ? ['fast'] : []), ...(/cheap|economical|cost-efficient|low.cost/i.test(description) ? ['low-cost'] : []), ...(caps.supportsImageSize && (caps.imageSizes || catalog.IMAGE_SIZES).includes('4K') ? ['4k'] : [])];
    return { value: model.id, label: model.label, description: `${provider} · ${description}`, logo: logos[provider], monogram: monograms[provider], tags };
  }), catalog.DEFAULT_IMAGE_MODEL);
  ratioPicker.setItems(catalog.ASPECT_RATIOS.map(value => ({ value, label: value })), catalog.DEFAULT_ASPECT_RATIO);
  sizePicker.setItems(catalog.IMAGE_SIZES.map(value => ({ value, label: value })), catalog.DEFAULT_IMAGE_SIZE);

  function availability() {
    const current = action(), max = catalog.MODEL_CAPABILITIES[$('photos-model').value]?.maxReferences ?? 6;
    const tooMany = (selected ? 1 : references.length) > max;
    $('photos-generate').disabled = busy || filesLoading || !getUser() || tooMany || (current !== 'preset' && !$('photos-prompt').value.trim()) || (current === 'preset' && !hasSource());
    const label = current === 'preset' ? `Generate ${presets.size} reaction${presets.size === 1 ? '' : 's'}` : actionNames[current];
    const estimate = formatPhotoEstimate(estimatePhotoCredits({ model: $('photos-model').value, imageSize: $('photos-size').value, references: selected ? 1 : references.length, promptLength: $('photos-prompt').value.length + $('photos-subject').value.length, count: presets.size || 1 }));
    $('photos-estimate').textContent = estimate;
    for (const model of catalog.IMAGE_MODELS) {
      const modelEstimate = estimatePhotoCredits({ model: model.id, imageSize: $('photos-size').value, references: selected ? 1 : references.length, promptLength: $('photos-prompt').value.length + $('photos-subject').value.length, count: 1 });
      modelPicker.setPrice(model.id, modelEstimate ? `${formatPhotoEstimate(modelEstimate)} / image` : 'Estimate unavailable');
    }
    $('photos-reactions-estimate').textContent = presets.size ? estimate : 'Choose reactions to see a total';
    $('photos-generate').title = $('photos-generate').ariaLabel = `${label} · uses Studio credits`;
    $('photos-reference-warning').textContent = tooMany ? `This model accepts up to ${max} reference pictures. Remove some attachments to send.` : '';
    $('photos-reference-warning').classList.toggle('hidden', !tooMany);
    $('photos-presets-panel').classList.toggle('hidden', !presets.size);
    $('photos-presets-summary').textContent = `${presets.size} reaction${presets.size === 1 ? '' : 's'} selected`;
    $('photos-reactions').setAttribute('aria-pressed', String(presets.size > 0));
    $('photos-prompt').placeholder = current === 'edit' ? 'Tell me what to change in this picture…' : current === 'preset' ? 'Add instructions for your reactions (optional)…' : 'Describe an image, or attach a picture to edit…';
    ['photos-files', 'photos-attach', 'photos-source-attach', 'photos-prompt', 'photos-subject', 'photos-model', 'photos-ratio', 'photos-size', 'photos-reactions', 'photos-clear-presets', 'photos-reactions-clear', 'photos-new-chat', 'photos-source-clear'].forEach(id => { $(id).disabled = busy || filesLoading; });
    document.querySelectorAll('#photos-references button').forEach(button => { button.disabled = busy || filesLoading; });
    document.querySelectorAll('#photos-presets button').forEach(button => { button.disabled = busy || filesLoading; });
    $('photos-history-prev').disabled = historyLoading || page <= 1;
    $('photos-history-next').disabled = historyLoading || page >= pages;
    $('photos-history-page').textContent = `Page ${page} of ${pages}`;
  }
  function modelChanged() {
    const model = $('photos-model').value, caps = catalog.MODEL_CAPABILITIES[model] || {};
    $('photos-size-field').classList.toggle('hidden', !caps.supportsImageSize);
    ratioPicker.setItems((caps.aspectRatios || catalog.ASPECT_RATIOS).map(value => ({ value, label: value })));
    sizePicker.setItems((caps.imageSizes || catalog.IMAGE_SIZES).map(value => ({ value, label: value })));
    availability();
  }
  $('photos-model').addEventListener('change', modelChanged);
  $('photos-prompt').addEventListener('input', availability);
  $('photos-subject').addEventListener('input', availability);
  $('photos-prompt').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('photos-generate').disabled) perform(); }
  });
  function renderReferences() {
    $('photos-attach').classList.toggle('hidden', hasSource());
    $('photos-references').replaceChildren();
    references.forEach((ref, index) => {
      const chip = document.createElement('div'); chip.className = 'photo-reference';
      const img = document.createElement('img'); img.src = ref.data; img.alt = ref.name;
      const preview = imageButton('', () => $('photos-files').click(), 'photo-reference-preview');
      preview.title = preview.ariaLabel = 'Add reference pictures'; preview.append(img);
      const remove = imageButton('×', () => { if (busy || filesLoading) return; references.splice(index, 1); renderReferences(); }, 'photo-reference-remove');
      remove.title = remove.ariaLabel = `Remove ${ref.name}`;
      chip.append(preview, remove); $('photos-references').append(chip);
    });
    $('photos-selected-source').classList.toggle('hidden', !selected);
    if (selected) $('photos-source-preview').src = selected.previewUrl; else $('photos-source-preview').removeAttribute('src');
    $('photos-source-label').textContent = selected ? `Editing: ${selected.label}` : '';
    const preview = $('photos-reactions-preview');
    preview.hidden = !hasSource();
    if (hasSource()) preview.src = selected?.previewUrl || references[0].data;
    else preview.removeAttribute('src');
    $('photos-reactions-source-help').textContent = hasSource() ? 'Your reference is ready. Choose reactions below.' : 'Add an image reference to get started.';
    availability();
  }
  async function addFiles(files) {
    if (busy || filesLoading || !getUser()) return;
    const batch = [...files], stamp = generation;
    if (!batch.length) return;
    if (batch.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return status('Choose PNG, JPEG or WebP images.', true);
    if (references.length + batch.length > 6 || references.reduce((sum, ref) => sum + ref.size, 0) + batch.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) return status('Attach up to 6 pictures, totalling less than 25 MB.', true);
    filesLoading = true; availability();
    try {
      const added = await Promise.all(batch.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read this image.'));
        reader.onload = () => resolve({ name: file.name, size: file.size, data: reader.result }); reader.readAsDataURL(file);
      })));
      if (generation !== stamp) return;
      references.push(...added); selected = null; renderReferences(); status('Pictures attached. Sending an AI action will use Studio credits.');
    } catch (error) { if (generation === stamp) status(error.message, true); }
    finally { if (generation === stamp) { filesLoading = false; availability(); } }
  }
  $('photos-attach').addEventListener('click', () => $('photos-files').click());
  $('photos-source-attach').addEventListener('click', () => $('photos-files').click());
  $('photos-files').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
  $('photos-prompt').addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } });
  const drop = $('tab-photos');
  ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); if (event.dataTransfer?.types.includes('Files')) $('photos-drop-zone').classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); $('photos-drop-zone').classList.remove('drag-over'); if (name === 'drop') addFiles(event.dataTransfer.files); }));
  $('photos-source-clear').addEventListener('click', () => { if (!busy) { selected = null; renderReferences(); } });
  $('photos-signin-btn').addEventListener('click', signIn);

  function imageButton(label, callback, className = 'stock-text-button') {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = className;
    button.addEventListener('click', callback); return button;
  }
  function usePhoto(photo) {
    if (busy || filesLoading) return;
    selected = photo; references = []; clearPresets();
    renderReferences(); setHistory(false); renderResults(); $('photos-prompt').focus(); status('Picture selected. Describe your next edit below.');
  }
  function openViewer(photo) {
    viewerPhoto = photo; $('photos-viewer-title').textContent = photo.label; $('photos-viewer-image').alt = photo.label;
    $('photos-viewer-meta').textContent = [catalog.IMAGE_MODELS.find(model => model.id === photo.model)?.label, photo.aspectRatio, photo.prompt].filter(Boolean).join(' · ');
    const image = $('photos-viewer-image'); image.removeAttribute('src');
    image.onload = () => { if (viewer.open && viewerPhoto?.id === photo.id) api.photosPreview(photo.id).catch(() => {}); image.onload = null; };
    image.src = photo.previewUrl; viewer.showModal(); $('photos-viewer-close').focus();
  }
  $('photos-viewer-close').addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', event => { if (event.target === viewer) { const r = viewer.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) viewer.close(); } });
  viewer.addEventListener('close', () => { $('photos-viewer-image').onload = null; viewerPhoto = null; });
  $('photos-viewer-use').addEventListener('click', () => { if (viewerPhoto && !busy) { usePhoto(viewerPhoto); viewer.close(); } });
  ['Save', 'Copy', 'Premiere'].forEach(action => $(`photos-viewer-${action.toLowerCase()}`).addEventListener('click', () => { if (viewerPhoto) fileAction(viewerPhoto, action); }));
  async function fileAction(photo, action) {
    const stamp = generation;
    try {
      const response = await api[`photos${action}`](photo.id);
      if (generation !== stamp) return;
      if (!response.success) throw new Error(response.error);
      if (response.canceled) return;
      status('');
    } catch (error) { if (generation === stamp) status(error.message || 'Could not use this image. Please retry.', true); }
  }
  function photoCard(photo) {
    const card = document.createElement('article'); card.className = 'photo-result-card'; card.classList.toggle('selected', selected?.id === photo.id);
    const preview = imageButton('', () => openViewer(photo), 'photo-result-preview'); preview.ariaLabel = `Preview ${photo.label}`;
    const image = document.createElement('img'); image.src = photo.previewUrl; image.alt = photo.label; image.loading = 'lazy';
    image.addEventListener('error', () => { card.classList.add('photo-preview-error'); preview.ariaLabel = 'Image preview unavailable. Refresh history to retry.'; });
    preview.append(image); const title = document.createElement('h3'); title.textContent = photo.label;
    const meta = document.createElement('p'); meta.className = 'help-text'; meta.textContent = [catalog.IMAGE_MODELS.find(model => model.id === photo.model)?.label, photo.aspectRatio].filter(Boolean).join(' · ');
    const actions = document.createElement('div'); actions.className = 'photo-card-actions';
    actions.append(imageButton('Edit / reuse', () => usePhoto(photo)), imageButton('Save PNG', () => fileAction(photo, 'Save')), imageButton('Copy', () => fileAction(photo, 'Copy')), imageButton('Premiere ↗', () => fileAction(photo, 'Premiere')));
    if (showHistory && photo.historyId) {
      const favorite = imageButton(photo.isFavorite ? '★ Favorite' : '☆ Favorite', async () => {
        favorite.disabled = true; const stamp = generation;
        try { const response = await api.photosFavorite({ id: photo.id, active: !photo.isFavorite }); if (generation !== stamp) return; if (!response.success) throw new Error(response.error); photo.isFavorite = !photo.isFavorite; if ($('photos-favorites-only').checked) await loadHistory(); else renderResults(); }
        catch (error) { if (generation === stamp) status(error.message, true); } finally { favorite.disabled = false; }
      });
      const remove = imageButton('Delete', async () => {
        if (busy || !confirm('Delete this image from your shared account history?')) return;
        remove.disabled = true; const stamp = generation;
        try { const response = await api.photosDelete(photo.id); if (generation !== stamp) return; if (!response.success) throw new Error(response.error); messages.forEach(message => { message.photos = message.photos.filter(item => item.id !== photo.id); }); if (selected?.id === photo.id) { selected = null; renderReferences(); } await loadHistory(); }
        catch (error) { if (generation === stamp) status(error.message, true); } finally { remove.disabled = false; }
      });
      actions.append(favorite, remove);
    }
    card.append(preview, title, meta, actions); return card;
  }
  function renderResults(scroll = false) {
    const container = $('photos-results'); container.replaceChildren(); container.classList.toggle('photo-history-grid', showHistory);
    const empty = $('photos-empty');
    empty.querySelector('span:last-child')?.remove();
    empty.classList.toggle('hidden', (showHistory ? history.length : messages.length) > 0 || historyLoading);
    empty.querySelector('h2').textContent = showHistory ? 'No saved images yet' : 'Create or edit an image';
    empty.querySelector('p').textContent = showHistory ? 'Generated images appear here when saved to your account.' : 'Describe it or attach a picture.';
    if (showHistory) history.forEach(photo => container.append(photoCard(photo)));
    else messages.forEach(message => {
      const row = document.createElement('section'); row.className = 'photo-chat-turn';
      const prompt = document.createElement('div'); prompt.className = 'photo-chat-prompt';
      const content = document.createElement('p'); content.textContent = message.prompt;
      prompt.append(content);
      if (message.sources.length) { const refs = document.createElement('div'); refs.className = 'photo-chat-attachments'; message.sources.forEach(source => { const img = document.createElement('img'); img.src = source; img.alt = 'Reference picture'; refs.append(img); }); prompt.prepend(refs); }
      row.append(prompt);
      const result = document.createElement('div'); result.className = 'photo-chat-response';
      if (message.photos.length) message.photos.forEach(photo => result.append(photoCard(photo)));
      if (message.pending) {
        const progress = document.createElement('div'); progress.className = 'photo-generation-loading'; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
        const spinner = document.createElement('span'); spinner.className = 'photo-generation-spinner'; spinner.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.textContent = `${actionNames[message.action]}…`;
        progress.append(spinner, label); result.append(progress);
      }
      if (message.error) { const error = document.createElement('p'); error.className = 'help-text photo-error'; error.textContent = message.error; result.append(error); }
      row.append(result); container.append(row);
    });
    availability(); if (scroll && !showHistory) $('photos-view-panel').scrollTop = $('photos-view-panel').scrollHeight;
  }
  async function syncCreditPill() {
    const stamp = generation;
    try { const response = await api.getStudioCredits(); if (generation !== stamp) return; $('photos-credits').textContent = response.success && Number.isFinite(response.credits?.credits) ? `${Math.round(response.credits.credits).toLocaleString()} credits` : 'Balance unavailable'; }
    catch { if (generation === stamp) $('photos-credits').textContent = 'Balance unavailable'; }
  }
  async function perform() {
    if (busy || filesLoading) return;
    if (!getUser()) return signIn();
    const current = action(), chosen = [...presets];
    if (current !== 'generate' && !hasSource()) return status('Attach or select a picture first.', true);
    if (['generate', 'edit'].includes(current) && !$('photos-prompt').value.trim()) return status('Enter a prompt first.', true);
    if (current === 'preset' && !chosen.length) return status('Choose at least one reaction.', true);
    const input = { action: current, prompt: $('photos-prompt').value, model: $('photos-model').value, aspectRatio: $('photos-ratio').value, imageSize: $('photos-size').value, subject: $('photos-subject').value, references: references.map(ref => ref.data), ...(selected && { imageId: selected.id }) };
    const message = { action: current, prompt: current === 'preset' ? `Make reactions: ${chosen.map(id => catalog.REACTION_PRESETS.find(preset => preset.id === id).label).join(', ')}` + (input.prompt.trim() ? `\n${input.prompt}` : '') : input.prompt, sources: selected ? [selected.previewUrl] : references.map(ref => ref.data), photos: [], pending: true };
    const stamp = generation; busy = true; stopBatch = false; messages.push(message); setHistory(false); renderResults(true);
    modelPicker.close(); ratioPicker.close(); sizePicker.close();
    setReactionsOpen(false);
    $('photos-stop-batch').classList.toggle('hidden', current !== 'preset' || chosen.length < 2); $('photos-stop-batch').disabled = false;
    status('Working… This AI action uses Studio credits.');
    let completed = 0, cloudSaveFailed = false, paidStorageRequired = false;
    try {
      const jobs = current === 'preset' ? chosen : [null];
      for (const presetId of jobs) {
        if (stopBatch || stamp !== generation) break;
        if (jobs.length > 1) status(`Generating reaction ${completed + 1} of ${jobs.length} · credits per image…`);
        const response = await api.photosRun({ ...input, ...(presetId && { presetId }) });
        if (stamp !== generation) break;
        if (!response.success) throw new Error(response.error || 'The image action failed.');
        if (response.photo) message.photos.push(response.photo);
        cloudSaveFailed ||= response.historySaved === false && response.cloudStorageAvailable === true;
        paidStorageRequired ||= response.cloudStorageAvailable === false;
        completed++; renderResults(true); await syncCreditPill(); refreshCredits();
      }
      if (stamp === generation) {
        if (completed) { $('photos-prompt').value = ''; selected = message.photos.at(-1) || selected; references = []; if (!stopBatch) clearPresets(); renderReferences(); }
        const ready = `${completed} image${completed === 1 ? '' : 's'} ready.`;
        status(cloudSaveFailed ? `${ready} Cloud history could not save every image. Save PNG to keep your results.`
          : paidStorageRequired ? `${ready} Save PNG to keep your results. Cloud image history requires a paid membership.`
          : stopBatch ? `${ready} Remaining reactions stopped.` : `${ready} Describe another edit below, or start a new chat.`, cloudSaveFailed, paidStorageRequired);
      }
    } catch (error) { if (stamp === generation) { message.error = error.message; status(`${completed ? `${completed} images ready. ` : ''}${error.message}`, true); } }
    finally {
      busy = false;
      if (stamp === generation) { message.pending = false; $('photos-stop-batch').classList.add('hidden'); renderResults(true); if (getUser()) { syncCreditPill(); refreshCredits(); } }
      availability();
    }
  }
  catalog.REACTION_PRESETS.forEach(preset => {
    const button = imageButton(preset.label, () => { if (busy) return; if (presets.has(preset.id)) presets.delete(preset.id); else presets.add(preset.id); button.setAttribute('aria-pressed', String(presets.has(preset.id))); availability(); }, 'photo-preset');
    button.dataset.presetId = preset.id; button.setAttribute('aria-pressed', 'false'); $('photos-presets').append(button);
  });
  function clearPresets() {
    presets.clear(); document.querySelectorAll('#photos-presets button').forEach(button => button.setAttribute('aria-pressed', 'false')); availability();
  }
  ['photos-clear-presets', 'photos-reactions-clear'].forEach(id => $(id).addEventListener('click', clearPresets));
  function setReactionsOpen(open, restoreFocus = false) {
    $('photos-reactions-panel').hidden = !open;
    $('photos-reactions').setAttribute('aria-expanded', String(open));
    syncReactionsLayout();
    if (open) { modelPicker.close(); ratioPicker.close(); sizePicker.close(); $('photos-reactions-close').focus(); }
    else if (restoreFocus) $('photos-reactions').focus();
  }
  function syncReactionsLayout() {
    const modal = !$('photos-reactions-panel').hidden && window.matchMedia('(max-width: 1050px)').matches;
    document.querySelector('#tab-photos .photo-workspace-main').inert = modal;
    $('photos-reactions-panel').setAttribute('role', modal ? 'dialog' : 'complementary');
    if (modal) $('photos-reactions-panel').setAttribute('aria-modal', 'true');
    else $('photos-reactions-panel').removeAttribute('aria-modal');
  }
  window.addEventListener('resize', syncReactionsLayout);
  $('photos-reactions-panel').addEventListener('keydown', event => {
    if (event.key !== 'Tab' || $('photos-reactions-panel').getAttribute('aria-modal') !== 'true') return;
    const focusable = [...$('photos-reactions-panel').querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('photos-reactions').addEventListener('click', () => setReactionsOpen($('photos-reactions-panel').hidden, true));
  ['photos-reactions-close', 'photos-reactions-done'].forEach(id => $(id).addEventListener('click', () => setReactionsOpen(false, true)));
  document.addEventListener('keydown', event => {
    // Let a picker or image viewer consume Escape first.
    if (event.key === 'Escape' && !event.defaultPrevented && !viewer.open && !$('photos-reactions-panel').hidden && $('tab-photos').classList.contains('active')) { event.preventDefault(); setReactionsOpen(false, true); }
  });
  $('photos-generate').addEventListener('click', perform);
  $('photos-stop-batch').addEventListener('click', () => { stopBatch = true; $('photos-stop-batch').disabled = true; status('Finishing the current image, then stopping. The current image can still spend credits.'); });
  async function loadHistory() {
    if (!getUser() || historyLoading) return;
    const stamp = generation; historyLoading = true; renderResults(); status('Loading image history…');
    try {
      const response = await api.photosHistory({ page, favorites: $('photos-favorites-only').checked });
      if (stamp !== generation) return;
      if (!response.success) throw new Error(response.error);
      history = response.items || []; pages = Math.max(1, response.totalPages || 1);
      $('photos-history-policy').textContent = response.cloudStorageAvailable === false
        ? 'Cloud image history requires a paid membership. You can generate images and use Save PNG to keep them.'
        : 'Paid members keep their newest 30 images, up to 100 MB total. Oldest images are deleted automatically; favorites count too. Save PNG to keep a permanent copy.';
      if (page > pages) { page = pages; historyLoading = false; return loadHistory(); }
      status('Image history loaded.');
    } catch (error) { if (stamp === generation) status(error.message, true); }
    finally { if (stamp === generation) { historyLoading = false; renderResults(); } }
  }
  function setHistory(active) {
    showHistory = active; $('photos-history-toggle').setAttribute('aria-pressed', String(active)); $('photos-history-toggle').textContent = active ? 'Back to chat' : 'History';
    ['photos-history-controls', 'photos-history-pagination', 'photos-results-heading', 'photos-history-policy'].forEach(id => $(id).classList.toggle('hidden', !active));
    renderResults();
  }
  $('photos-history-toggle').addEventListener('click', () => { setHistory(!showHistory); if (showHistory) loadHistory(); });
  $('photos-history-refresh').addEventListener('click', loadHistory);
  $('photos-favorites-only').addEventListener('change', () => { page = 1; loadHistory(); });
  $('photos-history-prev').addEventListener('click', () => { if (page > 1 && !historyLoading) { page--; loadHistory(); } });
  $('photos-history-next').addEventListener('click', () => { if (page < pages && !historyLoading) { page++; loadHistory(); } });
  $('photos-new-chat').addEventListener('click', () => {
    if (busy || filesLoading) return;
    messages = []; selected = null; references = []; $('photos-prompt').value = ''; $('photos-subject').value = ''; presets.clear();
    document.querySelectorAll('#photos-presets button').forEach(button => button.setAttribute('aria-pressed', 'false'));
    renderReferences(); setHistory(false); status(''); $('photos-prompt').focus();
  });
  function activate() { if (getUser()) { syncCreditPill(); if (showHistory) loadHistory(); } availability(); }
  function authChanged() {
    const user = getUser()?.id || null;
    if (user !== account) {
      if (viewer.open) viewer.close();
      modelPicker.close(); ratioPicker.close(); sizePicker.close();
      setReactionsOpen(false);
      $('photos-viewer-image').removeAttribute('src'); $('photos-viewer-title').textContent = 'Image preview'; $('photos-viewer-meta').textContent = '';
      account = user; generation++; stopBatch = true; messages = []; history = []; references = []; selected = null; page = pages = 1; historyLoading = filesLoading = false; showHistory = false; presets.clear();
      document.querySelectorAll('#photos-presets button').forEach(button => button.setAttribute('aria-pressed', 'false'));
      $('photos-prompt').value = ''; $('photos-subject').value = ''; $('photos-credits').textContent = 'Studio credits'; $('photos-stop-batch').classList.add('hidden'); status(''); renderReferences(); setHistory(false);
      api.photosReset().catch(() => {});
    }
    $('photos-signin').classList.toggle('hidden', Boolean(user)); $('photos-signedin').classList.toggle('hidden', !user); $('photos-composer-dock').classList.toggle('hidden', !user);
    availability(); if (user && $('tab-photos').classList.contains('active')) activate();
  }
  modelChanged(); authChanged(); renderResults();
  return { activate, authChanged, isBusy: () => busy || historyLoading || filesLoading };
}
