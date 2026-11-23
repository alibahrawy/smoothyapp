/**
 * smoothy_help topics. Each topic is loaded only when an agent asks for it, so the
 * MCP startup instructions stay short. These notes come from real long-form
 * edits (a 35-minute meeting recording cut to a 12-minute lesson over four
 * versions): every item cost time once and should not cost it again.
 */

export type HelpTopic = { title: string; summary: string; markdown: string };

const ENGINE = `# smoothy_engine: run the bundled tools directly

Smoothy ships ffmpeg, ffprobe and whisper-cli. Use them through \`smoothy_engine\`; never install your own copies.

\`\`\`json
{"tool":"ffmpeg","args":["-i","/abs/in.mp4","-vn","-ac","1","-ar","16000","audio/sec.wav"],"cwd":"/abs/project/Work"}
\`\`\`

- **Paths.** Reads must be inside the home folder, external volumes or the temp folder. Writes must be inside a
  writable root: the open edit project's folder (made by \`smoothy_edit new\` with \`folder\`), Smoothy's agent folder,
  the temp folder, or a folder the editor approved. Pass \`workspace\` once to ask for a whole project folder;
  the editor can approve it for the session. Relative paths resolve against \`cwd\` (default: the project's Work folder).
- **No network or plugins.** URLs, ffmpeg protocols (concat:, tee:, fd: ...) and the ladspa/lv2/frei0r/zmq filters
  are refused. Use the concat *demuxer* (\`-f concat -safe 0 -i list.txt\`); its entries are checked too.
- **Long runs.** Every run is a job. The call waits up to \`waitMs\` (default 20 s, max 120 s) and returns the job id
  if it is still running. \`smoothy_jobs wait\` reports progress and an ETA, so poll at the ETA, not every second.
  Set \`expectedSeconds\` (or use -t) when ffmpeg cannot read a duration, for an accurate ETA.
- **Results.** You get the exit code, the last lines of stderr (\`tailLines\`, default 30), stdout (inline when small,
  otherwise a file path), the files written, and the full log path. Big stdout (ffprobe JSON, astats prints) goes to a file.
- **Overwrites.** ffmpeg refuses to overwrite without \`-y\`. Use \`-y\` only for scratch files, never for a previous
  version's deliverable.
- **Cache.** Pass \`cache:true\` for deterministic analysis runs (loudness, envelopes, transcripts). A repeat run with
  the same arguments, the same input files and its outputs still on disk returns the cached result.
- **whisper-cli.** \`smoothy_status\` lists the binary and models (\`engines.whisper\`). Always pass \`-of <prefix>\`
  with output flags. For word timings use \`-nfa -dtw <preset>\` (status gives \`dtwPreset\` per model), see topic audio.
`;

const GOTCHAS = `# Gotchas (each cost real time once)

## Timing and cutting
- **Whisper segment times are loose.** For cuts, use token-level DTW times: whisper-cli \`-nfa -dtw small.en -ojf\`.
  DTW onsets run 0.15–0.2 s **late**: shift every word onset by **−0.15 s**.
- **Make Whisper write the fillers.** Pass a filler prompt such as
  \`--prompt "Um, uh, so, like, you know. I mean, uh, okay."\` plus the topic's product words, or "um"/"uh" vanish
  from the transcript and cannot be cut.
- **Add the offset back.** When you transcribe an extracted section, add its start time so every word is in
  **source seconds**.
- **Snap cuts into real silence**, not onto word times: from a 10 ms RMS envelope, speech above about −50 dB,
  quiet below −45 dB. Keep 0.08 s before the first syllable and 0.14 s after the last. Word onsets are hard limits,
  so no syllable is clipped.
- **Pauses:** tighten pauses over 0.62 s to 0.30 s ("a tiny bit of air").
- **Filler removal guard:** cut a filler island only if it is ≤ 0.55 s and no real-word onset falls within ±0.02 s;
  if the filler time lands in silence, use the next speech island. Drop clips that contain only fillers.
- **Frames:** land every cut on frames at the sequence fps.
- **Verify every cut list:** render the cut audio with 0.6 s gaps, transcribe it, and diff against the expected words.
  Expect ≥ 97 %; check each clipped or leaked word.

## Versions and files
- **Never overwrite the previous version.** A copied builder once wrote over the v3 XML. When you bump a version,
  check every output path (XML, renders, timelines, captions).
- Keep every version importable on its own (v1, v2 …) so the editor can roll back.
- Long renders and transcription are background jobs; report an ETA to the person instead of polling.
- Write big data (transcripts, envelopes, clip lists) to files in the project's Work folder and pass paths around.

## Encoding (Apple Silicon)
- h264_videotoolbox for intermediates; libx264 \`-crf 16\` for a zoomed speaker crop (it gets enlarged).
- ProRes 4444 with alpha: \`-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le\`.
- Resize photos to ≤ 3840 px wide before using them; oversized photos caused render glitches.

## Recordings of video meetings
- The speaker tile switches to other participants (active-speaker layout). Scan the tile and cover those moments.
- Verify the tile and share-area crop on a frame from **each** recording; layouts change between days.
- Hands over the face (eye rubbing) read badly; find them with vision_hands_on_face and cover them. Eyeball each hit.
- The speaker-tile colour test depends on clothes: re-check it per recording day, or use layout_scan measure "match"
  against a reference frame of the right person.
- Crop the speaker tile from the original file with source timecode (\`-timecode\`) so clips can be extended later.
`;

