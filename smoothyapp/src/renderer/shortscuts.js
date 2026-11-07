/**
 * ShortsCuts — desktop deck, shortcut capture, remote layout editor
 * (folders, multi-actions, icons, colours) and the local phone remote.
 */
import {
  SHORTSCUT_COLORS,
  SHORTSCUT_ICON_GROUPS,
  resolveShortsCutIcon,
  shortsCutColorValue,
  shortsCutIconSvg,
} from '../shared/shortscuts-icons';

const COLUMN_RANGE = { phone: { min: 2, max: 5 }, tablet: { min: 3, max: 8 } };
const MAX_STEPS = 16;

export function initShortsCuts() {
  const $ = (id) => document.getElementById(id);
  const deckEl = $('shortscuts-deck');
  const emptyEl = $('shortscuts-empty');
  const hintEl = $('shortscuts-hint');
  const statusText = $('shortscuts-status-text');
  const deckSearch = $('shortscuts-deck-search');
  const serverToggle = $('shortscuts-server-toggle');
  const serverPort = $('shortscuts-port');
  const serverStatus = $('shortscuts-server-status');
  const remoteOn = $('shortscuts-remote-on');
  const qr = $('shortscuts-qr');
  const urlEl = $('shortscuts-url');
  const clientsEl = $('shortscuts-clients');
  const serverError = $('shortscuts-server-error');
  const catalogModal = $('shortscuts-catalog-modal');
  const catalogList = $('shortscuts-catalog-list');
  const catalogSearch = $('shortscuts-catalog-search');
  const catalogStatus = $('shortscuts-catalog-status');
  const catalogRefresh = $('shortscuts-catalog-refresh');
  const catalogTitle = $('shortscuts-catalog-title');
  const captureButton = $('shortscuts-capture');
  const deviceEl = $('shortscuts-device');
  const deviceGrid = $('shortscuts-device-grid');
  const deviceTitle = $('shortscuts-device-title');
  const deviceBack = $('shortscuts-device-back');
  const inspector = $('shortscuts-inspector');
  const colsValue = $('shortscuts-cols');

  let state = null;
  let catalog = null;
  let catalogError = '';
  let premierePresets = null;
  let presetsError = '';
  let catalogTab = 'all';
  let deckFilter = 'all';
  let deckSearchText = '';
  let recordingId = null;
  let hintTimer = null;
  let lastShownResult = 0;
  let device = 'phone';
  let openFolder = null;
  let selected = null; // { type: 'item' | 'folder', id }
  let dragging = null; // { type, id }

  try { if (localStorage.getItem('shortscuts-device') === 'tablet') device = 'tablet'; } catch { /* optional */ }

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);
  const deck = () => state?.config?.deck || [];
  const folders = () => state?.config?.folders || [];
  const layout = () => state?.config?.layout || { phoneColumns: 3, tabletColumns: 5 };
  const canApply = () => Boolean(state?.connected && state?.editor === 'premiere' && !state?.busy);
  // Free plan: only the first `freeKeys` keys work. Pro is unlimited.
  const isPro = () => state?.pro !== false;
  const freeKeys = () => state?.freeKeys || 6;
  const isActive = (id) => isPro() || deck().slice(0, freeKeys()).some((entry) => entry.id === id);
  const atFreeLimit = () => !isPro() && deck().length >= freeKeys();
  const PRICING_URL = 'https://smoothyedit.com/pricing';

  function upgrade() {
    void window.electronAPI.proUpgradeClick?.('shortscuts');
    void window.electronAPI.openExternal(PRICING_URL);
  }

  function renderPlan() {
    const bar = $('shortscuts-plan');
    bar.classList.toggle('hidden', isPro());
    if (isPro()) return;
    const used = Math.min(deck().length, freeKeys());
    const extra = deck().length - freeKeys();
    $('shortscuts-plan-text').textContent = extra > 0
      ? `Free plan: ${freeKeys()} of ${deck().length} keys work. Smoothy Pro turns on the other ${extra}.`
      : `Free plan: ${used} of ${freeKeys()} keys. Smoothy Pro adds unlimited keys.`;
    bar.classList.toggle('is-full', deck().length >= freeKeys());
  }

  function showHint(message, tone = 'info') {
    if (!hintEl) return;
    hintEl.textContent = message || '';
    hintEl.dataset.tone = tone;
    clearTimeout(hintTimer);
    if (message) hintTimer = setTimeout(() => { hintEl.textContent = ''; hintEl.dataset.tone = ''; }, 4500);
  }

  function shortcutLabel(accelerator) {
    if (!accelerator) return 'Set key';
    const normalized = accelerator.split('+').map((part) => part === 'CommandOrControl' ? (isMac ? 'Command' : 'Control') : part);
    if (!isMac) return normalized.join('+');
    const symbols = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' };
    return normalized.map((part) => symbols[part] || part).join('');
  }

  function kindLabel(kind) {
    if (kind === 'video-effect') return 'Video effect';
    if (kind === 'audio-effect') return 'Audio effect';
    if (kind === 'video-transition') return 'Video transition';
    if (kind === 'audio-transition') return 'Audio transition';
    if (kind === 'multi') return 'Multi-action';
    return 'Preset';
  }

  function kindGroup(kind) {
    if (kind === 'multi') return 'multi';
    if (kind === 'preset') return 'presets';
    if (kind.endsWith('transition')) return 'transitions';
    return 'effects';
  }

  function keyIcon(entry, kind = entry.kind) {
    return resolveShortsCutIcon({ ...entry, kind });
  }

  function keyColor(entry, kind = entry.kind) {
    return shortsCutColorValue(entry.color, kind);
  }

  function registrationFor(id) {
    return state?.shortcuts?.find((entry) => entry.id === id);
  }

  function folderName(id) {
    return folders().find((folder) => folder.id === id)?.label || '';
  }

  // ---------- Saving ----------

  async function save(next, message = 'Saved.') {
    const payload = {
      deck: next.deck ?? deck(),
      folders: next.folders ?? folders(),
      layout: next.layout ?? layout(),
    };
    const result = await window.electronAPI.shortscutsSaveDeck(payload);
    if (!result.success) {
      showHint(result.error || 'Could not save the deck.', 'error');
      render();
      return false;
    }
    state = result.state;
    render();
    if (message) showHint(message, 'success');
    return true;
  }

  function updateItem(id, patch, message) {
    return save({ deck: deck().map((item) => item.id === id ? { ...item, ...patch } : item) }, message);
  }

  function updateFolder(id, patch, message) {
    return save({ folders: folders().map((folder) => folder.id === id ? { ...folder, ...patch } : folder) }, message);
  }

  async function applyItem(id) {
    const result = await window.electronAPI.shortscutsApply(id);
    if (!result.success) showHint(result.error || 'Could not apply that key.', 'error');
    else showHint(result.message || 'Applied.', 'success');
  }

  // ---------- Deck list ----------

  function transitionControls(item) {
    if (!item.kind.endsWith('transition')) return '';
    return `<div class="shortscuts-row-controls">
      <select data-field="edge" aria-label="Transition position">
        <option value="start" ${item.edge === 'start' ? 'selected' : ''}>At start</option>
        <option value="end" ${item.edge === 'end' ? 'selected' : ''}>At end</option>
        <option value="both" ${item.edge === 'both' ? 'selected' : ''}>Both edges</option>
      </select>
      <input data-field="duration" type="number" min="0.05" max="10" step="0.05" value="${Number(item.duration || 0.5).toFixed(2)}" aria-label="Transition duration in seconds">
    </div>`;
  }

  function filteredDeck() {
    const query = deckSearchText.trim().toLowerCase();
    return deck().filter((item) => {
      if (query && !`${item.label} ${item.target || ''} ${kindLabel(item.kind)} ${folderName(item.folderId)}`.toLowerCase().includes(query)) return false;
      return deckFilter === 'all' || kindGroup(item.kind) === deckFilter;
    });
  }

  function tile(entry, kind, size = 18) {
    return `<span class="shortscuts-tile" style="--key:${escapeHtml(keyColor(entry, kind))}" aria-hidden="true">${shortsCutIconSvg(keyIcon(entry, kind), size)}</span>`;
  }

  function renderDeck() {
    const items = filteredDeck();
    emptyEl.classList.toggle('hidden', items.length > 0);
    if (!items.length) {
      emptyEl.textContent = !deck().length ? 'No keys yet. Click Add to choose effects, transitions or presets.' : 'No keys match this view.';
    }
    deckEl.innerHTML = items.map((item) => {
      const registration = registrationFor(item.id);
      const conflict = registration && !registration.registered;
      const assigned = Boolean(item.shortcut);
      const isSelected = selected?.type === 'item' && selected.id === item.id;
      const active = isActive(item.id);
      const steps = item.kind === 'multi' ? `<span class="shortscuts-meta">${(item.steps || []).length} action${(item.steps || []).length === 1 ? '' : 's'}</span>` : '';
      const folder = item.folderId ? `<span class="shortscuts-meta">in ${escapeHtml(folderName(item.folderId))}</span>` : '';
      return `
      <div class="shortscuts-row ${conflict ? 'is-conflict' : ''} ${isSelected ? 'is-selected' : ''} ${active ? '' : 'is-inactive'}" data-id="${escapeHtml(item.id)}">
        <button type="button" class="shortscuts-tile-btn" data-action="select" title="Customize key">${tile(item)}</button>
        <button class="shortscuts-key ${assigned ? '' : 'empty'} ${recordingId === item.id ? 'recording' : ''} ${conflict ? 'conflict' : ''}" data-action="shortcut" title="${conflict ? escapeHtml(registration.error || 'Shortcut unavailable') : assigned ? 'Click to change this shortcut' : 'Click to record a shortcut'}">${recordingId === item.id ? 'Press keys…' : escapeHtml(shortcutLabel(item.shortcut))}</button>
        <div class="shortscuts-row-main">
          <strong>${escapeHtml(item.label)}</strong>
          <span class="shortscuts-kind">${kindLabel(item.kind)}</span>
          ${steps}${folder}${active ? '' : '<span class="shortscuts-meta shortscuts-pro-note">Pro</span>'}
          ${transitionControls(item)}
        </div>
        <button class="btn btn-secondary btn-small shortscuts-apply" data-action="apply" ${canApply() && active ? '' : 'disabled'}>Apply</button>
        <button class="shortscuts-remove" data-action="remove" aria-label="Remove ${escapeHtml(item.label)}" title="Remove key">&times;</button>
      </div>`;
    }).join('');
  }

  function removeItem(id) {
    const item = deck().find((entry) => entry.id === id);
    if (!item) return;
    const next = deck()
      .filter((entry) => entry.id !== id)
      .map((entry) => entry.kind === 'multi' ? { ...entry, steps: (entry.steps || []).filter((step) => step !== id) } : entry);
    const emptied = next.filter((entry) => entry.kind === 'multi' && !(entry.steps || []).length).map((entry) => entry.id);
    if (selected?.id === id) selected = null;
    void save({ deck: next.filter((entry) => !emptied.includes(entry.id)) }, emptied.length ? `${item.label} removed, with an empty multi-action.` : `${item.label} removed.`);
  }

  // ---------- Layout preview ----------

  function visibleKeys() {
    const ids = new Set(folders().map((folder) => folder.id));
    if (openFolder && !ids.has(openFolder)) openFolder = null;
    if (openFolder) return deck().filter((item) => item.folderId === openFolder).map((item) => ({ type: 'item', entry: item }));
    return [
      ...folders().map((folder) => ({ type: 'folder', entry: folder })),
      ...deck().filter((item) => !item.folderId || !ids.has(item.folderId)).map((item) => ({ type: 'item', entry: item })),
    ];
  }

  function renderDevice() {
    deviceEl.dataset.device = device;
    document.querySelectorAll('[data-device]').forEach((button) => {
      if (button === deviceEl) return;
      const active = button.dataset.device === device;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    const columns = device === 'tablet' ? layout().tabletColumns : layout().phoneColumns;
    colsValue.textContent = String(columns);
    $('shortscuts-cols-down').disabled = columns <= COLUMN_RANGE[device].min;
    $('shortscuts-cols-up').disabled = columns >= COLUMN_RANGE[device].max;
    deviceGrid.style.setProperty('--cols', String(columns));
    const folder = folders().find((entry) => entry.id === openFolder);
    deviceTitle.textContent = folder ? folder.label : 'ShortsCuts';
    deviceBack.classList.toggle('hidden', !folder);
    const keys = visibleKeys();
    const cells = keys.map(({ type, entry }) => {
      const kind = type === 'folder' ? 'folder' : entry.kind;
      const isSelected = selected?.type === type && selected.id === entry.id;
      const count = type === 'folder' ? deck().filter((item) => item.folderId === entry.id).length : 0;
      const inactive = type === 'item' && !isActive(entry.id);
      return `<button type="button" class="shortscuts-dkey ${type === 'folder' ? 'is-folder' : ''} ${isSelected ? 'is-selected' : ''} ${inactive ? 'is-inactive' : ''}" draggable="true" data-type="${type}" data-id="${escapeHtml(entry.id)}" style="--key:${escapeHtml(keyColor(entry, kind))}" title="${escapeHtml(type === 'folder' ? `${entry.label} · double-click to open` : entry.label)}">
        <span class="shortscuts-dkey-icon">${shortsCutIconSvg(keyIcon(entry, kind), 24)}</span>
        <span class="shortscuts-dkey-label">${escapeHtml(entry.label)}</span>
        ${type === 'folder' ? `<span class="shortscuts-dkey-count">${count}</span>` : ''}
      </button>`;
    });
    if (!cells.length) cells.push(`<p class="shortscuts-device-empty">${openFolder ? 'Empty folder. Drag keys onto it, or choose it in a key’s settings.' : 'Add keys to fill your remote.'}</p>`);
    deviceGrid.innerHTML = cells.join('');
  }

  // ---------- Inspector ----------

  function iconPicker(current, auto) {
    const groups = SHORTSCUT_ICON_GROUPS.map((group) => `
      <div class="shortscuts-picker-group"><span>${escapeHtml(group.name)}</span>
        <div class="shortscuts-icon-grid">${group.icons.map((icon) => `<button type="button" class="${current === icon.id ? 'active' : ''}" data-pick-icon="${icon.id}" title="${escapeHtml(icon.label)}" aria-label="${escapeHtml(icon.label)}">${shortsCutIconSvg(icon.id, 18)}</button>`).join('')}</div>
      </div>`).join('');
    return `<div class="shortscuts-field"><label>Icon <button type="button" class="shortscuts-link ${current ? '' : 'hidden'}" data-pick-icon="">Use automatic (${escapeHtml(auto)})</button></label><div class="shortscuts-icon-picker">${groups}</div></div>`;
  }

  function colorPicker(current, kind) {
    const swatches = SHORTSCUT_COLORS.map((color) => `<button type="button" class="${current === color.id ? 'active' : ''}" data-pick-color="${color.id}" style="--swatch:${color.value}" title="${escapeHtml(color.label)}" aria-label="${escapeHtml(color.label)}"></button>`).join('');
    return `<div class="shortscuts-field"><label>Colour <button type="button" class="shortscuts-link ${current ? '' : 'hidden'}" data-pick-color="">Use ${escapeHtml(kindLabel(kind).toLowerCase())} colour</button></label><div class="shortscuts-swatches">${swatches}</div></div>`;
  }

  function stepsEditor(item) {
    const plain = deck().filter((entry) => entry.kind !== 'multi');
    const steps = (item.steps || []).map((id) => plain.find((entry) => entry.id === id)).filter(Boolean);
    const rows = steps.map((step, index) => `
      <li data-step-index="${index}">
        ${tile(step, step.kind, 14)}
        <span>${escapeHtml(step.label)}</span>
        <button type="button" data-step="up" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" data-step="down" ${index === steps.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button type="button" data-step="remove" aria-label="Remove action">&times;</button>
      </li>`).join('');
    const options = plain.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)} · ${escapeHtml(kindLabel(entry.kind))}</option>`).join('');
    return `<div class="shortscuts-field"><label>Actions, in order</label>
      ${rows ? `<ol class="shortscuts-steps-list">${rows}</ol>` : '<p class="help-text">No actions yet.</p>'}
      ${steps.length < MAX_STEPS && plain.length ? `<select data-step-add aria-label="Add an action"><option value="">+ Add an action…</option>${options}</select>` : ''}
      ${plain.length ? '' : '<p class="help-text">Add effects, transitions or presets to the deck first.</p>'}
    </div>`;
  }

  function renderInspector() {
    const item = selected?.type === 'item' ? deck().find((entry) => entry.id === selected.id) : null;
    const folder = selected?.type === 'folder' ? folders().find((entry) => entry.id === selected.id) : null;
    if (!item && !folder) {
      selected = null;
      inspector.innerHTML = `<div class="shortscuts-inspector-empty">
        <strong>Customize a key</strong>
        <p class="help-text">Select a key in the preview or deck to change its name, icon, colour and folder.</p>
      </div>`;
      return;
    }
    if (folder) {
      const count = deck().filter((entry) => entry.folderId === folder.id).length;
      inspector.innerHTML = `
        <div class="shortscuts-inspector-head">${tile(folder, 'folder', 20)}<div><strong>${escapeHtml(folder.label)}</strong><span>Folder · ${count} key${count === 1 ? '' : 's'}</span></div></div>
        <div class="shortscuts-field"><label for="shortscuts-edit-label">Name</label><input id="shortscuts-edit-label" maxlength="40" value="${escapeHtml(folder.label)}"></div>
        ${iconPicker(folder.icon, 'folder')}
        ${colorPicker(folder.color, 'folder')}
        <div class="shortscuts-inspector-actions">
          <button type="button" class="btn btn-secondary btn-small" data-inspect="open">${openFolder === folder.id ? 'Close folder' : 'Open folder'}</button>
          <button type="button" class="btn btn-secondary btn-small shortscuts-danger" data-inspect="delete">Delete folder</button>
        </div>`;
      return;
    }
    const folderOptions = [`<option value="">Top level</option>`, ...folders().map((entry) => `<option value="${escapeHtml(entry.id)}" ${item.folderId === entry.id ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`)].join('');
    inspector.innerHTML = `
      <div class="shortscuts-inspector-head">${tile(item, item.kind, 20)}<div><strong>${escapeHtml(item.label)}</strong><span>${kindLabel(item.kind)}${item.target ? ` · ${escapeHtml(item.target)}` : ''}</span></div></div>
      <div class="shortscuts-field"><label for="shortscuts-edit-label">Name</label><input id="shortscuts-edit-label" maxlength="60" value="${escapeHtml(item.label)}"></div>
      <div class="shortscuts-field"><label for="shortscuts-edit-folder">Folder</label><select id="shortscuts-edit-folder">${folderOptions}</select></div>
      ${item.kind === 'multi' ? stepsEditor(item) : ''}
      ${iconPicker(item.icon, resolveShortsCutIcon({ ...item, icon: undefined }))}
      ${colorPicker(item.color, item.kind)}
      <div class="shortscuts-inspector-actions">
        <button type="button" class="btn btn-primary btn-small" data-inspect="apply" ${canApply() ? '' : 'disabled'}>Test on selection</button>
        <button type="button" class="btn btn-secondary btn-small shortscuts-danger" data-inspect="delete">Remove key</button>
      </div>`;
  }

  function select(type, id) {
    selected = type ? { type, id } : null;
    if (type === 'item') {
      const item = deck().find((entry) => entry.id === id);
      if (item && item.folderId !== openFolder) openFolder = item.folderId && folders().some((folder) => folder.id === item.folderId) ? item.folderId : null;
    }
    render();
  }

  // ---------- Server ----------

  function renderServer() {
    if (!state) return;
    const server = state.server;
    serverToggle.checked = Boolean(state.config.serverEnabled);
    if (document.activeElement !== serverPort) serverPort.value = String(state.config.serverPort);
    remoteOn.classList.toggle('hidden', !server.running);
    serverStatus.textContent = server.running ? `Running on port ${server.port}` : 'Off';
    if (server.running) {
      qr.src = server.qrDataUrl || '';
      urlEl.textContent = server.pageUrl || '';
      clientsEl.textContent = !server.urls.length
        ? 'No Wi-Fi address found. Connect this computer to the same network as your phone.'
        : server.clients > 0
          ? `${server.clients} device${server.clients === 1 ? '' : 's'} connected`
          : 'Scan the code with your phone or tablet camera.';
      $('shortscuts-copy-url').disabled = !server.pageUrl;
      $('shortscuts-open-url').disabled = !server.pageUrl;
    } else {
      qr.removeAttribute('src');
      urlEl.textContent = '';
      clientsEl.textContent = '';
    }
    serverError.textContent = server.error || '';
    serverError.classList.toggle('hidden', !server.error);
  }

  function render() {
    if (!state) return;
    statusText.textContent = state.busy ? 'ShortsCuts · working' : 'ShortsCuts';
    renderPlan();
    renderDeck();
    renderDevice();
    const focused = document.activeElement;
    const keepFocus = focused && inspector.contains(focused) && focused.id === 'shortscuts-edit-label';
    if (!keepFocus) renderInspector();
    renderServer();
    if (state.lastResult && state.lastResult.at !== lastShownResult) {
      lastShownResult = state.lastResult.at;
      showHint(state.lastResult.message, state.lastResult.success ? 'success' : 'error');
    }
  }

  // ---------- Shortcut recording ----------

  function startRecording(id) {
    recordingId = id;
    showHint('Press a key combination with Command/Ctrl or Alt. Escape cancels, Backspace clears.', 'info');
    render();
    window.electronAPI.shortscutsSetCapturing(true).then((result) => {
      if (result?.success && result.state) { state = result.state; render(); }
    }).catch(() => {});
  }

  async function stopRecording(accelerator) {
    const id = recordingId;
    const item = deck().find((entry) => entry.id === id);
    recordingId = null;
    await window.electronAPI.shortscutsSetCapturing(false);
    if (!id || !item) { render(); return; }
    await updateItem(id, { shortcut: accelerator || undefined }, accelerator ? 'Shortcut saved.' : 'Shortcut cleared.');
  }

  function cancelRecording() {
    if (!recordingId) return;
    recordingId = null;
    render();
    void window.electronAPI.shortscutsSetCapturing(false);
  }

  function acceleratorFromEvent(event) {
    const modifiers = [];
    if (event.metaKey) modifiers.push('Command');
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
    const code = event.code || '';
    const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Return', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
    let key = '';
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
    else key = named[code] || '';
    return key ? [...modifiers, key].join('+') : null;
  }

  // ---------- Add picker ----------

  function catalogRows() {
    const rows = [];
    const query = catalogSearch.value.trim().toLowerCase();
    const match = (text) => !query || text.toLowerCase().includes(query);
    const want = (tab) => catalogTab === 'all' || catalogTab === tab;
    const add = (group, list) => { const items = list.filter((row) => match(`${row.name} ${row.sub || ''}`)); if (items.length) rows.push({ group, items }); };
    if (want('effects') && catalog) {
      add('Video effects', (catalog.videoEffects || []).map((name) => ({ kind: 'video-effect', name, target: name })));
      add('Audio effects', (catalog.audioEffects || []).map((name) => ({ kind: 'audio-effect', name, target: name })));
    }
    if (want('transitions')) {
      add('Video transitions', [{ kind: 'video-transition', name: 'Default video transition', target: '' }, ...((catalog?.videoTransitions) || []).map((name) => ({ kind: 'video-transition', name, target: name }))]);
      add('Audio transitions', [{ kind: 'audio-transition', name: 'Default audio transition', target: '' }, ...((catalog?.audioTransitions) || []).map((name) => ({ kind: 'audio-transition', name, target: name }))]);
    }
    if (want('presets') && premierePresets) {
      add('Premiere presets', premierePresets.map((preset) => ({ kind: 'preset', name: preset.name, presetId: preset.id, sub: `${preset.folder || 'Premiere presets'}${preset.animated ? ' · animated' : ''}` })));
    }
    return rows;
  }

  function renderCatalog() {
    document.querySelectorAll('[data-catalog-tab]').forEach((tab) => {
      const active = tab.dataset.catalogTab === catalogTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    captureButton.classList.toggle('hidden', catalogTab !== 'presets');
    catalogRefresh.classList.toggle('hidden', catalogTab !== 'presets');
    const groups = catalogRows();
    const showGroups = catalogTab === 'all' || groups.length > 1;
    catalogList.innerHTML = groups.length
      ? groups.map(({ group, items }) => `${showGroups ? `<h4 class="shortscuts-catalog-group">${escapeHtml(group)} <span>${items.length}</span></h4>` : ''}${items.map((row) => {
        const entry = { label: row.name, target: row.target, kind: row.kind };
        return `<button class="shortscuts-catalog-item" type="button" data-kind="${row.kind}" data-name="${escapeHtml(row.name)}" ${row.presetId ? `data-preset-id="${escapeHtml(row.presetId)}"` : `data-target="${escapeHtml(row.target)}"`}>${tile(entry, row.kind, 16)}<span class="shortscuts-catalog-copy"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.sub || kindLabel(row.kind))}</small></span><b>+</b></button>`;
      }).join('')}`).join('')
      : `<p class="help-text">${catalogSearch.value.trim() ? 'No matches.' : 'Nothing to show yet.'}</p>`;
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    const notes = [];
    if ((catalogTab === 'all' || catalogTab === 'effects' || catalogTab === 'transitions') && catalogError) notes.push(catalogError);
    if ((catalogTab === 'all' || catalogTab === 'presets') && presetsError) notes.push(presetsError);
    catalogStatus.textContent = [`${total} available`, ...notes].join(' · ');
  }

  async function loadCatalog() {
    if (catalog) return;
    const result = await window.electronAPI.shortscutsCatalog();
    if (result.success) { catalog = result.catalog; catalogError = ''; }
    else catalogError = result.error || 'Could not load Premiere effects.';
  }

  async function loadPresets(refresh = false) {
    if (premierePresets && !refresh) return;
    const result = await window.electronAPI.shortscutsPresets(refresh);
    if (result.success) { premierePresets = result.presets || []; presetsError = ''; }
    else presetsError = result.error || 'Could not read Premiere presets.';
  }

  async function openCatalog() {
    if (atFreeLimit()) {
      showHint(`The free plan includes ${freeKeys()} keys. Remove one, or get Smoothy Pro for unlimited keys.`, 'error');
      $('shortscuts-plan')?.classList.add('is-nudge');
      setTimeout(() => $('shortscuts-plan')?.classList.remove('is-nudge'), 1200);
      return;
    }
    catalogModal.classList.remove('hidden');
    catalogSearch.value = '';
    const folder = folders().find((entry) => entry.id === openFolder);
    catalogTitle.textContent = folder ? `Add to ${folder.label}` : 'Add to the deck';
    catalogList.innerHTML = '';
    catalogStatus.textContent = 'Loading from Premiere…';
    catalogSearch.focus();
    await Promise.all([loadCatalog(), loadPresets()]);
    renderCatalog();
  }

  async function addToDeck(item) {
    const added = { id: crypto.randomUUID(), ...item, ...(openFolder ? { folderId: openFolder } : {}) };
    if (await save({ deck: [...deck(), added] }, `${item.label} added${openFolder ? ` to ${folderName(openFolder)}` : ''}.`)) {
      catalogStatus.textContent = `${item.label} added. Keep adding, or close this window.`;
    }
  }

  async function addPremierePreset(id) {
    const result = await window.electronAPI.shortscutsPreset(id);
    if (!result.success) { catalogStatus.textContent = result.error || 'Could not read that Premiere preset.'; return; }
    const preset = result.preset;
    await addToDeck({
      label: String(preset.name || 'Premiere preset').slice(0, 60),
      kind: 'preset',
      target: '',
      preset: { mediaType: preset.mediaType, components: preset.components, animated: preset.animated, source: 'premiere' },
    });
  }

  // ---------- Drag and drop in the preview ----------

  function moveBefore(list, id, beforeId) {
    const moving = list.find((entry) => entry.id === id);
    if (!moving) return list;
    const rest = list.filter((entry) => entry.id !== id);
    const index = beforeId ? rest.findIndex((entry) => entry.id === beforeId) : -1;
    if (index < 0) rest.push(moving); else rest.splice(index, 0, moving);
    return rest;
  }

  function dropOn(target) {
    if (!dragging) return;
    const { type, id } = dragging;
    dragging = null;
    if (target && target.id === id) return;
    if (type === 'folder') {
      if (target && target.type !== 'folder') return;
      void save({ folders: moveBefore(folders(), id, target?.id) }, '');
      return;
    }
    if (target?.type === 'folder') {
      const item = deck().find((entry) => entry.id === id);
      void save({ deck: deck().map((entry) => entry.id === id ? { ...entry, folderId: target.id } : entry) }, `${item?.label || 'Key'} moved to ${folderName(target.id)}.`);
      return;
    }
    if (target?.type === 'back') {
      void save({ deck: deck().map((entry) => entry.id === id ? { ...entry, folderId: undefined } : entry) }, 'Moved to the top level.');
      return;
    }
    void save({ deck: moveBefore(deck(), id, target?.id) }, '');
  }

  // ---------- Events ----------

  function bind() {
    $('shortscuts-add').addEventListener('click', () => void openCatalog());
    $('shortscuts-plan-upgrade').addEventListener('click', upgrade);
    captureButton.addEventListener('click', async () => {
      const result = await window.electronAPI.shortscutsCapturePreset();
      if (!result.success) { catalogStatus.textContent = result.error || 'Could not capture that preset.'; return; }
      state = result.state;
      render();
      catalogStatus.textContent = 'Preset captured from the selected clip.';
    });

    deckSearch.addEventListener('input', () => { deckSearchText = deckSearch.value; renderDeck(); });
    document.querySelectorAll('[data-deck-filter]').forEach((button) => button.addEventListener('click', () => {
      deckFilter = button.dataset.deckFilter;
      document.querySelectorAll('[data-deck-filter]').forEach((entry) => entry.classList.toggle('active', entry === button));
      renderDeck();
    }));

    deckEl.addEventListener('click', (event) => {
      const row = event.target.closest('.shortscuts-row');
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!row || !action) return;
      const id = row.dataset.id;
      if (action === 'apply') void applyItem(id);
      else if (action === 'shortcut') startRecording(id);
      else if (action === 'select') { select('item', id); inspector.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else if (action === 'remove') removeItem(id);
    });

    deckEl.addEventListener('change', (event) => {
      const row = event.target.closest('.shortscuts-row');
      const field = event.target.dataset.field;
      if (!row || !field) return;
      if (field === 'edge') void updateItem(row.dataset.id, { edge: event.target.value });
      if (field === 'duration') {
        const value = Number(event.target.value);
        if (Number.isFinite(value)) void updateItem(row.dataset.id, { duration: Math.min(10, Math.max(0.05, Math.round(value * 100) / 100)) });
      }
    });

    window.addEventListener('keydown', (event) => {
      if (!recordingId) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        cancelRecording(); showHint('Shortcut unchanged.', 'info');
        return;
      }
      if (event.code === 'Backspace' || event.code === 'Delete') {
        event.preventDefault(); event.stopPropagation();
        void stopRecording(null); return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      event.preventDefault(); event.stopPropagation();
      const duplicate = deck().find((item) => item.id !== recordingId && item.shortcut?.toLowerCase() === accelerator.toLowerCase());
      if (duplicate) { showHint(`${accelerator} is already assigned to ${duplicate.label}.`, 'error'); return; }
      void stopRecording(accelerator);
    }, true);
    window.addEventListener('blur', cancelRecording);
    document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', cancelRecording));

    // Device preview
    document.querySelectorAll('.shortscuts-segmented [data-device]').forEach((button) => button.addEventListener('click', () => {
      device = button.dataset.device === 'tablet' ? 'tablet' : 'phone';
      try { localStorage.setItem('shortscuts-device', device); } catch { /* optional */ }
      renderDevice();
    }));
    deviceBack.addEventListener('click', () => { openFolder = null; render(); });
    deviceGrid.addEventListener('click', (event) => {
      const key = event.target.closest('.shortscuts-dkey');
      if (key) select(key.dataset.type, key.dataset.id);
    });
    deviceGrid.addEventListener('dblclick', (event) => {
      const key = event.target.closest('.shortscuts-dkey');
      if (!key) return;
      if (key.dataset.type === 'folder') { openFolder = key.dataset.id; selected = null; render(); }
      else if (canApply()) void applyItem(key.dataset.id);
    });
    deviceGrid.addEventListener('dragstart', (event) => {
      const key = event.target.closest('.shortscuts-dkey');
      if (!key) return;
      dragging = { type: key.dataset.type, id: key.dataset.id };
      key.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', key.dataset.id);
    });
    deviceGrid.addEventListener('dragend', () => {
      dragging = null;
      deviceGrid.querySelectorAll('.is-dragging, .is-drop').forEach((entry) => entry.classList.remove('is-dragging', 'is-drop'));
      deviceBack.classList.remove('is-drop');
    });
    deviceGrid.addEventListener('dragover', (event) => {
      if (!dragging) return;
      event.preventDefault();
      deviceGrid.querySelectorAll('.is-drop').forEach((entry) => entry.classList.remove('is-drop'));
      event.target.closest('.shortscuts-dkey')?.classList.add('is-drop');
    });
    deviceGrid.addEventListener('drop', (event) => {
      event.preventDefault();
      const key = event.target.closest('.shortscuts-dkey');
      dropOn(key ? { type: key.dataset.type, id: key.dataset.id } : null);
    });
    deviceBack.addEventListener('dragover', (event) => {
      if (!dragging || dragging.type !== 'item') return;
      event.preventDefault();
      deviceBack.classList.add('is-drop');
    });
    deviceBack.addEventListener('dragleave', () => deviceBack.classList.remove('is-drop'));
    deviceBack.addEventListener('drop', (event) => { event.preventDefault(); deviceBack.classList.remove('is-drop'); dropOn({ type: 'back' }); });

    const stepColumns = (delta) => {
      const key = device === 'tablet' ? 'tabletColumns' : 'phoneColumns';
      const range = COLUMN_RANGE[device];
      const value = Math.min(range.max, Math.max(range.min, layout()[key] + delta));
      if (value !== layout()[key]) void save({ layout: { ...layout(), [key]: value } }, '');
    };
    $('shortscuts-cols-down').addEventListener('click', () => stepColumns(-1));
    $('shortscuts-cols-up').addEventListener('click', () => stepColumns(1));

    $('shortscuts-new-folder').addEventListener('click', async () => {
      const id = crypto.randomUUID();
      const label = `Folder ${folders().length + 1}`;
      openFolder = null;
      if (await save({ folders: [...folders(), { id, label }] }, `${label} created. Drag keys onto it.`)) select('folder', id);
    });
    $('shortscuts-new-multi').addEventListener('click', async () => {
      const plain = deck().filter((entry) => entry.kind !== 'multi');
      if (!plain.length) { showHint('Add an effect, transition or preset first.', 'error'); return; }
      const id = crypto.randomUUID();
      const item = { id, label: 'Multi-action', kind: 'multi', target: '', steps: [plain[0].id], ...(openFolder ? { folderId: openFolder } : {}) };
      if (await save({ deck: [...deck(), item] }, 'Multi-action created. Add the actions it should run.')) select('item', id);
    });

    // Inspector
    inspector.addEventListener('change', (event) => {
      if (!selected) return;
      const target = event.target;
      if (target.id === 'shortscuts-edit-label') {
        const label = target.value.trim();
        if (!label) { renderInspector(); return; }
        if (selected.type === 'folder') void updateFolder(selected.id, { label }, '');
        else void updateItem(selected.id, { label }, '');
      } else if (target.id === 'shortscuts-edit-folder') {
        const folderId = target.value || undefined;
        openFolder = folderId || null;
        void updateItem(selected.id, { folderId }, folderId ? `Moved to ${folderName(folderId)}.` : 'Moved to the top level.');
      } else if (target.matches('[data-step-add]') && target.value) {
        const item = deck().find((entry) => entry.id === selected.id);
        if (item) void updateItem(item.id, { steps: [...(item.steps || []), target.value].slice(0, MAX_STEPS) }, '');
      }
    });
    inspector.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.id === 'shortscuts-edit-label') event.target.blur();
    });
    inspector.addEventListener('click', (event) => {
      if (!selected) return;
      const icon = event.target.closest('[data-pick-icon]');
      const color = event.target.closest('[data-pick-color]');
      const step = event.target.closest('[data-step]');
      const action = event.target.closest('[data-inspect]')?.dataset.inspect;
      const update = selected.type === 'folder' ? updateFolder : updateItem;
      if (icon) { void update(selected.id, { icon: icon.dataset.pickIcon || undefined }, ''); return; }
      if (color) { void update(selected.id, { color: color.dataset.pickColor || undefined }, ''); return; }
      if (step) {
        const item = deck().find((entry) => entry.id === selected.id);
        const index = Number(step.closest('[data-step-index]').dataset.stepIndex);
        const steps = [...(item?.steps || [])].filter((id) => deck().some((entry) => entry.id === id && entry.kind !== 'multi'));
        if (step.dataset.step === 'remove') {
          if (steps.length <= 1) { showHint('A multi-action needs at least one action. Remove the key instead.', 'error'); return; }
          steps.splice(index, 1);
        } else {
          const swap = step.dataset.step === 'up' ? index - 1 : index + 1;
          if (swap < 0 || swap >= steps.length) return;
          [steps[index], steps[swap]] = [steps[swap], steps[index]];
        }
        void updateItem(item.id, { steps }, '');
        return;
      }
      if (action === 'apply') void applyItem(selected.id);
      if (action === 'open') { openFolder = openFolder === selected.id ? null : selected.id; render(); }
      if (action === 'delete') {
        if (selected.type === 'item') { removeItem(selected.id); return; }
        const folder = folders().find((entry) => entry.id === selected.id);
        const id = selected.id;
        selected = null;
        if (openFolder === id) openFolder = null;
        void save({
          folders: folders().filter((entry) => entry.id !== id),
          deck: deck().map((entry) => entry.folderId === id ? { ...entry, folderId: undefined } : entry),
        }, `${folder?.label || 'Folder'} deleted. Its keys moved to the top level.`);
      }
    });

    // Phone remote server
    serverToggle.addEventListener('change', async () => {
      const result = await window.electronAPI.shortscutsSetServer({ enabled: serverToggle.checked, port: Number(serverPort.value) });
      if (!result.success) { showHint(result.error || 'Could not start the phone remote.', 'error'); render(); return; }
      state = result.state; render();
      if (serverToggle.checked) showHint('Phone remote started. Scan the QR code.', 'success');
    });
    serverPort.addEventListener('change', async () => {
      const port = Number(serverPort.value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) { showHint('Choose a port between 1024 and 65535.', 'error'); render(); return; }
      if (!state.config.serverEnabled) return;
      const result = await window.electronAPI.shortscutsSetServer({ enabled: true, port });
      if (!result.success) { showHint(result.error || 'Could not change the port.', 'error'); render(); return; }
      state = result.state; render();
    });
    $('shortscuts-new-token').addEventListener('click', async () => {
      const result = await window.electronAPI.shortscutsRotateToken();
      if (!result.success) { showHint(result.error || 'Could not create a new code.', 'error'); return; }
      state = result.state; render(); showHint('New code created. Scan again to pair.', 'success');
    });
    $('shortscuts-copy-url').addEventListener('click', async () => {
      const result = await window.electronAPI.shortscutsCopyRemote();
      if (!result.success) showHint(result.error || 'Start the phone remote first.', 'error');
      else showHint('Remote link copied.', 'success');
    });
    $('shortscuts-open-url').addEventListener('click', async () => {
      const result = await window.electronAPI.shortscutsOpenRemote();
      if (!result.success) showHint(result.error || 'Start the phone remote first.', 'error');
    });

    // Add picker
    $('shortscuts-catalog-close').addEventListener('click', () => catalogModal.classList.add('hidden'));
    catalogModal.addEventListener('click', (event) => { if (event.target === catalogModal) catalogModal.classList.add('hidden'); });
    catalogSearch.addEventListener('input', renderCatalog);
    catalogRefresh.addEventListener('click', async () => { catalogStatus.textContent = 'Reading Premiere presets…'; await loadPresets(true); renderCatalog(); });
    document.querySelectorAll('[data-catalog-tab]').forEach((tab) => tab.addEventListener('click', () => { catalogTab = tab.dataset.catalogTab; renderCatalog(); }));
    catalogList.addEventListener('click', (event) => {
      const button = event.target.closest('.shortscuts-catalog-item');
      if (!button) return;
      if (button.dataset.presetId) { void addPremierePreset(button.dataset.presetId); return; }
      const kind = button.dataset.kind;
      void addToDeck({
        label: (button.dataset.name || '').slice(0, 60),
        kind,
        target: button.dataset.target || '',
        ...(kind.endsWith('transition') ? { edge: 'end', duration: 0.5 } : {}),
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !catalogModal.classList.contains('hidden')) catalogModal.classList.add('hidden');
    });
  }

  async function init() {
    bind();
    try {
      state = await window.electronAPI.shortscutsState();
      render();
    } catch {
      showHint('ShortsCuts could not load its settings.', 'error');
    }
    window.electronAPI.onShortsCutsState((next) => { state = next; render(); });
  }

  void init();
}
