# smoothyapp — Agent Notes

This is the **public release repo** for the SmoothyEdit desktop app
(`alibahrawy/smoothyapp`). Source of truth / monorepo lives at
`/Users/alibahrawy/Documents/Coding/smoothyedit`.

## SmoothyApp 2.0.0 Mac release authorized — 2026-10-10

The owner requested **"Push the new mac app v2"** and **"push the new site"**. This authorizes committing/pushing the accumulated desktop v2 and website work, publishing the signed/notarized **Mac 2.0.0** artifacts, and deploying the website. The signed/notarized Mac 2.0.0 build (CEP 1.5.13) is published to the **v2.0.0** release; the verified Windows 1.5.2 installer, blockmap and `latest.yml` are carried into that release so Windows downloads and updates keep working. The mandatory v2 website changelog is added in the monorepo (`web/src/content/changelog/2026-10-10-smoothyapp-v2.mdx`). Preserve the Windows direct-Pixabay key path and keep provider credentials server-side.

## Mandatory feature usage tracking — 2026-10-05

The user requires usage counts for **every existing and future feature, free and paid**, like Multicam. Treat tracking as part of completing a feature, including desktop tools and Studio features. Use stable feature/action IDs, update `/Users/alibahrawy/Documents/Coding/smoothyedit/web/src/lib/feature-catalog.ts`, and expose the counts in the private Admin → Usage table. Include meaningful exports/imports/saves and previews; do not count navigation, preference reads, polling, or internal provider passes as feature runs.

Desktop tracking belongs at the main-process operation boundary, with playback starts reported once per media selection. Respect `SMOOTHY_TELEMETRY=0`; collect no content, search text, file paths or account details, and never let analytics block a tool. Studio tracking uses the server-verified plan at request time, with separate Free/Paid/Anonymous counts and one event per accepted request even for multi-pass AI. Document whether a metric counts a started run or a successful action; canceled/failed saves and imports must not count as successful actions. Do not invent historical activity for newly instrumented features.

Before completing a new feature, verify its real success/start path, cancellation/failure path and admin aggregation as applicable. Add its measurement definition to [`docs/FEATURE-USAGE.md`](/Users/alibahrawy/Documents/Coding/smoothyedit/docs/FEATURE-USAGE.md). Keep tracking independent of credit billing. Existing local-only/publication restrictions still apply: **desktop v2 is local only; do not commit, push or publish the app without a new instruction.**

## Windows 1.5.2 Pixabay fix published — 2026-10-05

The owner reported Pixabay missing from the shipped Windows build and supplied a
Pixabay API key, authorizing a **Windows-only 1.5.2** update. The Windows 1.5.1
installer was built without `SMOOTHY_STOCK_SERVICE_URL`, so `stockServiceURL()`
resolved to `""` and Pixabay stayed hidden. Builds may now instead inject
`SMOOTHY_PIXABAY_API_KEY` (via environment or a gitignored `.env`) to query the
Pixabay API directly; a configured service endpoint still takes precedence. The
key is deliberately **not** committed to this public repo and is absent from
source, Git history and `package.json`. `electron.vite.config.js` loads the key
through `loadEnv`, and `stock-footage-pixabay.ts` sends `key` + `per_page=12`.
Live direct search returned 12 normalized clips; malformed/missing keys keep
Pixabay hidden and a service endpoint overrides the key. Version bumped to
**1.5.2** (`package.json`, `package-lock.json`); the CEP extension is unchanged
at 1.5.13. A Windows x64 installer, blockmap and `latest.yml` were published to
the **v1.5.2** GitHub release; the signed/notarized Mac 1.5.1 DMG/ZIP and
`latest-mac.yml` were carried into that release so Mac downloads and updates
keep working. The required website changelog entry still needs to be added in
the monorepo (`smoothyedit/web/src/content/changelog/`).

## 1.5.1 app and website publication authorized — 2026-10-04

