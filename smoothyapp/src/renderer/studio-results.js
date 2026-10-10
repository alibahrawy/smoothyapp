// All provider values enter the DOM as text. Editable fields retain the API schema.
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
export function resultText(value, depth = 0) {
  if (depth > 12) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map(item => resultText(item, depth + 1)).join('\n\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${label(key)}${typeof item === 'object' && item !== null ? '\n' : ': '}${resultText(item, depth + 1)}`).join('\n');
  return value == null ? '' : String(value);
}
export function formatStudioResult(raw, mode) {
  const p = parseStudioResult(raw); if (!p) return raw;
  if (typeof p.draft === 'string') return p.draft;
  if (!supported(p, mode)) return resultText(p);
  if (mode === 'title' && Array.isArray(p.titles)) return p.titles.map(x => typeof x === 'string' ? x : x.title).join('\n\n');
  if (mode === 'description' && typeof p.intro === 'string') return [p.intro,
    ...(p.resources?.length ? ['Resources', ...p.resources.map(x => [x.name, x.description, x.url].filter(Boolean).join('\n'))] : []),
    ...(p.timestamps?.length ? ['Chapters', p.timestamps.map(x => `${x.time} ${x.title}`).join('\n')] : []),
    ...(p.seoContent || []), p.callToAction, p.tags?.join(', ')].filter(Boolean).join('\n\n');
  if (mode === 'blog' && p.blogPost) { const b = p.blogPost; return [b.headline, b.metaDescription, b.introduction,
    ...(b.sections || []).flatMap(s => [s.heading, s.content, ...(s.subSections || []).flatMap(x => [x.heading, x.content])]),
    b.keyTakeaways?.map(x => `• ${x}`).join('\n'), b.conclusion, b.seoKeywords?.join(', '), b.suggestedTags?.join(', ')].filter(Boolean).join('\n\n'); }
  return resultText(p);
}

export function renderStudioResult(host, raw, mode, { onChange, onCopy }) {
  const parsed = parseStudioResult(raw), data = supported(parsed, mode) ? parsed : null; host.replaceChildren(); host.dataset.mode = mode;
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls || ''; if (text !== undefined) el.textContent = text; return el; };
  function edit(parent, path, title, cls = '') {
    let value = data; for (const key of path) value = value?.[key];
    if (value === undefined || value === null || typeof value === 'object') return;
    const wrap = node('div', 'studio-result-field');
    if (title) wrap.append(node('div', 'studio-field-label', title));
    const field = node('div', `studio-editable ${cls}`, String(value)); field.contentEditable = 'plaintext-only';
    field.setAttribute('role', 'textbox'); field.setAttribute('aria-label', title || 'Draft text'); field.setAttribute('aria-multiline', 'true');
    field.addEventListener('input', () => { let target = data; for (const key of path.slice(0, -1)) target = target[key]; target[path.at(-1)] = field.innerText; onChange(JSON.stringify(data)); });
    wrap.append(field); parent.append(wrap);
  }
  function fields(parent, value, path, depth = 0) {
    if (depth > 8 || value == null) return;
    if (typeof value !== 'object') { edit(parent, path, '', 'studio-body-text'); return; }
    for (const [key, item] of Object.entries(value)) {
      if (item == null || item === '') continue;
      if (typeof item !== 'object') edit(parent, [...path, key], Array.isArray(value) ? '' : label(key));
      else { const group = node('div', Array.isArray(item) ? 'studio-result-list' : 'studio-result-group'); if (!Array.isArray(value)) group.append(node('div', 'studio-field-label', label(key))); fields(group, item, [...path, key], depth + 1); parent.append(group); }
    }
  }
  function card(title, value, path, build, cls = '') {
    const c = node('section', `studio-result-card ${cls}`), header = node('div', 'studio-result-card-heading');
    header.append(node('h3', '', title)); const copy = node('button', 'stock-text-button', 'Copy'); copy.type = 'button'; copy.setAttribute('aria-label', `Copy ${title}`);
    copy.addEventListener('click', () => { let current = data; for (const key of path) current = current?.[key]; onCopy(typeof current === 'string' ? current : resultText(current)); });
    header.append(copy); c.append(header); build ? build(c) : fields(c, value, path); host.append(c); return c;
  }
  const list = (key, title, build, cls = '') => { if (!Array.isArray(data?.[key])) return false; data[key].forEach((item, i) => card(`${title} ${i + 1}`, item, [key, i], c => build(c, item, [key, i], i), cls)); return data[key].length > 0; };
  const range = (c, x) => { const text = x.timeRange || [x.startTime, x.endTime].filter(v => v !== undefined).join(' → ') || x.timestamp; if (text !== undefined && text !== '') c.append(node('span', 'studio-time-badge', String(text))); };
  const badge = (c, text) => { if (text) c.append(node('span', 'studio-type-badge', label(String(text)))); };
  let handled = false;
  if (mode === 'title') handled = list('titles', 'Title', (c, x, p, i) => { edit(c, typeof x === 'string' ? p : [...p, 'title'], '', 'studio-title-text'); const count = node('span', 'studio-field-label', `${String(typeof x === 'string' ? x : x.title || '').length} characters`); c.append(count); c.querySelector('.studio-editable')?.addEventListener('input', e => { count.textContent = `${e.currentTarget.innerText.length} characters`; }); if (x.style) badge(c, x.style); }, 'studio-title-card');
  if (mode === 'hook') handled = list('hooks', 'Opening', (c, x, p) => { range(c, x); badge(c, x.type); edit(c, [...p, 'content'], '', 'studio-quote-text'); for (const k of Object.keys(x).filter(k => !['startTime','endTime','type','content'].includes(k))) fields(c, { [k]: x[k] }, p); });
  if (mode === 'condense' && Array.isArray(data?.segments)) { handled = true; card('Your shorter edit', data, [], c => { edit(c, ['title'], '', 'studio-title-text'); edit(c, ['description'], 'Description'); }); list('segments', 'Keep range', (c, x, p) => { range(c, x); fields(c, x, p); }, 'studio-timeline-card'); }
  if (mode === 'description' && typeof data?.intro === 'string') { handled = true;
    card('Intro', data.intro, ['intro'], c => edit(c, ['intro'], '', 'studio-body-text'));
    for (const [key, title] of [['resources','Resources'],['timestamps','Chapters'],['seoContent','About this video'],['callToAction','Call to action'],['tags','Tags']]) {
      if (!data[key]?.length) continue;
      card(title, data[key], [key], c => {
        if (key === 'tags') { const chips = node('div', 'studio-tag-list'); data.tags.forEach((_, i) => edit(chips, ['tags', i], '', 'studio-tag')); c.append(chips); }
        else if (key === 'resources') data.resources.forEach((x, i) => { const resource = node('div', 'studio-resource'); edit(resource, ['resources',i,'name'], '', 'studio-resource-name'); edit(resource, ['resources',i,'description'], ''); edit(resource, ['resources',i,'url'], '', 'studio-resource-url'); c.append(resource); });
        else if (key === 'timestamps') data.timestamps.forEach((x, i) => { const row = node('div', 'studio-chapter-row'); edit(row, ['timestamps', i, 'time'], 'Time'); edit(row, ['timestamps', i, 'title'], 'Chapter'); c.append(row); });
        else fields(c, data[key], [key]);
      });
    }
  }
  if (mode === 'thumbnail') handled = list('thumbnailIdeas', 'Concept', (c, x, p) => { badge(c, x.thumbnailType); edit(c, [...p,'concept'], '', 'studio-title-text'); if (x.textOverlay?.text) edit(c, [...p,'textOverlay','text'], 'Thumbnail text', 'studio-thumbnail-text'); const rest = { ...x }; delete rest.concept; delete rest.thumbnailType; fields(c, rest, p); }, 'studio-thumbnail-card');
  if (mode === 'broll') handled = list('suggestions', 'Visual', (c, x, p) => { range(c, x); badge(c, x.type); edit(c, [...p,'suggestion'], '', 'studio-title-text'); edit(c, [...p,'description'], 'Visual direction'); edit(c, [...p,'searchTerm'], 'Search for'); edit(c, [...p,'exactText'], 'Text on screen'); }, 'studio-timeline-card');
  if (mode === 'sfx') handled = list('sfxCues', 'Sound cue', (c, x, p) => { range(c, x); badge(c, x.sfxType); badge(c, x.intensity); edit(c, [...p,'sfxName'], '', 'studio-title-text'); edit(c, [...p,'subtitle'], 'At this moment', 'studio-quote-text'); edit(c, [...p,'description'], 'Sound direction'); edit(c, [...p,'rationale'], 'Why it fits'); }, 'studio-timeline-card');
  if (mode === 'twitter') { handled = list('posts', 'Post', (c, x, p) => { badge(c, x.toneStyle); edit(c, typeof x === 'string' ? p : [...p, x.tweet !== undefined ? 'tweet' : 'content'], '', 'studio-body-text'); });
    if (data?.graphicsByType) { const details = node('details', 'studio-graphic-briefs'); details.append(node('summary', '', 'Graphic ideas for your posts')); for (const [key, item] of Object.entries(data.graphicsByType)) { const group = node('section', 'studio-result-card'); group.append(node('h3', '', label(key))); fields(group, item, ['graphicsByType', key]); details.append(group); } host.append(details); }
    if (data?.threadIdea) card('Thread idea', data.threadIdea, ['threadIdea'], c => edit(c, ['threadIdea'], ''));
  }
  if (mode === 'blog' && data?.blogPost) { handled = true; const b = data.blogPost;
    card('Article', b, ['blogPost'], c => { edit(c, ['blogPost','headline'], '', 'studio-article-headline'); edit(c, ['blogPost','metaDescription'], 'Meta description'); edit(c, ['blogPost','introduction'], '', 'studio-body-text'); });
    (b.sections || []).forEach((s, i) => card(`Section ${i + 1}`, s, ['blogPost','sections',i], c => { edit(c, ['blogPost','sections',i,'heading'], '', 'studio-title-text'); edit(c, ['blogPost','sections',i,'content'], '', 'studio-body-text'); (s.subSections || []).forEach((_, j) => { edit(c, ['blogPost','sections',i,'subSections',j,'heading'], '', 'studio-title-text'); edit(c, ['blogPost','sections',i,'subSections',j,'content'], '', 'studio-body-text'); }); }));
    for (const key of ['keyTakeaways','conclusion','seoKeywords','suggestedTags']) if (b[key]?.length) card(label(key), b[key], ['blogPost',key]);
  }
  if (!handled) { const c = node('section', 'studio-result-card'); const field = node('div', 'studio-editable studio-body-text', formatStudioResult(raw, mode)); field.contentEditable = 'plaintext-only'; field.setAttribute('role','textbox'); field.setAttribute('aria-label','Editable draft'); field.addEventListener('input', () => onChange(JSON.stringify({ draft: field.innerText }))); c.append(field); host.append(c); }
}
