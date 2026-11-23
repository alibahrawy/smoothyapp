/**
 * Community lobby tab.
 *
 * Renders the shared message feed, guest identity banner and composer. The
 * connection lives in the main process; this module only reacts to state.
 *
 * 3.1: avatars, Pro (Smoothy cup) and Dev badges, allow-listed links with
 * previews, delete / report / block on each message, a timeout notice, and an
 * unread count that ignores blocked and removed messages.
 */

import cupIcon from './logo.svg?raw';
import { avatarSvg, cleanAvatar, defaultAvatar } from '../shared/community-avatar';
import {
  communitySiteName,
  isCommunityImage,
  splitCommunityMessage,
  youtubeThumbnail,
} from '../shared/community-links';

const READ_KEY = 'smoothyedit:community:read-at';
const JOINED_KEY = 'smoothyedit:community:joined';
const REPORTED_KEY = 'smoothyedit:community:reported';
export const PREVIEWS_KEY = 'smoothyedit:community:previews';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* the preference just resets */ } },
};

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

/** Everything the lobby has told us about people: avatar and a guest's chosen name. Shared with Settings. */
const profiles = new Map();
export function profileFor(id) { return profiles.get(id) || null; }

/** Avatar markup for any identity; people without a profile get a stable default. */
export function avatarHtml(id, size = 32, name = '') {
  const avatar = profiles.get(id)?.avatar || defaultAvatar(id);
  if (avatar.kind === 'img') {
    return `<img class="community-avatar-img" src="${escapeHtml(avatar.data)}" width="${size}" height="${size}" alt="" draggable="false">`;
  }
  return avatarSvg(avatar, id, size, name || profiles.get(id)?.name || '');
}

const DEV_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false"><path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FLAG_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M3.5 14V2.5m0 .5h8l-1.8 3 1.8 3h-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BLOCK_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m4.2 11.8 7.6-7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function badgesHtml(entry) {
  let html = '';
  if (entry.dev) {
    html += `<span class="community-badge is-dev" title="Smoothy developer" role="img" aria-label="Smoothy developer">${DEV_ICON}<span>Dev</span></span>`;
  }
  if (entry.tier === 'pro') {
    html += `<span class="community-badge is-pro" title="Smoothy Pro" role="img" aria-label="Smoothy Pro">${cupIcon}</span>`;
  }
  if (entry.guest) html += '<span class="community-chip is-guest">Guest</span>';
  return html;
}

