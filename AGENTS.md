# smoothyapp — Agent Notes

This is the **public release repo** for the SmoothyEdit desktop app
(`alibahrawy/smoothyapp`). Source of truth / monorepo lives at
`/Users/alibahrawy/Documents/Coding/smoothyedit`.

## Coordinated 1.5.0 release authorized — 2026-10-02

The user explicitly authorized pushing/releasing the app once its signed build
finishes, followed by publishing the security work previously held for 1.4.1.
The 2026-09-29 publication freeze is lifted for the coordinated **1.5.0** release.
Verify the final signed/notarized artifacts before publishing. The unreleased
version was renamed from 1.4.1 to 1.5.0 at the user's request on 2026-10-01.

An earlier unsigned dev build exists locally at
`smoothyapp/dist/mac-arm64/SmoothyEdit.app` — it has NOT been published, so
installed 1.4.0 users get no update.

Breaking changes that must ship together with the web deploy:
- Local Premiere bridge now binds `127.0.0.1` and requires a per-install token
  injected into the CEP panel (`smoothy-config.json`); `smoothyapp-cep/js/bridge.js`
  reads it.
- The website relay uses only the signed session token (no raw `x-member-id`,
  no `?userId=`).
- Premiere track names are HTML-escaped; whisper.cpp archives are SHA-256
  verified before extraction.

Deploy order (when the user says go): **publish desktop 1.5.0 first, then
deploy the web hardening in `smoothyedit/web`** (or set
`ALLOW_LEGACY_MEMBER_ID=true` on `smoothy-web` during the transition).

## Release notes

- Releases are built/published from this repo, not the monorepo.
- `npm run build:mac` / `npm run build:win`; publish with
  `electron-builder --publish always` then un-draft the GitHub release.
- A website changelog entry (`smoothyedit/web/src/content/changelog/`) is
  required for each release.
