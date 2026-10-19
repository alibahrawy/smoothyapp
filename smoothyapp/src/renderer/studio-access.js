/** Visitors can browse. Free accounts use their allowance on eligible tools. */
export const studioProModes = ['thumbnail', 'broll', 'twitter', 'blog', 'sfx'];
export const canGenerateStudio = (user, mode) => Boolean(user && (!studioProModes.includes(mode) || user.tier === 'pro'));
export function studioAccessNotice(host, getUser, signIn) {
  const notice = document.createElement('div'); notice.className = 'studio-access-notice';
  const text = document.createElement('p');
  const free = document.createElement('strong'); free.textContent = 'free';
  const credits = document.createElement('strong'); credits.textContent = '100 AI credits';
  const upgrade = document.createElement('button'); upgrade.type = 'button'; upgrade.className = 'btn studio-access-button'; upgrade.textContent = 'View Studio Pro ↗';
  upgrade.addEventListener('click', () => getUser() ? window.electronAPI.openExternal('https://smoothyedit.com/pricing') : signIn?.('signup'));
  notice.append(text, upgrade); host.prepend(notice);
  return () => {
    const user = getUser();
    notice.classList.toggle('hidden', user?.tier === 'pro');
    text.replaceChildren(user ? 'Your ' : 'Sign up for ', free, user ? ' account includes ' : ' and get ', credits, ' every month.');
    upgrade.textContent = user ? 'View Studio Pro ↗' : 'Sign up for free';
  };
}