The user explicitly requested: **“push everything the app and the website”** and will build Windows afterward. This authorizes committing/pushing the accumulated app/web work, publishing the verified signed/notarized **Mac 1.5.1** artifacts, then deploying the website. Earlier local-only/do-not-push notes below are historical and superseded for this release. Preserve the verified **Windows 1.5.0** installer, blockmap and `latest.yml` in the new release until the owner supplies Windows 1.5.1; do not label the existing Windows binary 1.5.1. Preserve the shared-stock build configuration and keep provider credentials server-side. Add the mandatory 1.5.1 website changelog and verify public download/update routes after publication.

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

### Local 1.5.1 visible/selectable reverse camera fix — 2026-10-04

Public temporal clip moves left lower-track camera pieces invisible/unselectable even though their DOM coverage passed. Replace temporal parking with an appended video-only track and same-time video swaps, then remove only our empty temporary track. Resolve fresh QE handles after moves; preserve stranded footage on failure. Winner/reverse remain enabled, with original clip effects, continuous audio and user track structure.

Native Premiere duplicates of the user-authorized **Testing** sequence pass **53 actual decision ranges / 106 pieces / 99,834 frames on both tracks**, original/audio/effect/keyframe/timecode preservation and five video/four audio track restoration. Computer Use confirms formerly missing lower footage is visible and clickable, with native selection readback. The original second nest's four-frame-shorter tail is retained. Clean **Testing - Auto-Switch - reverse verified** is open. Both builds/**136 tests per checkout**/**35 Multicam tests** and packaged renderer checks pass. Current open unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-multicam-reverse/mac-arm64/SmoothyEdit.app`; 14 built/nine bundled/eight installed CEP files and 80 source mirrors verified, shared stock service retained. CEP **1.5.13**, protocol **2**, host `20261004-multicam-reverse-track-v32`, capability **7**; native installed bridge pipeline passes. This supersedes the v31 build's data-only visual verification. Previous builds and concurrent Community/site changes preserved. No commit, push, release or website deployment. Details/proof are in the monorepo status/review.

### Local 1.5.1 Multicam linked-audio fix — 2026-10-04

The latest guard caught real Premiere corruption: video-track ProjectItem overwrites inserted camera audio into A1. Multicam now unlinks selected video only on the working duplicate, razors it, and swaps existing native video TrackItems using temporary parking beyond the tail. The chosen camera stays on top with the reverse underneath and both enabled. This preserves direct clip effects/keyframes as well as nests; the earlier direct-effect limitation is resolved. ProjectItem trims/audio are never rebuilt. Final auditing verifies every expected camera piece/count/source/trim/speed; audio fingerprinting excludes video-dependent sequence duration. Existing captured-job/original-protection behavior remains.

**Native Premiere tests pass** on the user's nested interview (24fps, 4,159.75s), including 100 camera switches / 102 ranges, unchanged A1/A2 with one clip each, no disabled clips, preserved distinct Motion values/Opacity keyframes, unchanged original/duration and restored timecode. Independently checked all 99,834 frames on both camera tracks. Clearly named verification duplicates remain for inspection. Both builds and **133 tests per checkout**, including **32 Multicam tests**, pass, with native renderer/package checks. Current local unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-multicam-video-fix-v31/mac-arm64/SmoothyEdit.app`; all 14 built files/nine CEP files/80 source mirrors verified. CEP **1.5.12**, protocol **2**, host `20261004-multicam-video-moves-v31`, capability **6**; the HTML script cache query matches the new host version. Refresh and final cut commands load the current host in the same eval call, avoiding Premiere restoring a cached manifest script between calls. The native bridge preparation/cuts/cleanup path passes with capability 6 and unchanged audio/original. The verified app is open on port 3456; installed panel files match and the connected panel has been reloaded, with original Testing selected. Shared stock service retained. No commit, push, release or website deployment; previous/signed 1.5.0 builds remain. See monorepo status/review/native proof. Earlier sections below are historical.

