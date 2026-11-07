/**
 * Community lobby tab.
 *
 * Renders the shared message feed, guest identity banner and composer. The
 * connection lives in the main process; this module only reacts to state.
 */

export function initCommunity({ signIn } = {}) {
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
  const hint = $('community-hint');
  const count = $('community-count');
  const errorEl = $('community-error');
  const navDot = $('community-nav-dot');
  const tab = $('tab-community');

  let state = null;
  let unread = 0;
  let sending = false;

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  function active() {
    return Boolean(tab?.classList.contains('active'));
  }

  const READ_KEY = 'smoothyedit:community:read-at';
  const JOINED_KEY = 'smoothyedit:community:joined';
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* unread count just resets */ } },
  };

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
  // messages from other people that arrived since they last looked.
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

  function initials(name) {
    const parts = String(name || '?')
      .replace(/^Guest\s+/i, '')
      .split(/\s+/)
      .filter((part) => part && !/^\d+$/.test(part));
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase().slice(0, 2);
  }

  function messageHtml(message, previous) {
    const guest = message.guest === true;
    const grouped = previous
      && previous.authorId === message.authorId
      && message.at - previous.at < 5 * 60 * 1000;
    const own = message.authorId && state?.identity?.id === message.authorId;
    return `<article class="community-msg ${grouped ? 'is-grouped' : ''} ${own ? 'is-own' : ''}" data-guest="${guest ? 'true' : 'false'}">
      ${grouped ? '<span class="community-avatar is-spacer" aria-hidden="true"></span>' : `<span class="community-avatar" aria-hidden="true">${escapeHtml(initials(message.authorName))}</span>`}
      <div class="community-msg-body">
        ${grouped ? '' : `<header class="community-msg-head">
          <strong>${escapeHtml(message.authorName)}</strong>
          ${guest ? '<span class="community-chip is-guest">Guest</span>' : message.tier === 'pro' ? '<span class="community-chip is-pro">Pro</span>' : ''}
          <time class="community-msg-time" datetime="${new Date(message.at).toISOString()}">${escapeHtml(timeLabel(message.at))}</time>
        </header>`}
        <p class="community-msg-text">${escapeHtml(message.body)}</p>
      </div>
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
    reconnectButton?.classList.toggle('hidden', connected);
    if (input) {
      input.disabled = !connected;
      input.placeholder = connected
        ? 'Ask a question or share what worked…'
        : state.status === 'connecting' ? 'Connecting to the lobby…' : 'Reconnecting to the lobby…';
    }
    if (sendButton) sendButton.disabled = !connected || sending || !input?.value.trim();

    const guest = state.identity?.guest === true;
    guestBanner?.classList.toggle('hidden', !guest);
    if (guest && guestText && state.identity) {
      guestText.textContent = `You’re chatting as ${state.identity.name} — guests can join in, but your name is temporary.`;
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

  function updateCount() {
    if (!count || !input) return;
    const length = input.value.length;
    count.textContent = `${length}/500`;
    count.dataset.over = String(length > 500);
    if (sendButton) sendButton.disabled = !input.value.trim() || state?.status !== 'online' || sending;
  }

  function applyState(next) {
    state = next;
    render();
    recount();
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

  function bind() {
    input?.addEventListener('input', updateCount);
    input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void send();
    });
    sendButton?.addEventListener('click', () => void send());
    signInButton?.addEventListener('click', () => signIn?.());
    reconnectButton?.addEventListener('click', () => void connect(true));

    document.querySelector('.nav-item[data-tab="community"]')?.addEventListener('click', () => {
      store.set(JOINED_KEY, '1');
      markRead();
      void connect();
    });

    feed?.addEventListener('scroll', () => {
      // Kept for future "jump to latest" affordance; rendering sticks to the
      // bottom only while the reader is already close to it.
    });

    window.addEventListener('smoothy-auth-changed', () => {
      void connect(true);
    });

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
  }

  void init();
}