export function initCommunity({ signIn, openSettings } = {}) {
  const $ = (id) => document.getElementById(id);
  const feed = $('community-feed');
  const input = $('community-input');
  const sendButton = $('community-send');
  const presence = $('community-presence');
  const presenceText = $('community-presence-text');
  const reconnectButton = $('community-reconnect');
  const guestBanner = $('community-guest-banner');
  const guestText = $('community-guest-text');
  const signInButton = $('community-signin');
  const profileButton = $('community-edit-profile');
  const timeoutBanner = $('community-timeout');
  const timeoutText = $('community-timeout-text');
  const hint = $('community-hint');
  const count = $('community-count');
  const errorEl = $('community-error');
  const navDot = $('community-nav-dot');
  const tab = $('tab-community');

  let state = null;
  let unread = 0;
  let sending = false;
  let armed = '';
  let armedTimer = null;
  let timeoutTimer = null;
  const reported = new Set((() => { try { return JSON.parse(store.get(REPORTED_KEY) || '[]'); } catch { return []; } })());

  function active() {
    return Boolean(tab?.classList.contains('active'));
  }

  function previewsOn() { return store.get(PREVIEWS_KEY) !== '0'; }

  function setUnread(value) {
    unread = Math.max(0, value);
    const shown = unread > 0 && !active();
    navDot?.classList.toggle('hidden', !shown);
    if (navDot) {
      navDot.textContent = shown ? (unread > 99 ? '99+' : String(unread)) : '';
      navDot.setAttribute('aria-label', shown ? `${unread} unread community message${unread === 1 ? '' : 's'}` : '');
    }
  }

  // Everything the person has seen is remembered by time, so the badge counts
  // messages from other people that arrived since they last looked. Blocked and
  // removed messages never reach `state.messages`, so they never count.
  function markRead() {
    const last = (state?.messages || []).reduce((latest, message) => Math.max(latest, message.at || 0), 0);
    const seen = Math.max(last, Number(store.get(READ_KEY)) || 0);
    store.set(READ_KEY, String(seen || Date.now()));
    setUnread(0);
  }

  function recount() {
    if (active()) { markRead(); return; }
    const since = Number(store.get(READ_KEY)) || 0;
    if (!since) return;
    const me = state?.identity?.id;
    setUnread((state?.messages || []).filter((message) => message.at > since && !(me && message.authorId === me)).length);
  }

  function timeLabel(at) {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dayLabel(at) {
    const date = new Date(at);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(date, today)) return 'Today';
    if (sameDay(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function displayName(message) {
    // A guest's chosen name applies to everything they said, not just new messages.
    return (message.guest && profiles.get(message.authorId)?.name) || message.authorName;
  }

  /** Text with clickable allow-listed links, then a preview for each link. */
  function bodyHtml(message) {
    const parts = splitCommunityMessage(message.body);
    const links = [];
    const text = parts.map((part) => {
      if (part.type === 'text') return escapeHtml(part.text);
      links.push(part.url);
      return `<a class="community-link" href="${escapeHtml(part.url)}" data-community-link="${escapeHtml(part.url)}" rel="noopener noreferrer" title="${escapeHtml(part.url)}">${escapeHtml(part.url.replace(/^https:\/\/(www\.)?/, '').slice(0, 56))}</a>`;
    }).join('');
    const previews = links.map((url) => {
      if (previewsOn() && isCommunityImage(url)) {
        return `<button type="button" class="community-preview is-image" data-community-link="${escapeHtml(url)}" aria-label="Open picture on ${escapeHtml(communitySiteName(url))}"><img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" draggable="false"></button>`;
      }
      const thumb = previewsOn() ? youtubeThumbnail(url) : null;
      return `<button type="button" class="community-preview is-card" data-community-link="${escapeHtml(url)}">${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" draggable="false">` : ''}<span>${escapeHtml(communitySiteName(url))}<small>Open in browser</small></span></button>`;
    }).join('');
    return `<p class="community-msg-text">${text}</p>${previews ? `<div class="community-previews">${previews}</div>` : ''}`;
  }

  function actionHtml(action, id, icon, label, armedLabel, disabled = false) {
    const key = `${action}:${id}`;
    return `<button type="button" class="community-action ${armed === key ? 'is-armed' : ''}" data-action="${action}" data-id="${escapeHtml(id)}" ${disabled ? 'disabled' : ''} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}<span class="community-action-label">${escapeHtml(armed === key ? armedLabel : label)}</span></button>`;
  }

  function actionsHtml(message, own) {
    const me = state?.identity;
    const canDelete = own || me?.dev === true;
    const buttons = [];
    if (!own && !message.dev) {
      const done = reported.has(message.id);
      buttons.push(actionHtml('report', message.id, FLAG_ICON, done ? 'Reported' : 'Report', 'Confirm report', done));
    }
    if (!own) buttons.push(actionHtml('block', message.authorId, BLOCK_ICON, 'Block', 'Confirm block'));
    if (canDelete) buttons.push(actionHtml('delete', message.id, TRASH_ICON, own ? 'Delete' : 'Delete (staff)', 'Confirm delete'));
    return buttons.length ? `<div class="community-actions" role="group" aria-label="Message actions">${buttons.join('')}</div>` : '';
  }

  function messageHtml(message, previous) {
    const guest = message.guest === true;
    const grouped = previous
      && previous.authorId === message.authorId
      && message.at - previous.at < 5 * 60 * 1000;
    const own = Boolean(message.authorId && state?.identity?.id === message.authorId);
    const label = displayName(message);
    return `<article class="community-msg ${grouped ? 'is-grouped' : ''} ${own ? 'is-own' : ''}" data-guest="${guest ? 'true' : 'false'}" data-message="${escapeHtml(message.id)}">
      ${grouped ? '<span class="community-avatar is-spacer" aria-hidden="true"></span>' : `<span class="community-avatar" aria-hidden="true">${avatarHtml(message.authorId, 32, label)}</span>`}
      <div class="community-msg-body">
        ${grouped ? '' : `<header class="community-msg-head">
          <strong>${escapeHtml(label)}</strong>
          ${badgesHtml(message)}
          <time class="community-msg-time" datetime="${new Date(message.at).toISOString()}">${escapeHtml(timeLabel(message.at))}</time>
        </header>`}
        ${bodyHtml(message)}
      </div>
      ${actionsHtml(message, own)}
    </article>`;
  }

  function feedHtml(messages) {
    if (!messages.length) {
      return `<div class="community-empty">
        <h3>${state?.identity?.guest ? 'You’re the first one here' : 'No messages yet'}</h3>
        <p>Ask about an edit or share what worked.</p>
      </div>`;
    }
    let html = '';
    let previous = null;
    let day = '';
    for (const message of messages) {
      const label = dayLabel(message.at);
      if (label !== day) {
        day = label;
        html += `<div class="community-day">${escapeHtml(label)}</div>`;
        previous = null;
      }
      html += messageHtml(message, previous);
      previous = message;
    }
    return html;
  }

  function timeoutLabel(until) {
    const minutes = Math.max(1, Math.round((until - Date.now()) / 60_000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  function render() {
    if (!state) return;
    const messages = state.messages || [];
    const stick = feed ? feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90 : true;
    if (feed) {
      feed.innerHTML = feedHtml(messages);
      if (stick) feed.scrollTop = feed.scrollHeight;
    }

    if (presence && presenceText) {
      presence.dataset.status = state.status;
      presenceText.textContent = state.status === 'online'
        ? `${state.presence || 1} editor${state.presence === 1 ? '' : 's'} here`
        : state.status === 'connecting'
          ? 'Connecting…'
          : state.status === 'offline' ? 'Offline' : 'Not connected';
    }

    const connected = state.status === 'online';
    const timedOut = Boolean(state.sanction);
    reconnectButton?.classList.toggle('hidden', connected);
    if (input) {
      input.disabled = !connected || timedOut;
      input.placeholder = timedOut
        ? 'You’re on a timeout — you can still read the lobby.'
        : connected
          ? 'Ask a question or share what worked…'
          : state.status === 'connecting' ? 'Connecting to the lobby…' : 'Reconnecting to the lobby…';
    }
    if (sendButton) sendButton.disabled = !connected || timedOut || sending || !input?.value.trim();

    timeoutBanner?.classList.toggle('hidden', !timedOut);
    if (timedOut && timeoutText) {
      timeoutText.textContent = `You can’t post for ${timeoutLabel(state.sanction.until)} because a message of yours was reported by other members. You can still read and block people.`;
    }
    clearTimeout(timeoutTimer);
    if (timedOut) timeoutTimer = setTimeout(() => void refresh(), Math.min(state.sanction.until - Date.now() + 500, 60_000));

    const guest = state.identity?.guest === true;
    guestBanner?.classList.toggle('hidden', !guest);
    if (guest && guestText && state.identity) {
      const name = profiles.get(state.identity.id)?.name || state.identity.name;
      guestText.textContent = `You’re chatting as ${name} — guests can join in, pick an avatar and rename themselves. Sign in to keep your name and upload a picture.`;
    }

    if (errorEl) {
      errorEl.textContent = state.error || '';
      errorEl.classList.toggle('hidden', !state.error);
    }
    if (hint) {
      hint.textContent = connected ? 'Enter sends · Shift+Enter for a new line' : 'The lobby reconnects automatically.';
    }

    setUnread(unread);
  }

  async function refresh() {
    try {
      const next = await window.electronAPI.communityState();
      if (next) applyState(next);
    } catch { /* the next state push repairs the view */ }
  }

  function updateCount() {
    if (!count || !input) return;
    const length = input.value.length;
    count.textContent = `${length}/500`;
    count.dataset.over = String(length > 500);
    if (sendButton) sendButton.disabled = !input.value.trim() || state?.status !== 'online' || sending || Boolean(state?.sanction);
  }

  function applyState(next) {
    state = next;
    render();
    recount();
  }

  function applyProfiles(list) {
    let changed = false;
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry?.id) continue;
      profiles.set(entry.id, {
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : null,
        avatar: cleanAvatar(entry.avatar),
      });
      changed = true;
    }
    if (changed) {
      render();
      window.dispatchEvent(new CustomEvent('smoothy-community-profiles'));
    }
  }

  function identityStale(current) {
    if (!current?.identity) return false;
    return current.identity.guest !== !current.signedIn;
  }

  async function connect(force = false) {
    if (!state) return;
    if (!force && state.status === 'online' && !identityStale(state)) return;
    const next = await window.electronAPI.communityConnect();
    if (next) applyState(next);
  }

  async function send() {
    if (!input || sending) return;
    const body = input.value;
    if (!body.trim()) return;
    sending = true;
    updateCount();
    try {
      const result = await window.electronAPI.communitySend(body);
      if (result?.success) {
        input.value = '';
        updateCount();
        input.focus();
      } else if (result?.error && hint) {
        hint.textContent = result.error;
      }
    } catch {
      if (hint) hint.textContent = 'Could not send that message.';
    } finally {
      sending = false;
      updateCount();
    }
  }

  function say(message) {
    if (hint) hint.textContent = message;
  }

  /** First click arms a button ("Confirm delete"), the second does it. Re-renders keep the armed state. */
  async function onAction(button) {
    const { action, id } = button.dataset;
    const key = `${action}:${id}`;
    if (armed !== key) {
      armed = key;
      clearTimeout(armedTimer);
      armedTimer = setTimeout(() => { armed = ''; render(); }, 3500);
      render();
      // Restore keyboard focus to the newly rendered Confirm button so Enter twice works.
      const nextBtn = feed?.querySelector(`.community-action[data-action="${CSS.escape(action)}"][data-id="${CSS.escape(id)}"]`);
      nextBtn?.focus();
      return;
    }
    armed = '';
    clearTimeout(armedTimer);
    let result;
    try {
      if (action === 'delete') result = await window.electronAPI.communityDelete(id);
      else if (action === 'block') result = await window.electronAPI.communityBlock(id);
      else if (action === 'report') {
        if (state?.identity?.guest) { render(); say('Sign in to report a message.'); signIn?.(); return; }
        result = await window.electronAPI.communityReport(id);
        if (result?.success) {
          reported.add(id);
          store.set(REPORTED_KEY, JSON.stringify([...reported].slice(-300)));
        }
      }
    } catch {
      result = { success: false, error: 'The lobby did not answer. Try again.' };
    }
    render();
    if (!result?.success) say(result?.error || 'That did not work. Try again.');
    else if (action === 'report') say(result.removed ? 'Thanks — that message was removed.' : 'Thanks — your report was sent.');
    else if (action === 'block') say('Blocked. You can unblock people in Settings → Community.');
  }

  function bind() {
    input?.addEventListener('input', updateCount);
    input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void send();
    });
    sendButton?.addEventListener('click', () => void send());
    signInButton?.addEventListener('click', () => signIn?.());
    profileButton?.addEventListener('click', () => openSettings?.('profile'));
    reconnectButton?.addEventListener('click', () => void connect(true));

    // Links never navigate the app: every click goes through the main process,
    // which only opens the allow-listed hosts.
    feed?.addEventListener('click', (event) => {
      const link = event.target.closest?.('[data-community-link]');
      if (link) {
        event.preventDefault();
        void window.electronAPI.communityOpenLink(link.dataset.communityLink);
        return;
      }
      const action = event.target.closest?.('[data-action]');
      if (action && !action.disabled) void onAction(action);
    });
    // A picture that fails to load (removed, blocked, offline) just disappears.
    feed?.addEventListener('error', (event) => {
      if (event.target?.tagName === 'IMG') event.target.closest('.community-preview')?.remove();
    }, true);

    document.querySelector('.nav-item[data-tab="community"]')?.addEventListener('click', () => {
      store.set(JOINED_KEY, '1');
      markRead();
      void connect();
    });

    window.addEventListener('smoothy-auth-changed', () => {
      void connect(true);
    });
    window.addEventListener('smoothy-community-previews', () => render());

    if (tab) {
      const observer = new MutationObserver(() => {
        if (active()) {
          store.set(JOINED_KEY, '1');
          markRead();
          void connect();
        } else {
          recount();
        }
      });
      observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
    }
  }

  async function init() {
    bind();
    try {
      applyProfiles(await window.electronAPI.communityProfiles());
      state = await window.electronAPI.communityState();
      render();
      updateCount();
      recount();
      // Anyone who has opened Community before keeps receiving it quietly so the badge stays right.
      if (store.get(JOINED_KEY) === '1' && !active()) void connect();
    } catch {
      if (hint) hint.textContent = 'Community chat could not start.';
    }
    window.electronAPI.onCommunityState((next) => applyState(next));
    window.electronAPI.onCommunityProfiles((list) => applyProfiles(list));
  }

  void init();
}