### Local 1.5.1 Multicam session update — 2026-10-03

The user confirmed the earlier Multicam fix worked, then reported an active-sequence error after switching/touching a timeline during analysis. Preparation now resolves the captured source ID and validates its revision before cloning; exports/cuts validate and use the working duplicate regardless of the active tab or later top-level edits to the original. Exports restore the previously viewed sequence. A changed/closed duplicate still rejects edits. Shared nest internals remain references. The other model's enabled top-camera/reverse-angle layout is retained; its ProjectItem overwrites lose effects applied directly to relocated clips, a known release limitation reported to the user.

Both builds and **127 tests per checkout**, including **26 Multicam tests**, pass. Native renderer fixtures pass the updated source/nested notice, saved dismissal/reload/package persistence, independent result warnings and Mac/Windows layouts. Opened local unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-multicam-session/mac-arm64/SmoothyEdit.app`. **14 built files**, **nine CEP files**, **80 source/test/script mirrors** verified. CEP **1.5.10**, protocol **2**, host `20261003-multicam-session-v29`, capability **5**. Restart Premiere/reopen the panel before retrying; actual APIs are simulated in tests. The shared Pixabay endpoint is restored in this build.

The user separately requested a matching website notice: it and its changelog are deployed as **`049bab93-16d6-4933-b332-71572637a01f`**. Public copy says 1.5.1 is being tested and downloads remain 1.5.0; live dismissal/reload/page checks and Mac/Windows 1.5.0 range downloads pass. The other model's local 1.4.0 download pins were removed by restoring latest-release resolvers. No desktop release, commit or push. Earlier packages and signed 1.5.0 are preserved. See the monorepo's project status and Multicam review for current verification.

### Local 1.5.1 Audio Library update — 2026-10-03

**Latest favorite scroll fix:** Music and Saved MP3s update stars, community counts and Staff pick badges in place, retaining scroll and focus. Favorites/Staff picks membership refreshes preserve loaded pages and reuse surviving rows. Both builds and full native renderer checks pass, including bottom-row star/unstar, background community changes, paginated Favorites removal and saved-star focus. Community data is simulated in the regression; no real votes changed. New unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-audio-favorite-scroll/mac-arm64/SmoothyEdit.app`; 14 built files and nine CEP files match. Opened its real Music library for the user. Prior builds remain. No commit, push, release or web deployment.

**Latest license/sharing preview:** A compact **Licenses & credits** link opens a native dialog with current-track source/license, saved CC BY attribution copying, the unofficial archive/non-affiliation notice and source/guidance/support links. Unknown licenses stay unknown. A persisted sharing switch stops new outgoing votes and aborts an in-flight request, retains local stars and resumes the latest queued archive states; the global telemetry opt-out cannot be overridden. Previously shared votes remain counted, as explained in the panel. Both builds and 114 tests per checkout pass, plus native renderer copy/toggle/minimum-layout checks and actual packaged metadata/sharing/Escape/focus/shuffle/live playback checks. New unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-audio-notices/mac-arm64/SmoothyEdit.app`, with all 14 built files and nine CEP files verified. Prior builds are preserved. No commit, push, release or web deployment. The notice does not grant music permissions.

**Latest discovery shuffle:** Music opens/reopens in a fresh random order drawn from the whole catalog. The seed stays stable for filtering/search, community refreshes, playback and Load more, so pagination does not repeat or skip tracks. Saved MP3s keep their existing order. Both builds and 110 tests per checkout pass, plus native renderer seed checks and actual packaged random rows, 80 unique rows, filter order restoration and view/navigation reshuffles. Current unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-audio-shuffle/mac-arm64/SmoothyEdit.app`; all 14 built files and nine CEP files match. Previous packages and playback/column preferences are preserved. No commit, push, release or deployment.