const WORKFLOW = `# Long-form workflow (meeting recording → edited lesson)

Folder layout (\`smoothy_edit new\` with \`folder\` creates it): \`Edit/\` deliverables, \`Media/\` angles, music, photos,
\`Graphics/\` renders, \`Work/\` scripts, transcripts, audio, logs. Sources are never modified.

| # | Step | How in Smoothy today |
|---|---|---|
| 0 | Kick-off: find the section, grab a frame to check the layout | \`smoothy_media frame\` / \`probe\` |
| 1 | Audio + word transcript (DTW words, −0.15 s, fillers flagged) + 10 ms envelope | \`smoothy_analyze\` transcribe_words (terms: product words) and envelope |
| 2 | Cut list: story as phrase rows (near mm:ss, from phrase, to phrase, skips) with chapters | You write the rows ({chapter, sub} and {id, near, from, to, skip?, angle?}); "@937.15" anchors an exact source time |
| 3 | Resolve the cut list on the waveform (silence snap, lead/tail, pause tighten, filler guard, frames) | \`smoothy_cut\` cut_phrases {words, envelope, rows} → clips.json (place:true adds them to the headless edit) |
| 4 | Verify: gapped audio → transcribe → diff | \`smoothy_cut\` verify_edit {clips, words}: fix each issue's row, then cut_phrases again with fillers:<verify.json> |
| 5 | Layout scan + angles (speaker crop, board/share crop, splits) with source timecode | \`smoothy_analyze\` scene_cuts, \`smoothy_engine\` ffmpeg crop/scale |
| 6 | Vision: eye midpoint for zoom anchors, hands over face; layout scan for tile swaps and the board | \`smoothy_analyze\` vision_faces {path, crop, clips, apply, zoom}, vision_hands_on_face {path, crop, clips}, layout_scan {path, regions} |
| 7 | Timeline: clips, captions (≤ 5 words per line), chapters | \`smoothy_cut\` captions {clips, words, inserts, corrections} and chapters {clips, inserts}; \`smoothy_edit\` for the headless timeline |
| 8 | Render + QA graphics (glitch check over gray) | \`smoothy_analyze\` glitch_check {folder}; \`smoothy_render\` frame/sheet composite overlays (PNG/ProRes 4444 alpha) |
| 9 | Music bed under speech with lifts, SFX cues | \`smoothy_library\` music, then \`smoothy_edit\` music_bed and sfx; \`smoothy_render\` proxy for a watch-through |
| 10 | XML for Premiere + contact sheets at every boundary | topic premiere |
| 11 | Import as a new sequence, check offline media, capture frames | topic premiere |
| 12 | Deliver: sequence name, length, what changed, captions SRT, chapters, credits | write to Edit/ |

## Cut list tips
- Rows are matched on normalized words (case and punctuation ignored) within ±25 s of near. A "to" phrase is searched after
  the "from" phrase. Use "@seconds" for from/to and "@a-b" in skip to anchor exact source times.
- Start with a cold open (2 punchy lines, about 10 s) that ends on a hook; target 6–10 chapters.
- Inserts for captions/chapters: pass logo/title and each slate as separate {before, seconds}; a chapter starts at its slate.
- Expect verify_edit similarity ≥ 0.97; the remaining differences are usually Whisper misrecognitions. Silent clips are listed.

## Sourcing
- Photos: \`smoothy_library\` photo {query} (CC0/public domain; license:"cc-by" adds CC BY with the author). Downloads and
  imports are capped at 3840 px wide. Stock: license:"no-attribution" keeps CC0/PD/Pixabay/Coverr. Music from the archive has
  no licence data: confirm Content ID safety with the provider (Claim Clear lists etc.).
- Every download appends its credit to Edit/CREDITS.txt; \`smoothy_library\` credits rewrites it for the video description.

## Revision rounds
- The editor trims your sequence directly. Before a new version, read their **live** sequence and start from it;
  never throw their edits away. Re-run the layout/angle checks after merging.
- New version = new output names everywhere (see topic gotchas). Snapshot the headless edit with
  \`smoothy_edit snapshot\` before big changes; \`restore\` rolls back.

## Done means
Verification diff clean (no clipped or leaked words, no silent clips), contact sheets reviewed at every boundary,
imported with no offline media, captions/chapters/credits written to Edit/.
`;

