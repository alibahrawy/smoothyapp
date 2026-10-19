# Open-source credits

SmoothyApp builds on the work of these projects and their contributors. This page covers the desktop app, its local processing engines and development tools. Versions and license labels below come from the checked-in lockfile and installed package metadata; each upstream project remains the source for its terms.

## Direct desktop libraries and build tools

| Project | Requested version | Use | License metadata |
| --- | --- | --- | --- |
| [@fugood/whisper.node](https://github.com/whisper-node/whisper.node) | `^1.0.15` | Whisper native Node bindings | MIT |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | `0.9.12` | Timeline XML parsing and serialization | MIT |
| [adm-zip](https://github.com/cthackers/adm-zip) | `0.5.16` | ZIP extraction | MIT |
| [electron-store](https://www.npmjs.com/package/electron-store) | `^8.1.0` | Local preferences | MIT |
| [electron-updater](https://github.com/electron-userland/electron-builder) | `^6.7.3` | Desktop updates | MIT |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | `^5.3.0` | Bundled FFmpeg media processing | GPL-3.0-or-later |
| [ffprobe-static](https://github.com/joshwnj/ffprobe-static) | `^3.1.0` | Bundled media inspection | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | `1.13.0` | Word document text extraction | BSD-2-Clause |
| [onnxruntime-node](https://github.com/Microsoft/onnxruntime) | `1.23.2` | Local image model inference | MIT |
| [sharp](https://github.com/lovell/sharp) | `0.34.5` | Image processing | Apache-2.0 |
| [unpdf](https://github.com/unjs/unpdf) | `1.8.1` | PDF text extraction | MIT |
| [ws](https://github.com/websockets/ws) | `^8.14.2` | WebSocket connections | MIT |
| [electron](https://github.com/electron/electron) | `^41.1.0` | Desktop runtime (Chromium and Node.js) | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | `^24.9.1` | Installer packaging | MIT |
| [electron-icon-builder](https://github.com/safu9/electron-icon-builder) | `^2.0.1` | App icon generation | MIT |
| [electron-vite](https://github.com/alex8088/electron-vite) | `^2.0.0` | Electron build tooling | MIT |
| [fengari](https://github.com/fengari-lua/fengari) | `0.1.5` | Lua connector test execution | MIT |
| [vite](https://github.com/vitejs/vite) | `^5.0.0` | JavaScript bundling and development server | MIT |

## Local engines and models

| Project | Role / source |
| --- | --- |
| [Whisper](https://github.com/openai/whisper) | Multilingual speech recognition models. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Local transcription engine; [binary distribution used by the app](https://github.com/sjoerdteunisse/whisper.cpp). |
| [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | Audio Cleanup separation engine, pinned to 0.30.2. |
| [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) | Audio model ecosystem used through audio-separator: `UVR-MDX-NET-Inst_HQ_3.onnx` and `UVR-DeNoise-Lite.pth`. Refer to each model distributor for model-specific terms. |
| [PyTorch](https://github.com/pytorch/pytorch), [torchaudio](https://github.com/pytorch/audio), [torchvision](https://github.com/pytorch/vision) | Local audio model runtime; selected packages depend on hardware. |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Node image inference and Python CPU, CUDA, DirectML or CoreML providers. |
| [DirectML / PyTorch integration](https://github.com/microsoft/DirectML) | Optional Windows AMD/Intel acceleration. |
| [librosa](https://github.com/librosa/librosa) | Audio processing, pinned to 0.10.2.post1. |
| [Python](https://github.com/python/cpython), [pip](https://github.com/pypa/pip), [uv](https://github.com/astral-sh/uv) | Local audio engine environment and package setup; availability depends on the user installation. |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | Background removal using the official general v1 ONNX model. |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | Local x4 image upscaling. |
| [Qualcomm Real-ESRGAN export](https://huggingface.co/qualcomm/Real-ESRGAN-x4plus) | ONNX export v0.63.0 used by the app. |
| [FFmpeg / FFprobe](https://ffmpeg.org/) | Local decoding, encoding and media inspection. Binary build terms depend on enabled components; see [FFmpeg legal information](https://ffmpeg.org/legal.html). |

The image-model copyright and license notices are retained in [local-image-models-LICENSES.txt](../smoothyapp/build/local-image-models-LICENSES.txt). Models and Python engines are downloaded during setup rather than all being bundled in the installer.

## Icons and other assets

- [Lucide](https://github.com/lucide-icons/lucide): editing interface icons.
- [Editor logo sources and attribution](../smoothyapp/src/renderer/editor-logos/SOURCES.json).
- [Provider logo sources](../smoothyapp/src/renderer/model-logos/SOURCES.json). Logos remain their owners’ trademarks.
- The renderer uses bundled Bunch fonts and references Montserrat and Caveat through Google Fonts. Font inclusion does not establish that every font is open source; retain the applicable font permissions.

## Services and editor integrations

Premiere Pro, DaVinci Resolve, cloud AI providers, Pixabay and other media libraries are separate products or services. Their integration does not make their software, models or media open source. Stock media licensing is specific to each item and source.

## Complete locked npm dependency inventory

See [NPM-DEPENDENCIES.md](NPM-DEPENDENCIES.md) for direct and transitive desktop packages, including build-only and platform-specific dependencies. The authoritative resolved tree is [package-lock.json](../smoothyapp/package-lock.json). This credits page supplements the upstream notices; it does not replace them.
