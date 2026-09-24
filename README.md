# SmoothyApp

The SmoothyApp desktop app — AI-powered editing tools that run locally and send results straight into your NLE timeline.

## Layout

| Component | Path | Description |
| --- | --- | --- |
| Desktop app | `smoothyapp/` | Electron app (multicam, silence, captions, compressor) and plugin connection |
| Premiere Pro plugin (UXP) | `smoothyedit/` | Premiere Pro 26+ integration and timeline execution |
| Premiere Pro extension (CEP) | `smoothyapp-cep/` | Premiere Pro 25.x integration |

The desktop app bundles both plugins via electron-builder `extraResources`, so a single installer sets everything up.

## Development

```bash
cd smoothyapp
npm install
npm run dev
```

## Build

```bash
cd smoothyapp
npm run build:mac    # macOS (dmg)
npm run build:win    # Windows (nsis)
```

Releases are published to GitHub Releases for this repository.