const PREMIERE = `# Premiere round-trip

- **Build at the source frame rate.** Footage at 24 fps goes into a 24 fps sequence even if the editor's template is 4K30.
- **FCP7 xmeml v4 Basic Motion:** \`center\` is in **half-sequence-frame units**, independent of clip size:
  vert 0.1 = 108 px in a 2160-high sequence.
- A 1920 clip in a 3840 sequence uses scale **200 × zoom**.
- **Eye-anchored zoom** (ex, ey = eye midpoint, normalized, origin top-left; z = zoom):
  \`horiz = 2(z−1)(0.5−ex)\`, \`vert = 2(z−1)(0.5−ey)\`. Default anchor without a face: (0.50, 0.44).
- Reference clips by **source timecode** so the editor can extend them in Premiere.
- Pack graphics, SFX and music onto as few tracks as possible.
- An imported XML becomes a **new sequence**. Never overwrite or delete earlier versions; each is the editor's rollback.
- CEP panels cannot delete project items: do not make throwaway test imports.
- Before each new version, read the editor's live sequence (source ranges per track) and diff it with your last version.
- After importing: check offline media is 0 and capture a few frames.
- Some third-party Premiere MCP clients truncate results over 64 KB unless the client writes stdout synchronously.

## In Smoothy
1. Build the edit headless (\`smoothy_edit\`, \`smoothy_cut\` cut_phrases place:true). Create the project at the source fps.
2. Speaker tiles and share areas: \`smoothy_edit\` region {asset, name, crop:[x,y,w,h]} makes a virtual source on the
   original file (source timecode kept, no re-encode). Punch in with {op:"set", clip, zoom, anchor:[ex, ey]}.
   Check with \`smoothy_render\` frame/sheet: it uses the same geometry as the XML.
3. \`smoothy_nle\` export_xml {name, markers:<chapters.json>} → Edit/<name> (vN).xml plus a .smoothy.json record.
4. \`smoothy_nle\` import_xml: no offline media allowed, the editor approves, it becomes a new sequence.
5. Next round: ask the editor to open their working sequence, then \`smoothy_nle\` live_diff (apply:true rebuilds the
   headless edit from their cut after a snapshot). Re-run layout/angle checks after merging, then export (v+1).

Regions in XML use Premiere's Crop effect on the original file at a high scale (a 410 px tile ≈ 937 %). For the
sharpest speaker shot, render an upscaled intermediate with \`smoothy_engine\` (crop, scale lanczos, unsharp, -timecode)
and use that file as the asset instead.
`;

