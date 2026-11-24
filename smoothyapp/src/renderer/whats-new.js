/**
 * "What's new" dialog in Settings → Updates: what the running version adds compared with the one before it.
 * Add one entry per release, keyed by "major.minor", when the release is prepared.
 */
export const WHATS_NEW = {
  '3.6': {
    since: '3.5.0',
    sections: [
      { title: 'Animated captions', items: [
        { tag: 'new', title: 'Free Outline style', text: 'Send word-by-word animated Outline captions straight to Premiere Pro on the free plan, with adjustable screen position.' },
        { tag: 'new', title: 'Four animated styles in Smoothy Pro', text: 'Pick Outline, Box, Rise or Slide, and customize colors, size, stroke, shadow and box styling. Box removes the scale bounce and only fades in after a pause.' },
        { tag: 'new', title: 'Live preview & bundled fonts', text: 'Preview every caption style live over video right in the Captions tab. Inter Display and Plus Jakarta Sans ship with the app and install automatically when needed.' },
      ] },
      { title: 'Design & polish', items: [
        { tag: 'improved', title: 'Updated Smoothy cup icon', text: 'Refreshed app icon and brand mark with a thicker straw across macOS, Linux and Windows.' },
      ] },
    ],
  },
  '3.5': {
    since: '3.0.0',
    sections: [
      { title: 'Community', items: [
        { tag: 'new', title: 'Profiles', text: 'Pick a character or upload a photo (members) and choose a guest name. Edit it from the Profile button in Community or Settings → Profile, with a live preview of how you appear.' },
        { tag: 'new', title: 'Links and previews', text: 'Links from YouTube, X, Google Drive, Frame.io, Instagram and Reddit now work in chat, and direct pictures preview inline. Turn previews off any time; every other link is still removed.' },
        { tag: 'new', title: 'Reports, blocks and timeouts', text: 'Report a message, block anyone, or delete your own. Three reports remove a message and give its author a growing timeout; they can still read. Blocking works both ways.' },
        { tag: 'new', title: 'Dev and Pro badges', text: 'Staff and Smoothy Pro members now carry a badge next to their name.' },
      ] },
      { title: 'Audio Library', items: [
        { tag: 'new', title: 'Sound effects', text: 'A built-in library of whooshes, risers, hits and clicks. Every sound is CC0 or made for SmoothyApp, so use it anywhere with no credit. Preview, save as WAV, or send to Premiere or Resolve.' },
      ] },
      { title: 'Stock footage', items: [
        { tag: 'new', title: 'Coverr', text: 'Coverr joins the free footage sources, and Coverr and Pixabay can list popular clips before you type a search. Agents can search it too.' },
      ] },
      { title: 'Chat', items: [
        { tag: 'new', title: 'Model switcher', text: 'Choose Luna, Claude Haiku 5.5, DeepSeek V4.1 Flash or Gemini 3.8 Flash from the composer. Your choice is remembered.' },
      ] },
      { title: 'Updates', items: [
        { tag: 'new', title: 'Automatic updates', text: 'On by default: new versions download in the background and install when you quit. Turn it off to choose each update yourself.' },
        { tag: 'improved', title: 'What’s new', text: 'See what each version adds, right here in Settings → Updates.' },
      ] },
    ],
  },
};

const TAGS = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

export function initWhatsNew({ getVersion }) {
  const button = document.getElementById('whats-new-btn'), modal = document.getElementById('whats-new-modal');
  const body = document.getElementById('whats-new-body'), title = document.getElementById('whats-new-title'), sub = document.getElementById('whats-new-sub');
  const close = document.getElementById('whats-new-close');
  if (!button || !modal) return;
  let returnFocus = null;
  const entryFor = version => WHATS_NEW[String(version || '').match(/^\d+\.\d+/)?.[0]];

  function render() {
    const version = getVersion(), entry = entryFor(version);
    title.textContent = `What’s new in SmoothyApp${version ? ` v${version}` : ''}`;
    body.replaceChildren();
    if (!entry) {
      sub.textContent = '';
      const empty = document.createElement('p');
      empty.className = 'help-text';
      empty.textContent = 'There is no summary for this version yet. The full notes are on the release page.';
      body.append(empty);
      return;
    }
    sub.textContent = `New since v${entry.since}`;
    for (const section of entry.sections) {
      const group = document.createElement('section'), heading = document.createElement('h4'), list = document.createElement('ul');
      group.className = 'whats-new-section'; heading.textContent = section.title; list.className = 'whats-new-list';
      for (const item of section.items) {
        const row = document.createElement('li'), chip = document.createElement('span'), copy = document.createElement('div'), name = document.createElement('strong'), text = document.createElement('p');
        chip.className = `whats-new-tag whats-new-tag-${item.tag}`; chip.textContent = TAGS[item.tag] || 'New';
        name.textContent = item.title; text.textContent = item.text;
        copy.append(name, text); row.append(chip, copy); list.append(row);
      }
      group.append(heading, list); body.append(group);
    }
  }

  function open() {
    returnFocus = document.activeElement;
    render();
    document.getElementById('settings-modal').inert = true;
    modal.classList.remove('hidden');
    body.scrollTop = 0;
    close.focus();
  }
  function dismiss() {
    modal.classList.add('hidden');
    document.getElementById('settings-modal').inert = false;
    (returnFocus?.getClientRects().length ? returnFocus : button).focus();
  }
  button.addEventListener('click', open);
  close.addEventListener('click', dismiss);
  modal.addEventListener('click', event => { if (event.target === modal) dismiss(); });
  // Capture phase: Settings also listens for Escape and Tab, and must not react while this dialog is on top.
  document.addEventListener('keydown', event => {
    if (modal.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
    else if (event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); close.focus(); }
  }, true);
}
