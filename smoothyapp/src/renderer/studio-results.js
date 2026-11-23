// All provider values enter the DOM as text. Copied text is paste-ready:
// values only, never field names such as "Title:" or "Start Time:".
const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
function supported(data, mode) {
  if (!data || typeof data !== 'object') return false;
  const arrays = { title: ['titles'], hook: ['hooks'], condense: ['segments'], description: ['resources','timestamps','seoContent','tags'], thumbnail: ['thumbnailIdeas'], broll: ['suggestions'], sfx: ['sfxCues'], twitter: ['posts'], blog: [] };
  for (const key of arrays[mode] || []) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(x => x == null))) return false;
  for (const key of ['hooks','segments','resources','timestamps','thumbnailIdeas','suggestions','sfxCues']) if (Array.isArray(data[key]) && data[key].some(x => typeof x !== 'object' || Array.isArray(x))) return false;
  if (mode === 'blog' && data.blogPost) { const b = data.blogPost; if (typeof b !== 'object') return false; for (const key of ['sections','keyTakeaways','seoKeywords','suggestedTags']) if (b[key] !== undefined && !Array.isArray(b[key])) return false; if (b.sections?.some(s => !s || typeof s !== 'object' || (s.subSections !== undefined && (!Array.isArray(s.subSections) || s.subSections.some(x => !x || typeof x !== 'object'))))) return false; }
  return true;
}
export function parseStudioResult(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { return null; }
}

const str = value => (value == null ? '' : String(value).trim());
const join = (parts, sep = '\n\n') => parts.map(str).filter(Boolean).join(sep);
/** Values only, in order; nested lists become separate lines or blocks. */
export function resultText(value, depth = 0) {
  if (depth > 12 || value == null) return '';
  if (Array.isArray(value)) return join(value.map(item => resultText(item, depth + 1)), value.every(x => typeof x !== 'object') ? '\n' : '\n\n');
  if (typeof value === 'object') return join(Object.values(value).map(item => resultText(item, depth + 1)), '\n');
  return str(value);
}
const timeRange = x => x.timeRange || [x.startTime, x.endTime].filter(v => v !== undefined && v !== '').join(' - ') || x.timestamp || '';
const ranges = segments => join(segments.map(timeRange), '\n');
const chapters = timestamps => join(timestamps.map(x => `${str(x.time)} ${str(x.title)}`), '\n');
const resourceText = resources => join(resources.map(x => join([x.name, x.description, x.url], '\n')));
const titleOf = x => (typeof x === 'string' ? x : x?.title);
const postOf = x => (typeof x === 'string' ? x : x?.tweet ?? x?.content);
const without = (x, keys) => Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k)));

// Paste-ready text for one section.
const copyText = {
  title: x => str(titleOf(x)),
  hook: x => str(x.content),
  thumbnail: x => join([x.concept, x.textOverlay?.text], '\n'),
  broll: x => join([x.suggestion, x.description, x.searchTerm, x.exactText], '\n'),
  sfx: x => join([x.sfxName, x.description], '\n'),
  twitter: x => str(postOf(x)),
  blogArticle: b => join([b.headline, b.metaDescription, b.introduction]),
  blogSection: s => join([s.heading, s.content, ...(s.subSections || []).flatMap(x => [x.heading, x.content])]),
};

export function formatStudioResult(raw, mode) {
  const p = parseStudioResult(raw); if (!p) return raw;
  if (typeof p.draft === 'string') return p.draft;
  if (!supported(p, mode)) return resultText(p);
  if (mode === 'title' && Array.isArray(p.titles)) return join(p.titles.map(copyText.title));
  if (mode === 'condense' && Array.isArray(p.segments)) return join([p.title, p.description, ranges(p.segments)]);
  if (mode === 'hook' && Array.isArray(p.hooks)) return join(p.hooks.map(x => join([timeRange(x), x.content], '\n')));
  if (mode === 'description' && typeof p.intro === 'string') return join([p.intro,
    p.resources?.length ? resourceText(p.resources) : '',
    p.timestamps?.length ? chapters(p.timestamps) : '',
    ...(p.seoContent || []), p.callToAction, p.tags?.join(', ')]);
  if (mode === 'thumbnail' && Array.isArray(p.thumbnailIdeas)) return join(p.thumbnailIdeas.map(copyText.thumbnail));
  if (mode === 'broll' && Array.isArray(p.suggestions)) return join(p.suggestions.map(x => join([timeRange(x), copyText.broll(x)], '\n')));
  if (mode === 'sfx' && Array.isArray(p.sfxCues)) return join(p.sfxCues.map(x => join([timeRange(x), copyText.sfx(x)], '\n')));
  if (mode === 'twitter' && Array.isArray(p.posts)) return join([...p.posts.map(copyText.twitter), p.threadIdea]);
  if (mode === 'blog' && p.blogPost) { const b = p.blogPost; return join([copyText.blogArticle(b),
    ...(b.sections || []).map(copyText.blogSection),
    b.keyTakeaways?.map(x => `• ${x}`).join('\n'), b.conclusion, b.seoKeywords?.join(', '), b.suggestedTags?.join(', ')]); }
  return resultText(p);
}

