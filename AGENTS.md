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

**v1.5.0 is now published.** The Apple Silicon Mac app at
`smoothyapp/dist/mac-arm64/SmoothyEdit.app` is signed with Developer ID and
notarized; its DMG, ZIP update payload, blockmaps and manifest are live. A
Windows x64 1.5.0 installer and `latest.yml` were also added from the owner
account during the coordinated release. The website security changes are
deployed. Existing clients should update, restart Premiere, and sign in again.

### Next release: Assets telemetry

Source now records successful PNG exports and Premiere sends with anonymous
action names. The website admin counters are deployed; published 1.5.0 does
not report Assets activity. Include this change in the next planned release,
with a version bump and fresh Mac and Windows builds. The Mac artifacts must
be signed and notarized.
37 desktop regression tests pass, including success, cancel/failure, telemetry
opt-out and payload privacy checks. No new installer has been published for
this follow-up.

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
