export function initStockFootage({ isConnected }) {
  const api = window.electronAPI;
  const el = id => document.getElementById('stock-' + id);
  const sources = {
    all: { name: 'All sources', note: 'Search Commons, Internet Archive, and NASA together. Check each clip’s usage terms. Quality and orientation filters require known dimensions.' },
    pixabay: { name: 'Pixabay', url: 'https://pixabay.com', note: 'Videos under the Pixabay Content License. Check each clip’s source and usage terms.' },
    commons: { name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org', note: 'CC0 and public-domain videos. No API key needed. Check each source page for rights that depend on your use.' },
    archive: { name: 'Internet Archive', url: 'https://archive.org/details/stock_footage', note: 'Stock footage and Prelinger historical films with publisher-declared CC0 or public-domain terms. No API key needed. Check the source credits.' },
    nasa: { name: 'NASA', url: 'https://images.nasa.gov', note: 'Earth, space, and science videos. No API key needed. Acknowledge NASA and follow its media guidelines. MP4 variants may have unspecified dimensions.' }
  };
  const data = { searching: false, downloading: false, importing: false, pixabayEnabled: false, videos: [], selected: null, page: 0, cursor: 0, sourceCursors: undefined, more: false, search: null };
  function message(id, text, error = false) { el(id).textContent = text; el(id).classList.toggle('stock-error', error); }
  function update() {
    el('search-btn').disabled = data.searching;
    el('search-btn').textContent = data.searching ? 'Searching…' : 'Search';
    el('provider').disabled = data.searching || data.downloading;
    el('size').disabled = el('provider').value === 'nasa';
    el('load-more').disabled = data.searching;
    el('load-more').textContent = data.searching ? 'Loading…' : 'Load more videos';
    el('load-more').classList.toggle('hidden', !data.more);
    el('download-btn').disabled = !data.selected || data.downloading;
    el('premiere-btn').disabled = !data.selected || data.downloading || !isConnected();
    el('resolution').disabled = data.downloading;
    el('close-preview').disabled = data.downloading;
    el('results').querySelectorAll('.stock-thumbnail').forEach(button => { button.disabled = data.downloading; });
    el('change-folder').disabled = data.downloading;
    el('cancel-btn').classList.toggle('hidden', !data.downloading || data.importing);
    message('premiere-note', isConnected() ? 'Send to Premiere imports the MP4 into your Project panel. Drag it onto your timeline.' : 'Connect Premiere to import the video into your Project panel.');
  }
  function refreshSource() {
    sources.all.note = `Search ${data.pixabayEnabled ? 'Pixabay, ' : ''}Commons, Internet Archive, and NASA together. Check each clip’s usage terms. Quality and orientation filters require known dimensions.`;
    const source = sources[el('provider').value];
    el('powered').classList.toggle('hidden', !source.url);
    if (source.url) el('powered').href = source.url;
    el('source-name').textContent = source.name + ' ↗';
    el('source-status').textContent = 'Stock Footage · ' + source.name;
    el('source-note').textContent = source.note;
  }
  const duration = seconds => seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : 'Duration unavailable';
  const version = file => file.width && file.height ? `${file.width} × ${file.height}${file.fps ? ' · ' + file.fps + ' fps' : ''}` : file.label || 'MP4 · Dimensions unavailable';
  function setPreviewRatio(width, height) {
    const player = el('preview-video');
    if (width > 0 && height > 0) player.style.setProperty('--stock-preview-ratio', String(width / height));
    else player.style.removeProperty('--stock-preview-ratio');
  }
  function closePreview() {
    el('preview-video').pause(); el('preview-video').removeAttribute('src'); el('preview-video').load();
    setPreviewRatio(0, 0);
    el('preview').classList.add('hidden'); data.selected = null; update();
  }
  function preview(video) {
    if (data.downloading) return;
    previewTracked = false;
    data.selected = video;
    el('preview-title').textContent = `${video.title} · ${duration(video.duration)}`;
    el('preview-credit').textContent = `${sources[video.provider || 'commons'].name} · ${video.license} · ${video.creator} · View source ↗`;
    el('preview-credit').href = video.url;
    el('preview-usage').textContent = video.usage || 'Check the source page for other rights relevant to your use.';
    el('preview-license').href = video.licenseUrl || video.url;
    const options = video.files.map(file => {
      const option = document.createElement('option'); option.value = file.id;
      option.textContent = version(file); return option;
    });
    el('resolution').replaceChildren(...options);
    const defaultFile = (video.provider === 'nasa' && video.files.find(file => file.label === 'Medium MP4')) || video.files.find(file => file.width * file.height <= 1920 * 1080) || video.files.at(-1);
    el('resolution').value = defaultFile.id;
    // Preview a small version; download resolution is independent.
    const previewFile = (video.provider === 'nasa' && video.files.find(file => file.label === 'Small MP4')) || video.files.find(file => file.width * file.height <= 1280 * 720) || video.files.at(-1);
    setPreviewRatio(previewFile.width, previewFile.height);
    el('preview-video').poster = video.image;
    el('preview-video').src = previewFile.link;
    el('preview').classList.remove('hidden');
    document.querySelectorAll('.stock-result').forEach(card => card.classList.toggle('selected', card.dataset.videoId === String(video.id)));
    el('preview').scrollIntoView({ behavior: 'instant', block: 'start' }); update();
  }
  function renderResults() {
    el('results').replaceChildren(...data.videos.map(video => {
      const card = document.createElement('article'); card.className = 'stock-result'; card.dataset.videoId = video.id;
      card.classList.toggle('selected', data.selected?.id === video.id);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'stock-thumbnail';
      button.setAttribute('aria-label', `Preview video by ${video.creator}, ${duration(video.duration)}`);
      const img = document.createElement('img'); img.src = video.image; img.alt = `Stock footage by ${video.creator}`; img.loading = 'lazy';
      const play = document.createElement('span'); play.className = 'stock-play'; play.textContent = '▶'; play.setAttribute('aria-hidden', 'true');
      const time = document.createElement('span'); time.className = 'stock-duration'; time.textContent = duration(video.duration);
      button.append(img, play, time); button.addEventListener('click', () => preview(video));
      const info = document.createElement('div'); info.className = 'stock-result-info';
      const credit = document.createElement('a'); credit.className = 'link'; credit.href = video.url; credit.dataset.stockExternal = '';
      credit.textContent = `${video.title} ↗`;
      const size = document.createElement('span'); size.textContent = `${sources[video.provider || 'commons'].name} · ${video.license} · ${version(video.files[0])}`;
      info.append(credit, size); card.append(button, info); return card;
    }));
  }
  async function search(append = false) {
    if (data.searching) return;
    const input = append ? { ...data.search, page: data.page + 1, cursor: data.cursor, sourceCursors: data.sourceCursors } : { query: el('query').value.trim(), provider: el('provider').value, orientation: el('orientation').value, size: el('size').value, page: 1 };
    if (!input.query) return;
    data.searching = true; update(); message('search-status', `Searching ${sources[input.provider].name} for “${input.query}”…`);
    try {
      const result = await api.stockSearch(input);
      if (result.canceled) return;
      if (!result.success) throw new Error(result.error);
      if (!append && !data.downloading) closePreview();
      data.videos = append ? [...data.videos, ...result.videos.filter(video => !data.videos.some(old => old.id === video.id))] : result.videos;
      data.search = input; data.page = result.page; data.cursor = result.nextOffset; data.sourceCursors = result.sourceCursors; data.more = result.hasMore;
      renderResults();
      const status = data.videos.length ? `${data.videos.length} videos from ${sources[input.provider].name} for “${input.query}” · Select a shot to preview` : `No ${['all', 'pixabay'].includes(input.provider) ? 'matching' : input.provider === 'nasa' ? 'NASA' : 'CC0 or public-domain'} videos found in this batch for “${input.query}”. Try another search or fewer filters.`;
      message('search-status', status + (result.warning ? ' ' + result.warning : ''));
    } catch (error) { message('search-status', error.message || 'Search failed. Please retry.', true); }
    finally { data.searching = false; update(); }
  }
  async function download(premiere) {
    if (!data.selected || data.downloading || (premiere && !isConnected())) return;
    data.downloading = true; data.importing = false; el('cancel-btn').disabled = false;
    const video = data.selected;
    message('action-status', 'Downloading MP4…'); update();
    try {
      const result = await api.stockDownload({ videoId: video.id, fileId: Number(el('resolution').value), premiere });
      if (result.canceled) { message('action-status', 'Download canceled.'); return; }
      if (!result.success) throw new Error(result.error + (result.path ? ` The MP4 is saved at ${result.path}.` : ''));
      message('action-status', result.imported ? `Imported into Premiere’s Project panel. Saved at ${result.path}` : `MP4 saved at ${result.path}`);
    } catch (error) { message('action-status', error.message || 'Download failed. Please retry.', true); }
    finally { data.downloading = false; data.importing = false; update(); }
  }
  el('search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
  el('provider').addEventListener('change', () => {
    refreshSource();
    const source = sources[el('provider').value];
    if (el('provider').value === 'nasa') el('size').value = '';
    closePreview(); data.videos = []; data.more = false; data.search = null; data.sourceCursors = undefined; renderResults(); update();
    message('search-status', 'Search ' + source.name + ' for a subject or place.');
    if (el('query').value.trim()) search();
  });
  el('load-more').addEventListener('click', () => search(true));
  el('download-btn').addEventListener('click', () => download(false));
  el('premiere-btn').addEventListener('click', () => download(true));
  el('close-preview').addEventListener('click', () => { if (!data.downloading) { closePreview(); renderResults(); } });
  el('cancel-btn').addEventListener('click', async () => {
    el('cancel-btn').disabled = true; message('action-status', 'Canceling download…');
    try { await api.stockCancelDownload(); } catch { el('cancel-btn').disabled = false; }
  });
  el('change-folder').addEventListener('click', async () => {
    try { const result = await api.stockSelectFolder(); if (result.success) { el('folder-path').textContent = result.folder; el('folder-path').title = result.folder; } }
    catch { message('action-status', 'Could not select a folder. Please retry.', true); }
  });
  document.getElementById('tab-stock').addEventListener('click', event => {
    const link = event.target.closest('a[data-stock-external]');
    if (link) { event.preventDefault(); api.openExternal(link.href); }
  });
  document.querySelectorAll('.nav-item').forEach(nav => nav.addEventListener('click', () => { if (nav.dataset.tab !== 'stock') el('preview-video').pause(); }));
  let previewTracked = false;
  el('preview-video').addEventListener('loadedmetadata', () => {
    const player = el('preview-video');
    if (data.selected) setPreviewRatio(player.videoWidth, player.videoHeight);
  });
  el('preview-video').addEventListener('playing', () => {
    if (data.selected && !previewTracked) { previewTracked = true; void api.trackMediaPreview('stock'); }
  });
  el('preview-video').addEventListener('error', () => { if (data.selected) message('action-status', 'Preview could not play. You can still download the MP4 or view it on the source page.', true); });
  api.onConnectionChange(update);
  api.onStockDownloadProgress(progress => {
    if (!data.downloading) return;
    data.importing = Boolean(progress.importing);
    message('action-status', progress.phase === 'converting' ? 'Converting to Premiere-ready MP4…' : progress.importing ? 'Importing into Premiere’s Project panel…' : progress.total ? `Downloading MP4… ${Math.min(100, Math.round(progress.received / progress.total * 100))}%` : `Downloading MP4… ${(progress.received / 1048576).toFixed(1)} MB`); update();
  });
  api.stockGetSettings().then(settings => {
    data.pixabayEnabled = Boolean(settings.pixabayEnabled);
    el('provider').querySelector('[value="pixabay"]').hidden = !data.pixabayEnabled;
    refreshSource();
    el('folder-path').textContent = settings.folder; el('folder-path').title = settings.folder;
    message('search-status', 'Search for a subject, place, or mood to find your next shot.'); update();
  }).catch(() => message('action-status', 'Could not load download settings. Restart the app and retry.', true));
  update();
  return { isBusy: () => data.downloading || data.importing };
}
