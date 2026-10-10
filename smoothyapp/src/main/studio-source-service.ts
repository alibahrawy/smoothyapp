/** Local input preparation only: no AI provider request or credit charge. */
export function createStudioSourceService(deps: {
  owner: () => string | null; enabled: () => boolean; busy: () => boolean;
  pickTranscript: () => Promise<string | null>;
  readTranscript: (file: string) => Promise<{ subtitleText: string; fileName: string }>;
  prepareAudio: (input: any, signal: AbortSignal) => Promise<{ subtitleText: string; fileName: string; duration?: number }>;
  stopAudio: () => Promise<void>; track: (id: string) => void;
}) {
  let controller: AbortController | null = null, usesAudio = false;
  const cancel = () => { controller?.abort(); if (usesAudio) void deps.stopAudio().catch(() => {}); };
  async function importSource(input: any) {
    if (!deps.enabled()) throw new Error('Studio AI is turned off in Settings.');
    const owner = deps.owner(); if (!owner) throw new Error('Sign in to use Studio.');
    if (!input || !['transcript', 'sequence', 'audio'].includes(input.source)) throw new Error('Choose subtitles, a Premiere sequence or a media file.');
    if (controller || deps.busy()) throw new Error('Wait for the current transcription or analysis to finish.');
    const job = new AbortController(); controller = job; usesAudio = input.source !== 'transcript';
    const check = () => { if (job.signal.aborted || owner !== deps.owner() || !deps.enabled()) throw new Error('Source import canceled.'); };
    try {
      let result;
      if (input.source === 'transcript') {
        const file = await deps.pickTranscript(); check(); if (!file) return { canceled: true };
        result = await deps.readTranscript(file);
      } else result = await deps.prepareAudio(input, job.signal);
      check();
      if (typeof result.subtitleText !== 'string' || !result.subtitleText.trim()) throw new Error('No speech or subtitles found in this source.');
      if (result.subtitleText.length > 2_000_000) throw new Error('The subtitles are too long (maximum 2,000,000 characters).');
      try { deps.track('studio_transcript_import'); } catch { /* Analytics never blocks an import. */ }
      return { ...result, canceled: false };
    } finally { controller = null; usesAudio = false; }
  }
  return { importSource, cancel, isBusy: () => Boolean(controller) };
}