**Latest scroll/player fix:** Playback keeps rows in place, preserving the clicked button and scroll position in archive/Saved MP3s. Loading text no longer adds a visible line; the title/artist area stays a fixed height. Volume grows from 40 to 100 pixels and still fits beside seeking in narrow windows. Both builds and native renderer checks pass. Real packaged bottom-row pointer playback held scroll at 1967.5 and dock height at 89 during loading/playing; volume input affects native audio. Current unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-audio-scroll/mac-arm64/SmoothyEdit.app`, with all 14 built files and nine CEP files verified. Earlier packages and column preferences are preserved. No commit, push, release or deployment.

**Latest column preference:** Artist stays visible. Only License type hides in a normal window and returns in full-screen/maximized windows, across all Audio Library tables. Native window events keep this state synchronized. Both builds and existing native renderer checks pass; the actual packaged app passed native full-screen entry/exit and Saved MP3s visibility checks. Latest local unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-audio-columns/mac-arm64/SmoothyEdit.app`; all 14 built files and nine CEP files match source/build. Prior packages are preserved. No commit, push, release or deployment.

**Playback follow-up:** The actual package returned `net::ERR_UNKNOWN_URL_SCHEME` because its renderer loaded before asynchronous audio protocol registration completed. Startup now awaits registration before creating the window. SVG controls replace text glyphs; row/player play/pause states match, loading/errors are visible, and retry makes a fresh media request. Native fixture error/retry recovery and actual packaged streaming/pause/resume/seek pass for **100 Degrees Under**, **69 Bronco** and **Sky Skating**. Latest local unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-audio-playback/mac-arm64/SmoothyEdit.app`; 14 built files and all nine CEP files match the build/source. Both builds and 109 tests per checkout pass. Earlier packages are preserved. No commit, push, desktop publication or additional web deployment.

The Audio Library now follows the user’s YouTube screenshot: flat tabs, search/genre/mood filters, track rows with title/genre/mood/artist/duration/license (no date), stars and one bottom player. Favorites persist locally; known archive stars sync anonymously per installation, including free users, with offline retries and deduplication. `SMOOTHY_TELEMETRY=0` disables outgoing favorite sharing. Local file metadata is never shared. Staff picks come from verified admin curation; the user-authorized private web collection service, admin controls, migration, privacy update and changelog are live. Public desktop remains 1.5.0 until a separately authorized release.

Both local desktop builds and **109 tests per checkout** pass, along with native full-renderer playback/seek/star/filter/save/cancel/metadata/minimum-window checks and live archive MP3 validation. Local dev package: `smoothyapp/dist/dev-1.5.1-audio-library/mac-arm64/SmoothyEdit.app`, unsigned/unnotarized, with all 14 built files and nine CEP files verified. Existing stock-service configuration, Multicam work and CEP 1.5.6/protocol 2 are preserved. No commit, push or desktop publication. Details and production version are in the monorepo’s `docs/PROJECT-STATUS.md` and `docs/reviews/smoothyapp-1.5.1-audio-library.md`.

### Local 1.5.1 missing-camera fix and disclaimer — 2026-10-03

The user reported blank second-speaker video in shipped 1.5.0 and explicitly chose a **local test build first**. The actual old XMLs contain both cameras but group their clipitems by camera, jumping backwards in time within each combined track. This verified generator defect plausibly explains dropped imports; actual Premiere import behavior was not reproduced. The retained XML generator now emits chronological clipitems with explicit track enable/lock metadata. The 1.5.1 Multicam path uses a native sequence duplicate and cuts throughout.

After editing, the host audits enabled clip coverage for every camera range and rejects missing footage/visible alternates. Electron requires the verified range count. Strict VAD rejects unreadable mic audio, while silent-mic and existing source-gap warnings are visible. The panel and footer label Multicam **beta** and warn that 1.5.0 can import incomplete camera cuts: start from the original timeline and review both speakers/audio sync. Disabled alternatives can be restored with the clip Enable command.

Both builds and **123 tests per checkout** pass, including 22 Multicam tests and real alternating audio through bundled FFmpeg/VAD/decisions into the simulated host. Repeated/reversed camera turns, every-frame coverage, missing/occluding alternatives, strict mic failures and XML ordering are covered. Native renderer disclaimer/warning/mapping/minimum-layout checks pass. Premiere APIs remain simulated; real Premiere rerun is outstanding. Verified/opened unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-multicam-coverage/mac-arm64/SmoothyEdit.app`, with 14 built files and nine CEP files matching. Installed CEP **1.5.8**, protocol **2**, host `20261003-multicam-coverage-v27`, capability **3**. Restart Premiere/reopen panel/Refresh and rerun the original timeline. Latest audio/stock changes and prior packages are preserved. No commit, push, release or web deployment. See monorepo status/Multicam review.

