export type AudioBackend = 'cpu' | 'cuda' | 'directml' | 'mps';
export type AudioGPU = { vendorId?: number; deviceId?: number };
export const AUDIO_RUNTIME_VERSION = 2;
export function audioBackend(platform: string, arch: string, devices: AudioGPU[] = []): AudioBackend {
  if (platform === 'darwin') return arch === 'arm64' ? 'mps' : 'cpu';
  if (devices.some(device => device.vendorId === 0x10de)) return 'cuda';
  if (platform === 'win32' && devices.some(device => device.vendorId === 0x1002 || device.vendorId === 0x8086)) return 'directml';
  return 'cpu';
}
export function audioPackages(backend: AudioBackend, platform: string) {
  // DirectML's published wheel requires the matching PyTorch 2.4 family.
  const torch = backend === 'directml' ? ['torch==2.4.1','torchaudio==2.4.1','torchvision==0.19.1'] : backend === 'cuda' ? ['torch==2.5.1+cu124','torchaudio==2.5.1+cu124','torchvision==0.20.1+cu124'] : ['torch==2.5.1','torchaudio==2.5.1','torchvision==0.20.1'];
  const index = backend === 'cuda' ? 'https://download.pytorch.org/whl/cu124' : platform === 'darwin' ? null : 'https://download.pytorch.org/whl/cpu';
  const onnx = backend === 'cuda' ? 'onnxruntime-gpu==1.20.2' : backend === 'directml' ? 'onnxruntime-directml==1.20.1' : 'onnxruntime==1.20.1';
  return { torch, index, onnx, extra: backend === 'directml' ? ['torch-directml==0.2.5.dev240914'] : [] };
}
