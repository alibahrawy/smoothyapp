/**
 * Settings → Profile / Community: monogram color, profile photo upload,
 * guest display name, blocked people, and link previews.
 *
 * The lobby connection lives in the main process; this module renders a live
 * chat-line preview and saves changes through `window.electronAPI`.
 */

import {
  AVATAR_BRAND_INDICES,
  AVATAR_COLORS,
  AVATAR_COLOR_NAMES,
  AVATAR_IMAGE_MAX_CHARS,
  avatarSvg,
  defaultAvatar,
} from '../shared/community-avatar';
import { PREVIEWS_KEY, avatarHtml, badgesHtml, escapeHtml, profileFor } from './community.js';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const SAMPLE_LINE = 'Hey everyone — this is how I show up in the lobby.';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const monogram = (color) => ({ kind: 'gen', style: 'flat', shape: 0, eyes: 0, color });

export function initCommunitySettings({ signIn } = {}) {
  const $ = (id) => document.getElementById(id);
  const editor = document.getElementById('community-profile-group');
  if (!editor) return;
  const panes = [...new Set([editor, document.getElementById('cs-blocked')]
    .map((element) => element?.closest('.settings-pane'))
    .filter(Boolean))];

  const preview = $('cs-preview');
  const nameEl = $('cs-name');
  const badgesEl = $('cs-badges');
  const note = $('cs-identity-note');
  const colorsEl = $('cs-colors');
  const colorHint = $('cs-color-hint');
  const photoHint = $('cs-photo-hint');
  const drop = $('cs-drop');
  const photoPreview = $('cs-photo-preview');
  const dropTitle = $('cs-drop-title');
  const uploadNote = $('cs-upload-note');
  const uploadButton = $('cs-upload');
  const removePhotoButton = $('cs-remove-photo');
  const uploadInput = $('cs-upload-input');
  const saveButton = $('cs-save');
  const resetButton = $('cs-reset');
  const saveStatus = $('cs-save-status');
  const guestName = $('cs-guest-name');
  const nameInput = $('cs-name-input');
  const nameSave = $('cs-name-save');
  const nameStatus = $('cs-name-status');
  const blockedList = $('cs-blocked');
  const blockedStatus = $('cs-blocked-status');
  const previewsToggle = $('cs-previews');
  const reconnectButton = $('cs-reconnect');
  const openCommunitySettingsBtn = $('cs-open-community-settings');

  let state = null;
  /** What the preview shows and Save sends. Null until the lobby has told us who we are. */
  let draft = null;
  let saved = null;
  let lastColor = null;
  let busy = false;

  const me = () => state?.identity || null;
  const online = () => state?.status === 'online';
  const member = () => Boolean(me() && !me().guest);
  const dirty = () => Boolean(draft && saved && !same(draft, saved));

  function currentName() {
    const identity = me();
    if (!identity) return ($('profile-name-display')?.textContent || '').trim() || 'You';
    if (identity.guest) {
      const typed = nameInput && document.activeElement === nameInput ? nameInput.value.trim() : '';
      return typed || profileFor(identity.id)?.name || identity.name;
    }
    return identity.name;
  }

  function resetDraft() {
    const id = me()?.id || '';
    saved = profileFor(id)?.avatar || defaultAvatar(id);
    draft = { ...saved };
    lastColor = saved.kind === 'gen' ? saved.color : null;
  }

  function avatarMarkup(avatar, size, label) {
    const id = me()?.id || '';
    const effective = avatar || defaultAvatar(id);
    return effective.kind === 'img'
      ? `<img class="community-avatar-img" src="${escapeHtml(effective.data)}" width="${size}" height="${size}" alt="" draggable="false">`
      : avatarSvg(effective, id, size, label);
  }

  function setStatus(element, text, tone = '') {
    element.textContent = text;
    element.dataset.tone = tone;
  }

  /* ------------------------------ rendering ------------------------------ */

  function renderPreview() {
    const identity = me();
    const label = currentName();
    preview.innerHTML = avatarMarkup(draft, 40, label);
    nameEl.textContent = label;
    badgesEl.innerHTML = identity ? badgesHtml({ dev: identity.dev, tier: identity.tier, guest: identity.guest }) : '';
    note.textContent = !identity
      ? (state?.status === 'connecting' ? 'Connecting to the lobby…' : 'Connect to the lobby to customize your avatar.')
      : SAMPLE_LINE;
    if (reconnectButton) {
      reconnectButton.classList.toggle('hidden', online());
      reconnectButton.disabled = state?.status === 'connecting';
      reconnectButton.textContent = state?.status === 'connecting' ? 'Connecting…' : 'Connect';
    }
  }

  function renderColors() {
    const usingMonogram = !draft || draft.kind === 'gen';
    const activeColor = usingMonogram ? (draft?.color ?? null) : undefined;
    if (colorHint) {
      colorHint.textContent = usingMonogram ? 'Shown on your initials tile' : 'Click any color to switch back from photo';
    }
    const autoSelected = usingMonogram && activeColor === null;
    const auto = `<button type="button" role="radio" aria-checked="${autoSelected}" aria-label="Automatic color" title="Automatic" class="cs-swatch is-auto ${autoSelected ? 'is-selected' : ''}" data-color="auto">A</button>`;
    colorsEl.innerHTML = auto + AVATAR_BRAND_INDICES.map((index) => {
      const color = AVATAR_COLORS[index];
      const selected = usingMonogram && activeColor === index;
      return `<button type="button" role="radio" aria-checked="${selected}" aria-label="${AVATAR_COLOR_NAMES[index]}" title="${AVATAR_COLOR_NAMES[index]}" class="cs-swatch ${selected ? 'is-selected' : ''}" data-color="${index}" style="--swatch:${color}"></button>`;
    }).join('');
  }

  function renderPhoto() {
    const canUpload = member();
    const photo = draft?.kind === 'img' ? draft : null;
    photoPreview.innerHTML = photo
      ? avatarMarkup(photo, 48, currentName())
      : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 16V5m0 0-4 4m4-4 4 4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    photoPreview.classList.toggle('has-photo', Boolean(photo));
    drop.classList.toggle('is-locked', !canUpload);

    if (photoHint) {
      photoHint.textContent = me() && !canUpload ? 'For signed-in members' : 'Optional · overrides initials';
    }
    if (!me()) {
      dropTitle.textContent = 'Connect to upload a photo';
      uploadNote.textContent = 'PNG, JPEG, GIF or WebP · up to 8 MB · cropped to a square.';
    } else if (!canUpload) {
      dropTitle.textContent = 'Sign in to upload a photo';
      uploadNote.textContent = 'Guests can pick any initials color — sign in to use a custom picture.';
    } else {
      dropTitle.textContent = photo ? 'Custom photo ready' : 'Drop a picture or choose a file';
      uploadNote.textContent = 'PNG, JPEG, GIF or WebP · up to 8 MB · cropped to a square.';
    }
    uploadButton.textContent = canUpload || !me() ? (photo ? 'Replace…' : 'Upload…') : 'Sign in';
    uploadButton.disabled = !me() || (canUpload && (!online() || busy));
    if (removePhotoButton) {
      removePhotoButton.classList.toggle('hidden', !photo);
      removePhotoButton.disabled = busy;
    }
  }

  function renderIdentity() {
    const identity = me();
    const profile = identity ? profileFor(identity.id) : null;
    guestName.classList.toggle('hidden', !identity?.guest);
    if (identity?.guest && document.activeElement !== nameInput) nameInput.value = profile?.name || '';
    nameSave.disabled = !online() || busy;
  }

  function renderBlocked() {
    const blocks = state?.blocks || [];
    if (!blocks.length) {
      blockedList.innerHTML = '<li class="cs-blocked-empty">You haven’t blocked anyone.</li>';
      return;
    }
    blockedList.innerHTML = blocks.map((person) => `<li>
      <span class="community-avatar" aria-hidden="true">${avatarHtml(person.id, 28, person.name)}</span>
      <span class="cs-blocked-name">${escapeHtml(person.name)}</span>
      <button type="button" class="btn btn-secondary btn-small" data-unblock="${escapeHtml(person.id)}" ${online() && !busy ? '' : 'disabled'}>Unblock</button>
    </li>`).join('');
  }

  function render() {
    if (!draft && me()) resetDraft();
    renderPreview();
    renderColors();
    renderPhoto();
    renderIdentity();
    renderBlocked();
    saveButton.disabled = !dirty() || !online() || busy;
    resetButton.disabled = !dirty() || busy;
    try { previewsToggle.checked = localStorage.getItem(PREVIEWS_KEY) !== '0'; } catch { previewsToggle.checked = true; }
  }

  /* ------------------------------- editing ------------------------------- */

  function pickColor(color) {
    lastColor = color;
    draft = monogram(color);
    setStatus(saveStatus, '');
    render();
  }

  async function resizePicture(file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Use a PNG, JPEG, GIF or WebP picture.');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('That picture is over 8 MB. Pick a smaller one.');
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
    bitmap.close?.();
    for (const [type, quality] of [['image/webp', 0.85], ['image/webp', 0.7], ['image/webp', 0.55], ['image/jpeg', 0.7], ['image/jpeg', 0.5]]) {
      const data = canvas.toDataURL(type, quality);
      if (data.startsWith(`data:${type}`) && data.length <= AVATAR_IMAGE_MAX_CHARS) return data;
    }
    throw new Error('That picture is too detailed to shrink. Try a simpler one.');
  }

  async function usePhoto(file) {
    if (!file) return;
    if (!member()) { signIn?.(); return; }
    try {
      draft = { kind: 'img', data: await resizePicture(file) };
      setStatus(saveStatus, 'Looks good — click Save to apply.', 'ok');
    } catch (error) {
      setStatus(saveStatus, error?.message || 'That picture could not be used.', 'error');
    }
    render();
  }

  async function run(statusEl, action) {
    if (busy) return null;
    busy = true;
    render();
    try {
      const result = await action();
      setStatus(statusEl, result?.success ? 'Saved.' : (result?.error || 'That did not work. Try again.'), result?.success ? 'ok' : 'error');
      return result;
    } catch (error) {
      setStatus(statusEl, error?.message || 'That did not work. Try again.', 'error');
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  function apply(next) {
    const previousId = state?.identity?.id;
    state = next;
    if (state?.identity?.id !== previousId) draft = null;
    render();
  }

  async function connectIfNeeded() {
    try {
      const next = await window.electronAPI.communityConnect();
      if (next) apply(next);
    } catch { /* the pane keeps showing the offline message */ }
  }

  /* ------------------------------- wiring -------------------------------- */

  function bind() {
    colorsEl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-color]');
      if (!button) return;
      pickColor(button.dataset.color === 'auto' ? null : Number(button.dataset.color));
    });

    uploadButton.addEventListener('click', () => (member() ? uploadInput.click() : signIn?.()));
    removePhotoButton?.addEventListener('click', () => pickColor(lastColor));
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = '';
      void usePhoto(file);
    });
    drop.addEventListener('dragover', (event) => {
      if (!member()) return;
      event.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', (event) => {
      if (!drop.contains(event.relatedTarget)) drop.classList.remove('is-over');
    });
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
      void usePhoto(event.dataTransfer?.files?.[0]);
    });

    saveButton.addEventListener('click', () => void run(saveStatus, async () => {
      const result = await window.electronAPI.communitySaveProfile({ avatar: draft });
      if (result?.success) saved = { ...draft };
      return result;
    }));
    resetButton.addEventListener('click', () => { resetDraft(); setStatus(saveStatus, ''); render(); });
    reconnectButton?.addEventListener('click', () => void connectIfNeeded());
    openCommunitySettingsBtn?.addEventListener('click', () => {
      document.querySelector('.settings-nav-item[data-settings-pane="community"]')?.click();
    });

    nameSave.addEventListener('click', () => void run(nameStatus, () => window.electronAPI.communitySaveProfile({ name: nameInput.value })));
    nameInput.addEventListener('input', () => renderPreview());
    nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') nameSave.click(); });

    blockedList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-unblock]');
      if (!button) return;
      void run(blockedStatus, () => window.electronAPI.communityUnblock(button.dataset.unblock)).then((result) => {
        if (result?.success) setStatus(blockedStatus, 'Unblocked. Their messages are back.', 'ok');
      });
    });

    previewsToggle.addEventListener('change', () => {
      try { localStorage.setItem(PREVIEWS_KEY, previewsToggle.checked ? '1' : '0'); } catch { /* applies for this session only */ }
      window.dispatchEvent(new CustomEvent('smoothy-community-previews'));
    });

    window.addEventListener('smoothy-community-profiles', () => {
      if (!dirty()) draft = null;
      render();
    });

    // Opening either pane connects, so saving and unblocking work straight away.
    for (const pane of panes) {
      new MutationObserver(() => { if (pane.classList.contains('active')) void connectIfNeeded(); })
        .observe(pane, { attributes: true, attributeFilter: ['class'] });
    }
  }

  async function init() {
    bind();
    try {
      state = await window.electronAPI.communityState();
    } catch { /* offline until the lobby answers */ }
    render();
    window.electronAPI.onCommunityState((next) => apply(next));
  }

  void init();
}