### Local 1.5.1 Multicam audio permission fix — 2026-10-03

FFmpeg was denied access to Premiere's private macOS `TemporaryItems` export. The app now creates a per-job audio directory and passes it during sequence preparation; Premiere renders WAV/MP3 directly there. Electron validates the expected filename, canonical directory, regular file and byte count before normalization. Cleanup removes rendered/normalized/partial audio on success or failure. CEP **1.5.7**, protocol **2**, host `20261003-multicam-audio-v26`, Multicam capability **2**; restart Premiere, reopen its SmoothyEdit panel, Refresh and retry.

Both builds and **118 tests per checkout** pass, including native bundled FFmpeg normalization/full decoding of two real synthetic stereo/48 kHz exports to mono/16 kHz PCM, cleanup and old/private/incomplete handoff regressions. Native Multicam renderer fixtures pass. Premiere export/cut APIs and speech detection remain simulated; the real Premiere retry is for the user. New unsigned/unnotarized app: `smoothyapp/dist/dev-1.5.1-multicam-audio-fix/mac-arm64/SmoothyEdit.app`, opened and verified with all 14 built files and nine CEP files; installed panel code matches. Latest Audio Library favorite-scroll/license/sharing/shuffle/player changes and shared stock service are included. Previous packages/signed 1.5.0 remain. No commit, push, release or web deployment. See the monorepo’s project status and Multicam review.

### Local 1.5.1 Multicam timeline test — 2026-10-03

The user authorized a local 1.5.1 build to compare with 1.5.0. Multicam now duplicates the existing Premiere sequence, renders individual microphone tracks through Premiere (including nested audio), and uses native camera-track splits/visibility on the duplicate instead of media-file XML reconstruction. Nests, existing clip effects, unselected overlays, captions, mixer settings and continuous audio come from the clone. The original remains intact. Selected camera tracks retain disabled alternatives. Wide shots switch their existing camera track; they are not a separate removable V3 overlay. Unselected video tracks stay unchanged. Only select camera tracks; exclude standalone title/adjustment layers from camera selection.

Both builds and 104 tests per checkout pass, including 14 new Multicam fixtures. Native renderer checks pass in normal/minimum Mac/Windows layouts. Native Premiere editing/export/effect behavior is still for the user's test; scripting APIs are simulated in tests. CEP is **1.5.6**, protocol 2, host `20261003-multicam-timeline-v25`. New package: `smoothyapp/dist/dev-1.5.1-multicam/mac-arm64/SmoothyEdit.app`. Restart Premiere/reopen the panel after the dev app installs this bridge. Shared stock service configuration and prior dev/signed 1.5.0 artifacts remain. Do not commit, push, publish or deploy this local work without new authorization. Details are in the monorepo's `docs/reviews/smoothyapp-1.5.1-multicam.md`.

### Local 1.5.1 development — stock footage sources + YouTube Audio Library

