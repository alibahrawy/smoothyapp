// Native account form. Only the signed server response can confirm verification.
export function initAccount({ getUser, enabled, onSignedIn }) {
  const $ = id => document.getElementById(id), api = window.electronAPI;
  let view = 'login', busy = false, epoch = 0, previousFocus = null;
  const error = text => { $('login-error').textContent = text; $('login-error').classList.toggle('hidden', !text); };
  const verificationStatus = text => { $('account-verification-status').textContent = text; };
  function render() {
    const verification = view === 'verification', signup = view === 'signup';
    $('account-heading').textContent = verification ? 'Verify your email' : signup ? 'Create your SmoothyEdit account' : 'Sign in to SmoothyEdit';
    $('login-form').classList.toggle('hidden', verification);
    $('account-form-footer').classList.toggle('hidden', verification);
    $('account-verification').classList.toggle('hidden', !verification);
    $('signup-name-group').classList.toggle('hidden', !signup);
    $('signup-confirm-group').classList.toggle('hidden', !signup);
    $('signup-confirm').required = signup;
    $('login-password').minLength = signup ? 8 : 1;
    $('login-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('account-switch-label').textContent = signup ? 'Already have an account?' : 'Don’t have an account?';
    $('signup-link').textContent = signup ? 'Sign in' : 'Create account';
    $('login-submit-btn').textContent = busy ? (signup ? 'Creating account…' : 'Signing in…') : signup ? 'Create free account' : 'Sign in';
    document.querySelectorAll('#login-form input, #login-submit-btn').forEach(el => { el.disabled = busy; });
    $('account-check-verification').disabled = busy;
    $('account-open-inbox').disabled = busy || !$('account-inbox-provider').value;
  }
  function close() {
    epoch++; busy = false;
    $('login-modal').classList.add('hidden'); $('login-form').reset(); error('');
    $('totp-group').classList.add('hidden'); previousFocus?.focus();
  }
  function verifyView() {
    view = 'verification'; error('');
    const email = getUser()?.email || '';
    $('account-verification-email').textContent = email;
    const domain = email.split('@').at(-1)?.toLowerCase();
    $('account-inbox-provider').value = ({ 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook', 'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud' })[domain] || '';
    $('login-password').value = ''; $('signup-confirm').value = '';
    verificationStatus('Check your inbox and spam folder for the verification link.'); render();
    $('account-inbox-provider').focus();
  }
  function open() {
    if (!enabled()) return;
    previousFocus = document.activeElement;
    $('login-modal').classList.remove('hidden'); $('login-form').reset(); $('totp-group').classList.add('hidden'); error('');
    view = 'login'; busy = false; epoch++;
    if (getUser()?.emailVerified === false) verifyView();
    else { render(); $('login-email').focus(); }
  }
  async function submit(event) {
    event.preventDefault(); if (busy || !enabled()) return;
    if (view === 'signup' && $('login-password').value !== $('signup-confirm').value) return error('Passwords do not match.');
    const stamp = epoch, signup = view === 'signup'; busy = true; error(''); render();
    try {
      const email = $('login-email').value.trim(), password = $('login-password').value;
      const result = signup
        ? await api.signup({ name: $('signup-name').value.trim(), email, password })
        : await api.login(email, password, $('login-totp').value.trim() || undefined);
      if (stamp !== epoch || !enabled()) return;
      if (result.requires2FA) { $('totp-group').classList.remove('hidden'); $('login-totp').focus(); return; }
      if (!result.success) {
        if (result.accountCreated) { view = 'login'; $('login-password').value = ''; $('signup-confirm').value = ''; }
        error(result.error || 'Could not sign in.'); return;
      }
      await onSignedIn(); if (stamp !== epoch || !enabled()) return;
      $('login-password').value = ''; $('signup-confirm').value = '';
      if (getUser()?.emailVerified === false) verifyView(); else close();
    } catch { if (stamp === epoch) error('Could not reach SmoothyEdit. Please try again.'); }
    finally { if (stamp === epoch) { busy = false; render(); if (!$('totp-group').classList.contains('hidden')) $('login-totp').focus(); } }
  }
  $('login-form').addEventListener('submit', submit);
  $('login-form').addEventListener('input', () => error(''));
  $('login-close-btn').addEventListener('click', close);
  $('signup-link').addEventListener('click', event => {
    event.preventDefault(); if (busy) return;
    view = view === 'signup' ? 'login' : 'signup'; $('totp-group').classList.add('hidden'); $('login-totp').value = ''; error(''); render();
    $(view === 'signup' ? 'signup-name' : 'login-email').focus();
  });
  $('account-inbox-provider').addEventListener('change', render);
  $('account-open-inbox').addEventListener('click', async () => {
    if (busy) return; const stamp = epoch;
    try { const result = await api.openInbox($('account-inbox-provider').value); if (stamp === epoch) verificationStatus(result.success ? 'Click the verification link in your inbox, then return here.' : result.error || 'Open your email app to verify your address.'); }
    catch { if (stamp === epoch) verificationStatus('Open your email app to verify your address.'); }
  });
  $('account-check-verification').addEventListener('click', async () => {
    if (busy) return; const stamp = epoch; busy = true; render(); verificationStatus('Checking your verification…');
    try {
      const refreshed = await api.refreshAuth(); if (stamp !== epoch) return;
      await onSignedIn(); if (stamp !== epoch) return;
      if (!getUser()) { view = 'login'; error('Your session expired. Sign in again.'); }
      else if (refreshed && getUser().emailVerified === true) close();
      else verificationStatus(refreshed ? 'Your email is not verified yet. Click the link in your email first.' : 'Could not check verification. Try again when you’re online.');
    } catch { if (stamp === epoch) verificationStatus('Could not check verification. Please try again.'); }
    finally { if (stamp === epoch) { busy = false; render(); } }
  });
  $('account-verification-later').addEventListener('click', close);
  $('account-verify-btn').addEventListener('click', open);
  $('login-modal').addEventListener('click', event => { if (event.target === $('login-modal')) close(); });
  $('login-modal').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const targets = [...$('login-modal').querySelectorAll('button, input, select, a[href]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  function authChanged() {
    $('account-verify-btn').classList.toggle('hidden', !enabled() || getUser()?.emailVerified !== false);
    if (!enabled()) close();
  }
  render();
  return { open, close, authChanged };
}
