import catalog from '../shared/studio-catalog.json';

export const studioModes = catalog.map(tool => tool.id);
export const studioProModes = ['thumbnail', 'broll', 'twitter', 'blog', 'sfx'];
export function validateStudioInput(input: any) {
  if (!input || !studioModes.includes(input.mode)) throw new Error('Choose a supported Studio tool.');
  if (typeof input.subtitleText !== 'string' || !input.subtitleText.trim()) throw new Error('Upload subtitles, choose media, or read your Premiere sequence.');
  if (input.subtitleText.length > 2_000_000) throw new Error('The subtitles are too long (maximum 2,000,000 characters).');
  if (input.duration !== undefined && (!Number.isFinite(input.duration) || input.duration <= 0)) throw new Error('Enter a positive source duration.');
  const body: any = { subtitleText: input.subtitleText, analysisMode: input.mode };
  if (input.duration !== undefined) body.duration = input.duration;
  if (input.mode === 'broll') {
    if (typeof input.videoType !== 'string' || !input.videoType.trim() || input.videoType.length > 200) throw new Error('Choose a video type for B-roll ideas.');
    if (!Array.isArray(input.brollCategories) || !input.brollCategories.length || input.brollCategories.length > 20 || input.brollCategories.some((value: any) => typeof value !== 'string' || !value.trim() || value.length > 80)) throw new Error('Choose at least one B-roll category.');
    body.videoType = input.videoType; body.brollCategories = input.brollCategories;
  }
  return body;
}

/** Serialized native cloud jobs. Drop responses when account/AI preferences change. */
export function createStudioService(deps: {
  owner: () => string | null; enabled: () => boolean;
  request: (route: string, body: any, signal: AbortSignal) => Promise<string>;
  saveHistory: (mode: string, result: string, fileName: string) => Promise<void>;
  verifyAccess: (mode: string) => Promise<void>;
  track: (id: string) => void;
}) {
  let controller: AbortController | null = null, epoch = 0;
  const cancel = () => { epoch++; controller?.abort(); };
  const run = async (input: any) => {
    if (!deps.enabled()) throw new Error('Studio AI is turned off. Enable it in Settings.');
    const owner = deps.owner(); if (!owner) throw new Error('Sign in to use Studio tools.');
    if (controller) throw new Error('Wait for the current Studio tool to finish.');
    const body = validateStudioInput(input);
    const refining = input.followUp !== undefined;
    if (refining && (typeof input.followUp !== 'string' || !input.followUp.trim() || input.followUp.length > 10000 || typeof input.currentResult !== 'string' || !input.currentResult.trim() || input.currentResult.length > 2_000_000)) throw new Error('Add a refinement request and an existing result.');
    const signal = (controller = new AbortController()).signal, stamp = epoch;
    try {
      await deps.verifyAccess(input.mode);
      if (signal.aborted || stamp !== epoch || deps.owner() !== owner || !deps.enabled()) throw new Error('Studio request canceled.');
      const raw = await deps.request(refining ? '/api/follow-up' : '/api/analyze', refining ? { currentResult: input.currentResult, followUpPrompt: input.followUp, mode: input.mode, subtitleContent: input.subtitleText } : body, signal);
      if (signal.aborted || stamp !== epoch || deps.owner() !== owner || !deps.enabled()) throw new Error('Studio request canceled.');
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 2_000_000) throw new Error('No usable result was returned. Try again.');
      const fileName = typeof input.fileName === 'string' ? input.fileName.slice(0, 200) : 'Subtitles';
      deps.track(refining ? 'studio_refine' : `studio_${input.mode}`);
      let warning = '';
      try { await deps.saveHistory(input.mode, raw, fileName); } catch { warning = 'Result ready. Shared history could not be saved; copy or save this draft.'; }
      if (stamp !== epoch || deps.owner() !== owner || !deps.enabled()) throw new Error('Studio request canceled.');
      return { raw, mode: input.mode, fileName, warning };
    } finally { controller = null; }
  };
  return { run, cancel };
}