**2026-10-03 shared Pixabay follow-up:** The user replaced the user-key setup with an owner-funded shared service and explicitly required that the provider credential stay out of the open-source repo. The key field and key save/remove IPC are removed. Official builds use a maintainer-configured HTTPS search endpoint; source builds hide Pixabay until `SMOOTHY_STOCK_SERVICE_URL` points to the builder's own compatible service. Provider credentials stay server-side. The endpoint is supplied at build time; do not add the owner key to source, preferences, renderer code, build flags, GitHub or the app package. See the monorepo's project status for the private official build command and service verification. Preserve this setup on future pushes/releases. Desktop 1.5.1 is still local and unpublished; the shared backend and required website changelog are the newly authorized service work. Both desktop builds and 90 tests per checkout pass; the live service returns 12 clips, and native preview/download/FFmpeg decoding/local playback pass. Current package: `smoothyapp/dist/dev-1.5.1-shared-stock/mac-arm64/SmoothyEdit.app`, with 14 built files and nine CEP files verified. The credential is absent from source, package and Git history. Earlier dev packages are preserved.

The user requested a local dev build only: **do not commit, push, publish or deploy** without new authorization. Both source checkouts are 1.5.1; v1.5.0 remains public. Pexels was replaced at the user's request because new API key issuance is paused. Stock Footage now searches Wikimedia Commons without a key, restricts results to explicit CC0/public-domain licenses, previews videos, converts downloads to persistent MP4s with source records, and imports into Premiere's Project panel.

The Source picker also offers Internet Archive (explicit publisher-declared CC0/public-domain stock_footage and Prelinger items) and NASA Earth/space/science videos through official keyless APIs. NASA credit/media conditions are displayed and saved; these are not automatically CC0. Explicit third-party copyright notices exclude NASA records. Unknown variant dimensions are labeled honestly, and NASA minimum-quality filtering is disabled. Providers share previews, persistent MP4 downloads, usage links and Project imports. Live Archive and NASA previews/downloads/conversion/full decode/source notes/local previews passed.

On 2026-10-03, **All sources** became the default: concurrent Commons/Archive/NASA queries alternate clips in one grid with their original provider/usage terms. Each source has independent pagination; exhausted sources stop and failed sources show a warning while retaining their position for Load more to retry. All-source quality/orientation filters require known dimensions. Both builds and **83 tests** pass, including eight new aggregation tests, and full renderer fixtures pass at both window sizes/sidebar states. Live earth searches returned 49 clips then 45 more, with no overlapping IDs. Current dev package: `smoothyapp/dist/dev-1.5.1-all-sources/mac-arm64/SmoothyEdit.app`; its metadata, 14 built files and nine CEP files match source/build. The previous `dist/dev-1.5.1` package is preserved. No additional provider was integrated and nothing was published.

Audio Library now opens with Browse by type (genre cards and optional mood filtering), while title search is secondary. It browses the unofficial YouTube audio archive inside the app (5,142 title/Drive-ID entries, June 2020 snapshot), previews audio with seeking, saves permanent MP3s and offers Save & send to Premiere. No key/sign-in is needed. The optional Open YouTube Studio button and browser-download session/native file picker remain. A bundled index supplies archived genre/mood tags for 4,814 unique title matches from a separate April 2020 public snapshot; 328 unmatched/ambiguous tracks stay uncategorized. Tags are not guessed from filenames and metadata license fields are ignored. Artist/license metadata is absent from the download archive; direct saves keep an unverified license, archive ID and editable notes. CC BY choices require attribution text. Original browser downloads remain.

75 regression tests pass in both checkouts; builds and full renderer fixtures pass. A live archived MP3 played/sought, downloaded completely, passed native FFmpeg decoding, saved with source notes and played locally. Real Commons download/conversion and isolated native MP3 detection/validation/protocol preview also pass; signed-in Studio downloading and native Premiere imports remain unverified. CEP is locally 1.5.5, protocol 2, host `20261002-audio-library-v24`. The local unsigned/unnotarized arm64 app is `smoothyapp/dist/dev-1.5.1/mac-arm64/SmoothyEdit.app`. See the monorepo's `docs/reviews/smoothyapp-1.5.1-stock-footage.md` for checks and limitations. Existing signed 1.5.0 artifacts are preserved; no release or deployment was made.

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
