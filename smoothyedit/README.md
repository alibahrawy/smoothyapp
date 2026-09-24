# SmoothyEdit Premiere Pro UXP Bridge

This is the modern Premiere Pro bridge for SmoothyEdit. It replaces the old CEP panel for Premiere Pro versions where CEP is unavailable or disabled.

## Requirements

- Premiere Pro 25.2 or newer (25.6+ for direct transcripts and vertical assembly)
- UXP Developer Tool 2.1 or newer
- SmoothyEdit desktop app running. The bridge tries the new app on `ws://localhost:3457`, then the released app on `ws://localhost:3456`.

## Development Load

The SmoothyEdit desktop app can install this bridge from **Settings > Premiere Pro Bridge > Install UXP Bridge**. That copies the plugin into Adobe's local UXP folder:

`~/Library/Application Support/Adobe/UXP/Plugins/External/com.smoothyedit.uxp.bridge_1.0.0`

If you are actively editing plugin files, use the UXP Developer Tool instead:

1. Open Premiere Pro.
2. Open Adobe UXP Developer Tool.
3. Add this plugin by selecting `manifest.json` in this folder.
4. Click **Load** or **Load & Watch**.
5. Open **Plugins > Development > SmoothyEdit Bridge** or the matching UXP panel entry in Premiere.

## Notes

The Electron app protocol is intentionally unchanged. The UXP plugin still sends `pluginConnected`, `sequenceInfo`, `xmlImported`, `markersAdded`, and related response messages over the local WebSocket.

Some legacy CEP features used ExtendScript or QE DOM APIs that Premiere UXP does not currently expose. Those actions return explicit unsupported responses instead of silently failing:

- In-place silence ripple extraction
- Audio export through Adobe Media Encoder
- Caption text import where the host API is unavailable

Premiere Pro 25.6+ can read existing clip transcripts directly and can build a new vertical shorts assembly from selected ranges. The source sequence is not cut or overwritten.

The XML-based workflows remain the recommended fallback for timeline changes that are not yet available in UXP.
