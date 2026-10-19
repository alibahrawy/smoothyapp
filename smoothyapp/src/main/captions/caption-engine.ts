/** Backends the local Darija engine can report to the UI. */
export type CaptionBackend = 'metal' | 'cuda' | 'cpu';

/**
 * Pick the llama.cpp backend for this machine.
 *
 * macOS uses the Metal-capable build. Windows/Linux use CUDA when an NVIDIA GPU
 * is available; otherwise they use the CPU build. An explicit CPU preference
 * always wins.
 */
export function decideCaptionBackend(
  preference: 'auto' | 'cuda' | 'cpu',
  platform: NodeJS.Platform,
  hasCuda: boolean
): CaptionBackend {
  if (preference === 'cpu') return 'cpu';
  if (platform === 'darwin') return 'metal';
  return hasCuda ? 'cuda' : 'cpu';
}