const COPY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export function renderStudioResult(host, raw, mode, { onCopy }) {
  const parsed = parseStudioResult(raw), data = supported(parsed, mode) ? parsed : null; host.replaceChildren(); host.dataset.mode = mode;
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls || ''; if (text !== undefined) el.textContent = text; return el; };
  const text = (parent, value, cls = 'studio-body-text') => { const v = str(value); if (v) parent.append(node('div', `studio-result-text ${cls}`, v)); };
  const field = (parent, title, value, cls) => { const v = str(value); if (!v) return; const wrap = node('div', 'studio-result-field'); wrap.append(node('div', 'studio-field-label', title)); text(wrap, v, cls); parent.append(wrap); };
  const badge = (parent, value, cls = 'studio-type-badge') => { const v = str(value); if (v) parent.append(node('span', cls, cls === 'studio-type-badge' ? label(v) : v)); };
  const extra = (parent, obj, skip) => { for (const [k, v] of Object.entries(without(obj, skip))) field(parent, label(k), resultText(v)); };

  const feedback = (button, done) => {
    clearTimeout(button._t); button.innerHTML = CHECK_ICON; button.classList.add('copied');
    if (done) done.classList.add('copied');
    button._t = setTimeout(() => { button.innerHTML = COPY_ICON; button.classList.remove('copied'); done?.classList.remove('copied'); }, 1400);
  };
  /** A section card: clicking anywhere on it copies `copy` (values only). */
  function card(title, copy, build, cls = '') {
    const value = str(copy);
    const c = node('section', `studio-result-card ${cls}`), header = node('div', 'studio-result-card-heading');
    header.append(node('h3', '', title));
    const button = node('button', 'studio-copy-btn'); button.type = 'button'; button.innerHTML = COPY_ICON;
    button.setAttribute('aria-label', `Copy ${title}`); button.title = 'Copy';
    header.append(button); c.append(header); build(c);
    const run = event => { event?.stopPropagation(); if (button.disabled || !value || window.getSelection()?.toString()) return; onCopy(value); feedback(button, c); };
    button.addEventListener('click', run);
    if (value) { c.classList.add('studio-copyable'); c.title = 'Click to copy'; c.addEventListener('click', run); }
    else button.hidden = true;
    host.append(c); return c;
  }
  /** A chip that copies only itself (tags, keywords). */
  function chips(parent, items) {
    const list = node('div', 'studio-tag-list');
    for (const item of items) {
      const v = str(item); if (!v) continue;
      const chip = node('button', 'studio-tag', v); chip.type = 'button'; chip.title = 'Copy tag';
      chip.addEventListener('click', event => { event.stopPropagation(); if (chip.disabled) return; onCopy(v); chip.textContent = 'Copied'; chip.classList.add('copied'); setTimeout(() => { chip.textContent = v; chip.classList.remove('copied'); }, 1200); });
      list.append(chip);
    }
    parent.append(list);
  }
  const each = (key, title, copy, build, cls = '') => { if (!Array.isArray(data?.[key])) return false; data[key].forEach((x, i) => card(`${title} ${i + 1}`, copy(x), c => build(c, x, i), cls)); return data[key].length > 0; };

  let handled = false;
  if (mode === 'title') handled = each('titles', 'Title', copyText.title, (c, x) => {
    const t = str(titleOf(x)); text(c, t, 'studio-title-text');
    const meta = node('div', 'studio-result-meta'); badge(meta, `${t.length} characters`, 'studio-meta-badge'); if (typeof x === 'object') { badge(meta, x.style); if (x.primaryKeyword) badge(meta, `Keyword: ${x.primaryKeyword}`, 'studio-meta-badge'); } c.append(meta);
  }, 'studio-title-card');
  if (mode === 'hook') handled = each('hooks', 'Opening', copyText.hook, (c, x) => {
    const meta = node('div', 'studio-result-meta'); badge(meta, timeRange(x), 'studio-time-badge'); badge(meta, x.type); c.append(meta);
    text(c, x.content, 'studio-quote-text'); extra(c, x, ['startTime', 'endTime', 'type', 'content', 'timeRange']);
  });
  if (mode === 'condense' && Array.isArray(data?.segments)) { handled = true;
    if (str(data.title)) card('Title', data.title, c => text(c, data.title, 'studio-title-text'));
    if (str(data.description)) card('Description', data.description, c => text(c, data.description));
    if (data.segments.length) card('Keep ranges', ranges(data.segments), c => {
      data.segments.forEach((x, i) => { const row = node('div', 'studio-chapter-row'); row.append(node('span', 'studio-chapter-time', `Keep ${i + 1}`)); const body = node('div'); text(body, timeRange(x), 'studio-range-text'); extra(body, x, ['startTime', 'endTime', 'timeRange', 'timestamp']); row.append(body); c.append(row); });
    }, 'studio-timeline-card');
    extra(host.lastElementChild || host, without(data, ['title', 'description', 'segments']), []);
  }
  if (mode === 'description' && typeof data?.intro === 'string') { handled = true;
    card('Intro', data.intro, c => text(c, data.intro));
    if (data.resources?.length) card('Resources', resourceText(data.resources), c => data.resources.forEach(x => { const r = node('div', 'studio-resource'); text(r, x.name, 'studio-resource-name'); text(r, x.description, 'studio-resource-desc'); text(r, x.url, 'studio-resource-url'); c.append(r); }));
    if (data.timestamps?.length) card('Timestamps', chapters(data.timestamps), c => data.timestamps.forEach(x => { const row = node('div', 'studio-chapter-row'); row.append(node('span', 'studio-chapter-time', str(x.time))); row.append(node('span', 'studio-chapter-title', str(x.title))); c.append(row); }));
    if (data.seoContent?.length) card('SEO content', join(data.seoContent), c => data.seoContent.forEach(p => text(c, p)));
    if (str(data.callToAction)) card('Call to action', data.callToAction, c => text(c, data.callToAction));
    if (data.tags?.length) card('Suggested tags', data.tags.join(', '), c => chips(c, data.tags));
  }
  if (mode === 'thumbnail') handled = each('thumbnailIdeas', 'Concept', copyText.thumbnail, (c, x) => {
    const meta = node('div', 'studio-result-meta'); badge(meta, x.thumbnailType); c.append(meta);
    text(c, x.concept, 'studio-title-text'); field(c, 'Thumbnail text', x.textOverlay?.text, 'studio-thumbnail-text');
    extra(c, x, ['concept', 'thumbnailType', 'textOverlay']);
  }, 'studio-thumbnail-card');
  if (mode === 'broll') handled = each('suggestions', 'Visual', copyText.broll, (c, x) => {
    const meta = node('div', 'studio-result-meta'); badge(meta, timeRange(x), 'studio-time-badge'); badge(meta, x.type); c.append(meta);
    text(c, x.suggestion, 'studio-title-text'); field(c, 'Visual direction', x.description); field(c, 'Search for', x.searchTerm); field(c, 'Text on screen', x.exactText);
  }, 'studio-timeline-card');
  if (mode === 'sfx') handled = each('sfxCues', 'Sound cue', copyText.sfx, (c, x) => {
    const meta = node('div', 'studio-result-meta'); badge(meta, timeRange(x), 'studio-time-badge'); badge(meta, x.sfxType); badge(meta, x.intensity); c.append(meta);
    text(c, x.sfxName, 'studio-title-text'); field(c, 'At this moment', x.subtitle, 'studio-quote-text'); field(c, 'Sound direction', x.description); field(c, 'Why it fits', x.rationale);
  }, 'studio-timeline-card');
  if (mode === 'twitter') { handled = each('posts', 'Post', copyText.twitter, (c, x) => { if (typeof x === 'object') { const meta = node('div', 'studio-result-meta'); badge(meta, x.toneStyle); c.append(meta); } text(c, postOf(x)); });
    if (data?.graphicsByType) { const details = node('details', 'studio-graphic-briefs'); details.append(node('summary', '', 'Graphic ideas for your posts')); const holder = host; for (const [key, item] of Object.entries(data.graphicsByType)) { host = details; card(label(key), resultText(item), c => extra(c, typeof item === 'object' && item ? item : { [key]: item }, [])); } host = holder; host.append(details); }
    if (str(data?.threadIdea)) { handled = true; card('Thread idea', data.threadIdea, c => text(c, data.threadIdea)); }
  }
  if (mode === 'blog' && data?.blogPost) { handled = true; const b = data.blogPost;
    card('Article', copyText.blogArticle(b), c => { text(c, b.headline, 'studio-article-headline'); field(c, 'Meta description', b.metaDescription); text(c, b.introduction); });
    (b.sections || []).forEach((s, i) => card(`Section ${i + 1}`, copyText.blogSection(s), c => { text(c, s.heading, 'studio-title-text'); text(c, s.content); (s.subSections || []).forEach(x => { text(c, x.heading, 'studio-subheading-text'); text(c, x.content); }); }));
    if (b.keyTakeaways?.length) card('Key takeaways', b.keyTakeaways.map(x => `• ${x}`).join('\n'), c => b.keyTakeaways.forEach(x => text(c, `• ${x}`)));
    if (str(b.conclusion)) card('Conclusion', b.conclusion, c => text(c, b.conclusion));
    if (b.seoKeywords?.length) card('SEO keywords', b.seoKeywords.join(', '), c => chips(c, b.seoKeywords));
    if (b.suggestedTags?.length) card('Suggested tags', b.suggestedTags.join(', '), c => chips(c, b.suggestedTags));
  }
  if (!handled) { const all = formatStudioResult(raw, mode); card('Draft', all, c => text(c, all)); }
}
