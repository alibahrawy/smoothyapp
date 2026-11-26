# SmoothyApp (SmoothyEdit)

**Open-source desktop editing toolkit for Premiere Pro and DaVinci Resolve Free.** Switch multicam angles, cut silence, generate and edit multilingual & animated word-by-word captions, clean up audio, detect retakes, import SVGs and images, compress video, and connect AI agents to your edit from one desktop app. Core local tools run on your computer and stay free forever.

- **[Download Latest for Mac (Apple Silicon)](https://smoothyedit.com/api/download/mac)**
- **[Download Latest for Windows (x64)](https://smoothyedit.com/api/download/win)**
- **[Latest Release & Linux Builds (AppImage / .deb)](https://github.com/alibahrawy/smoothyapp/releases/latest)**
- **[Website & Docs](https://smoothyedit.com)** · **[Changelog](https://smoothyedit.com/changelog)**

> **Always get the latest version:** The download links above always point to the newest release. Installed builds include automatic updates so you stay on the latest version.

## What it does

| Tool | Workflow |
| --- | --- |
| **Multicam** | Follow the active speaker on a duplicate of your source or nested timeline. The main camera stays on top, with the enabled reverse footage underneath for fine-tuning; clip effects and continuous audio are retained. |
| **Silence removal & Retakes** | Detect quiet sections and repeated takes, and tighten your timeline with adjustable settings. |
| **Captions & Animated Word-by-Word Captions** | Transcribe a timeline or audio/video file locally with Whisper (including multilingual, Moroccan Darija, or custom GGML models). Export SRT/VTT or send animated word-by-word captions directly to Premiere Pro (Outline free; 4 customizable styles in Smoothy Pro). |
| **Audio Cleanup** | Split Speech and Music locally, enhance speech, listen with Solo/Mute, and save WAVs. Automatic GPU selection falls back to CPU. |
| **Assets & Compressor** | Convert SVGs and images to PNGs, remove backgrounds, upscale images, send stills to Premiere, and compress videos with hardware encoding. |
| **Stock Footage, SFX & Audio Library** | Search Commons, Internet Archive, NASA, Coverr, and Pixabay, use bundled SFX, and preview/save tracks from the Audio Library into Premiere. |
| **ShortsCuts & Agent Bridge** | Control Premiere shortcuts from your phone (6 keys free, unlimited in Pro) and connect MCP-compatible AI agents to your edit (Pro). |
| **Community & Studio** | Built-in Community chat and optional Studio cloud tools. |

Premiere Pro connects through the bundled **CEP extension**. The desktop app installs or refreshes the panel when it starts. Premiere Pro 25.x and 26+ are supported. DaVinci Resolve Free connects through local Lua helpers. Start **Workspace → Scripts → Smoothy Connector** once per session; see the [setup guide](https://smoothyedit.com/blog/smoothy-connector-resolve-free). Generated timelines carry cuts, source timing and selected audio channels, but do not copy grades, effects, fades, automation or mixer processing. Review the imported edit.

## Install

1. Download the installer for your platform from the links above.
2. Install and open SmoothyEdit. The Premiere panel is installed or refreshed automatically.
3. Open Premiere Pro and the **SmoothyEdit Bridge** panel, then work from your active sequence. Captions can also start from a local audio or video file.

The local tools do not require an account. Studio cloud features are optional.

After updating, restart Premiere and reopen its SmoothyEdit panel, then refresh the sequence in SmoothyEdit. For Multicam, start from your original timeline and review both speakers and audio sync before using the duplicate. The dismissible update notice includes Discord and social support links.

Audio Library favorites stay local. Optional anonymous archive favorite sharing can be switched off in Licenses & credits; no local file names or audio are shared.

## Repository layout

| Path | Contents |
| --- | --- |
| [`smoothyapp/`](smoothyapp/) | Electron desktop app and build configuration |
| [`smoothyapp-cep/`](smoothyapp-cep/) | Premiere Pro CEP panel and ExtendScript bridge |

## Development

```bash
cd smoothyapp
npm install
npm run dev
```

To make local installers on the matching platform:

```bash
cd smoothyapp
npm run build:mac  # macOS Apple Silicon DMG + ZIP update package; signing/notarization needs your own Apple credentials
npm run build:win  # Windows x64 installer
npm run build:linux  # Linux host only; native x64 or arm64 dependencies required
```

Build configuration is in [`smoothyapp/package.json`](smoothyapp/package.json). Published downloads and release notes are in [GitHub Releases](https://github.com/alibahrawy/smoothyapp/releases).

Stock footage source builds include Commons, Internet Archive and NASA without provider credentials. Pixabay requires your own compatible search service. Set `SMOOTHY_STOCK_SERVICE_URL` to its HTTPS endpoint when running `npm run build` or a platform build command. The service accepts `q`, `page` and `size` and returns video API metadata (`totalHits`, `hits`); keep your provider key on your server. Without a configured service, Pixabay is hidden. Provider keys and the official service configuration are not included in source builds.

A build can alternatively set `SMOOTHY_PIXABAY_API_KEY` to query the Pixabay API directly. The value is baked into that build only; put it in a gitignored `.env` or the environment, never in source. A configured service endpoint takes precedence over the key.

The desktop app is licensed under [MIT](smoothyapp/LICENSE).

## Open-source credits

Built with Electron, Whisper, FFmpeg, ONNX Runtime, PyTorch and many other projects. See the [open-source libraries, tools and models](docs/OPEN-SOURCE.md) and the [complete locked npm dependency inventory](docs/NPM-DEPENDENCIES.md). Thank you to their maintainers and contributors.