const AUDIO = `# Audio cleanup & recipes

## Noise removal, separation & dialogue cleanup (\`smoothy_audio\`)
You cannot hear the recording — measure first, clean with Smoothy's local neural engine (never ffmpeg \`afftdn\`/\`anlmdn\` which hollow out voices), and verify the before/after metrics.

1. **Diagnose first (fast, works even before engine setup):**
   \`smoothy_audio\` \`{action:"diagnose", path|asset, from?, to?}\`
   Returns \`verdict\` (\`clean\`|\`mild_noise\`|\`noisy\`|\`very_noisy\`), \`noiseFloorDb\`, \`speechLevelDb\`, \`snrDb\`, \`lufs\`, \`truePeakDb\`, \`lowEndDb\`, \`issues\`, and \`recommendedStrength\` / \`recommendedVoiceChain\`.
2. **Test a short slice on long recordings (optional):**
   Pass \`from:60, to:75\` to \`denoise\` — takes seconds and returns before/after \`noiseReductionDb\`, \`speechDeltaDb\`, and \`snrGainDb\`.
3. **Pick the exact tool needed:**
   - **\`denoise\`** — Direct neural noise removal (fan, hiss, hum, AC, room noise). Does **not** run music separation, so dialogue stays natural and fast.
   - **\`separate\`** — Splits a recording or song into independent **Voice** and **Music** WAVs.
   - **\`isolate\`** — Strips **both** background music and room noise in one step to produce clean dialogue.
4. **Control quality and apply cleanly:**
   - \`strength\` (\`0–1\`, default \`1\`): lower to \`0.7–0.85\` if you want natural room tone or if \`metrics.verdict\` reports \`over_processed\`.
   - \`aggression\` (\`1–20\`, default \`5\`): raise to \`8–12\` for stubborn noise.
   - \`voiceChain:true\`: runs the broadcast dialogue chain (80 Hz highpass + light compressor + −16 LUFS loudnorm) after denoising.
   - \`apply:true\`: snapshots your open \`smoothy_edit\` project, imports the cleaned WAV to \`Media/Audio/\`, and swaps all matching audio clips (preserving every cut, trim, link and fade).
   - \`muxVideo:true\`: writes a lossless-video copy (\`-c:v copy\`) with the cleaned audio (original untouched).

## Manual ffmpeg recipes (through \`smoothy_engine\`)

**Voice chain** (dialogue master):
\`highpass=f=80,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=150:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9\`

**Music bed:** about 18 dB under the voice: −33.5 LUFS under speech, lifted to about −24 LUFS on titles, slates and
the end card; loop with 3 s crossfades; fade in and out. Measure the music first:
\`["-i","music.wav","-af","ebur128","-f","null","-"]\` (read "I:" from the summary in stderr).

**In Smoothy:** \`smoothy_edit\` music_bed {asset} builds the bed (loops with 3 s crossfades, −33.5 LUFS under speech,
lifted to −24 LUFS in dialogue gaps of 1.5 s+, or your own lifts:[{from,to}] for logo/title/slates/end card) and puts it
on an A track as a WAV in Media/Music. \`smoothy_edit\` sfx {cues:[{at, name}]} places level-matched sounds
(peak −18 dBFS, RMS capped at −32) on packed tracks above dialogue and music; sfx_search lists them. For your own
pre-levelled sounds pass {at, path, level:false}. Tell the editor every licence and credit.

**Loudness of a file or ranges:** \`smoothy_analyze\` loudness {path, ranges:[{from,to}]} (integrated LUFS, LRA, true peak).

**10 ms RMS envelope** (cut points, silence map): \`smoothy_analyze\` envelope {path, from?, to?, thresholdDb:-50}
writes envelope.json (db[] per 10 ms) and a silence map. The same by hand:
\`["-v","error","-i","sec_48k.wav","-af","asetnsamples=n=480:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms10ms.txt","-f","null","-"]\`
then parse the \`RMS_level=\` lines (one per 10 ms; -inf = −120 dB). n=480 is 10 ms at 48 kHz.
**Do not measure levels after \`-ac 1\`.** ffmpeg downmixes stereo as 0.707·(L+R), so identical channels read **3 dB hot**
and every dB threshold shifts. Measure on the native channels (astats Overall) or downmix with \`pan=mono|c0=0.5*c0+0.5*c1\`.
\`smoothy_analyze\` envelope already does this.

**Word transcript with DTW:** \`smoothy_analyze\` transcribe_words {path, from?, to?, terms:["product words"]} does all of
this and writes words.json ({w, a, b, p, filler?} in source seconds) and readable.txt. Install small.en first with
install_model if it is missing. The same by hand:
1. \`["-ss","<start>","-t","<len>","-i","<src>","-vn","-ac","1","-ar","16000","audio/sec.wav"]\`
2. whisper: \`["-m","<model path>","-f","audio/sec.wav","-t","8","-nfa","-dtw","small.en","-ojf","-of","transcript/dtw","--prompt","Um, uh, so, like, you know. I mean, uh, okay."]\`
3. In transcript/dtw.json, each token has \`t_dtw\` (centiseconds). Merge tokens into words, shift onsets −0.15 s,
   add <start>, and flag um/uh/erm as fillers.
small.en is a good default (about 1–2 min per 35 min on Apple Silicon); medium.en for hard audio.
`;

export const HELP_TOPICS: Record<string, HelpTopic> = {
  engine: { title: 'Running ffmpeg, ffprobe and whisper-cli', summary: 'smoothy_engine arguments, path rules, jobs, cache.', markdown: ENGINE },
  gotchas: { title: 'Known pitfalls', summary: 'Cut timing, fillers, versions, encoders, meeting recordings.', markdown: GOTCHAS },
  'workflow-longform': { title: 'Long-form workflow', summary: 'The 12 steps from recording to imported sequence, mapped to Smoothy tools.', markdown: WORKFLOW },
  premiere: { title: 'Premiere round-trip', summary: 'Frame rate, Basic Motion units, eye-anchored zoom, versions.', markdown: PREMIERE },
  audio: { title: 'Audio recipes', summary: 'Voice chain, music bed levels, loudness, envelope, DTW transcript.', markdown: AUDIO }
};

export function topicList(): { topic: string; title: string; summary: string }[] {
  return Object.entries(HELP_TOPICS).map(([topic, item]) => ({ topic, title: item.title, summary: item.summary }));
}
