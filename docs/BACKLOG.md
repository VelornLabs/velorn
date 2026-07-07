# Velorn — Come-Back-To-This Backlog

Low-priority or tricky items parked with enough context that any future agent
(or future-you) can pick them back up without re-discovering everything.

Add new entries to the bottom. Keep each one self-contained.

---

## 1. Captions: muted/disabled clips still show up in timeline transcription

**Added:** 2026-04-16
**Severity:** Minor (workflow usable, produces wrong captions for muted audio)
**Last touched:** Captions feature stabilization pass

### Symptom

When the user runs **Transcribe Timeline** with either:

- A track muted via the speaker icon on the audio track header (`track.muted = true`), or
- A clip right-click → Disable Clip (`clip.enabled = false`),

…the generated caption overlay still contains words that came from the muted
track / disabled clip. Playback itself correctly silences them — the user
cannot *hear* the muted audio. The issue is only in the ASR output.

### What we know

- The Zustand state is correct. `track.muted` flips to `true`; `clip.enabled`
  flips to `false`. Playback respects both (confirmed by user ear).
- `src/services/timelineAudioMix.js → buildIpcPayload` forwards the flags:
  ```js
  clips: [{ …, enabled: clip.enabled !== false, … }]
  tracks: [{ id, type, muted: !!track.muted, visible: track.visible !== false }]
  ```
- `electron/main.js → ipcMain.handle('captions:mixTimelineAudio')` filters:
  ```js
  if (clip.enabled === false) continue
  if (track.muted) continue
  if (track.visible === false) continue
  ```
- Both the FFmpeg main-process path and the Web Audio fallback apply the
  same filters. On paper, muted/disabled clips should never reach the mixer.
- A diagnostic log `[captions:mix] filter decisions: {...}` was left in
  `electron/main.js` specifically to answer "which clips did the mixer
  actually include?". It prints the per-clip decision + reason + the full
  `tracks` array as received from the renderer. Look for it in the terminal
  running `npm run dev` when the bug reproduces.

### Two remaining hypotheses

1. **Payload edge case.** Something unusual about how disabled/muted state
   is represented in certain store shapes (e.g. after a project load, or
   for clips created by certain code paths like `addTextClip`) might leak
   a truthy `enabled` or missing `muted` through. The diagnostic log will
   confirm or refute this — if it shows `decision: skip, reason: ...` for
   the intended clips and captions still appear, this hypothesis is dead.

2. **Qwen-ASR hallucination.** Whisper-family ASR models (Qwen-ASR shares
   the architecture) are known to fabricate speech-like text when fed
   silence, music-only audio, or very low-signal input. If the user mutes
   the *only* dialogue track and leaves music on track B, the model may
   generate nonsense text from the musical content. This would look like
   "still producing captions for muted audio" even though the mix is
   correctly silencing it.

### How to confirm which

1. Reproduce with the diagnostic log visible (`npm run dev`, watch terminal).
2. Mute the dialogue track.
3. Run Transcribe Timeline.
4. Grab the `[captions:mix] filter decisions` JSON. Specifically check:
   - Were the muted track's clips listed as `decision: skip, reason:
     track.muted=true`? If yes → mix is correct → hypothesis #2
     (hallucination). If no → hypothesis #1 (payload bug).
5. If #2: compare the generated caption text against what was on the
   *unmuted* tracks only. If it matches the unmuted content but also
   contains extra phantom words, hallucination is confirmed.

### Likely fixes per hypothesis

- **#1 (payload bug):** Trace the specific payload path for whichever
  clip slipped through. Probably a `!!` vs `=== false` mismatch somewhere,
  or a stale clip reference. Quick fix once the log pinpoints it.
- **#2 (hallucination):** Two options:
  - **Defensive:** measure RMS of the mixed WAV before sending to ASR; if
    below a threshold (e.g. -45 dBFS average over the whole clip), short
    circuit with an empty caption and a friendly "no audible speech
    detected" message instead of running ASR at all.
  - **Proper:** add a VAD (voice activity detection) pre-pass — e.g.
    `silero-vad` via ONNX, or ffmpeg's `silenceremove` / `silencedetect`
    — and strip non-speech segments before ASR. Prevents hallucination
    and also shortens ASR compute time. Meaningful dependency addition;
    only worth it if users hit this often.

### Relevant files

- `src/services/timelineAudioMix.js` — renderer-side mix entry point + payload builder
- `electron/main.js` (IPC `captions:mixTimelineAudio`) — FFmpeg mixdown + filter
- `src/services/captionComfyTranscription.js` — ASR orchestration
- `src/stores/timelineStore.js` — `toggleTrackMute`, `setClipsEnabled`

### How to remove the diagnostic log when fixed

Search `electron/main.js` for `[captions:mix] filter decisions:` and delete
the `console.log` block plus the `decisions` array construction around it.
The filter itself should stay.

---

## 2. Director Mode — Music Video generation (Phase 8 shipped; follow-ups tracked below)

**Added:** 2026-04-20
**Updated:** 2026-04-20 (Phase 8 + Option A merge: SRT/LRC-driven timing + `Start at:` field + Copy LLM Prompt + coverage/overlap/drift validation, with the plain Lyrics and SRT textareas collapsed into a single auto-detecting Lyrics field)
**Severity:** Feature work, medium size (one remaining focused session for the
vocal-extract preprocessing step + storyboard-pass polish; the end-to-end
music-video flow is live and timing is now LLM-owned + SRT-verified).
**Last touched:** Phase 8 pivoted timing ownership from the planner's linear
lyric-line estimate to the LLM that writes the script, with the SRT/LRC
serving as ground truth. Users now (1) paste an SRT or LRC of the vocal
track, (2) click "Copy LLM Prompt" to get a ready-to-paste briefing (cast +
concept + style + SRT + strict format spec), (3) hand it to Claude/GPT/Gemini
and paste the result back. The script format now includes `Start at:` per
shot, and the planner cross-checks every `Start at:` against the SRT plus
runs coverage, gap, overlap, and drift validators that feed the existing
warnings banner. Phase 7's cast/lyric-tag resolution is unchanged.

### What shipped in Phase 8 (2026-04-20)

- **Timed-lyrics parser** (`parseTimedLyrics` in `musicVideoShotConfig.js`):
  auto-detects SRT vs. LRC from the pasted blob. SRT path honors both `,`
  and `.` decimal separators, tolerates missing index lines and blank-line
  spacing; LRC path handles repeat-timestamp lines (`[00:12.34][00:45.67]`),
  enhanced LRC word-level `<tag>` stripping, `[offset:+N]` headers, and
  infers end-times as the next line's start. Returns `{format, lines, error}`
  with `error` set only when the format looked right but parsing failed.
- **Time-string helper** `parseTimeSpecToSeconds` accepts `"15"`, `"15s"`,
  `"15.5"`, `"0:15"`, `"0:15.5"`, `"1:23"`, `"1:23,500"`, `"01:23.500"`,
  `"00:01:23,500"`, `"1h02m03s"` — returns `null` for anything it can't
  read (distinct from `0`), so the planner can tell "user meant 0" from
  "user typed garbage".
- **`Start at:` script field** (aliases: `Audio start`, `Start`). Added to
  `STRUCTURED_FIELD_PATTERNS` in `yoloPlanning.js`. Parsed onto each shot as
  `startAtRaw`. Ad path unaffected — ads never set it.
- **Four-tier audioStart resolution** in `buildMusicVideoPlanFromScript`:
  1. Explicit `Start at:` — parsed via `parseTimeSpecToSeconds` (authoritative)
  2. `Lyric moment:` fuzzy-matched against parsed SRT/LRC (`findTimedLyricLineByText`)
  3. `Lyric moment:` fuzzy-matched against plain lyrics + linear estimate
     (legacy path for users who haven't pasted an SRT)
  4. Cumulative sum of prior shot lengths (Phase 6 behavior)
  The chosen path is stapled onto the shot as `audioStartSource` for debug.
- **Plan validation trio** — feeds `yoloMusicPlanWarnings` with distinct
  `kind` values so the UI can group later:
  - `coverage-summary`: one `Plan covers Xs of your Ys song (Z%). Gaps: …`
    entry per plan, using `computeCoverageGaps` against the actual song
    duration (read from the audio asset's metadata).
  - `lyric-timing-drift`: for any shot with both `Start at:` and a matched
    `Lyric moment:`, compares the explicit time to the SRT time and flags
    drift ≥ 1s as info / ≥ 2.5s as warning (LLM probably got it wrong).
  - `shot-overlap`: any two shots whose `[start, end]` intervals intersect
    by > 0.01s. Adjacent ranges that touch (a.end === b.start) are fine.
  - `unparseable-start-at`: Start at: value wasn't a valid time.
  - `srt-parse-error`: SRT/LRC paste looked right but produced zero lines.
- **Single auto-detecting Lyrics field** (Option A merge, 2026-04-20) — the
  Phase 8a two-textarea design (plain `yoloMusicLyrics` + separate
  `yoloMusicLyricsSrt`) was collapsed into one state field. The Lyrics
  textarea accepts plain text, SRT, or LRC; `detectTimedLyricsFormat`
  decides on every keystroke which path the planner takes. `yoloMusicParsedLyrics`
  exposes `{format, lines, error, isTimed}` so the header badge flips
  between `SRT · N timed lines` / `LRC · N timed lines` (emerald) and
  `Plain text · N lines` (muted), and the textarea turns monospace when
  timed. A one-time migration in the persistedState loader promotes any
  legacy `yoloMusicLyricsSrt` blob into the main lyrics slot when that
  slot is empty, so existing projects open cleanly. The planner skips the
  tagged/[Name]-resolver tiers whenever the paste is SRT/LRC (the tags
  wouldn't parse meaningfully there), and the LLM-prompt builder flips
  its lyric-section label between "authoritative timings" and "plain
  text — estimate evenly" based on the same format detection.
- **"Copy LLM Prompt" button** next to the existing `Start from template` /
  `Copy Template` buttons. Calls `buildMusicVideoLLMPrompt` which
  assembles: role statement + song/duration/target meta + cast roster
  (with the exact slugs the LLM should use) + concept + style notes +
  SRT (labeled "authoritative") or plain lyrics (labeled "estimate
  evenly") + 9-point rule list + verbatim output-format spec with two
  worked example shot blocks. Designed so the LLM can't mess up the
  format: it's one clipboard copy, one paste, one paste-back.
- **Template + UI copy updates**: `MUSIC_VIDEO_SCRIPT_TEMPLATE` now shows
  `Start at:` on every shot. The Director Script textarea placeholder and
  the "Recommended Director Format" helper both advertise the new field
  and point users at the Copy LLM Prompt flow.
- **Audio-asset duration source** — new `yoloMusicAudioAsset` +
  `yoloMusicSongDurationSeconds` memos read `asset.duration` (with a
  `asset.settings?.duration` fallback). Used by the coverage validator
  and threaded into `buildMusicVideoLLMPrompt` so the LLM sees the real
  song length.

### Phase 8 workflow (user-facing summary, post Option A merge)

1. Paste lyrics into the single Lyrics field — either plain text, or a
   timed SRT/LRC (generate the SRT with Whisper / Subtitle Edit / ElevenLabs
   STT against the vocal stem). The header badge tells you which format
   was detected.
2. Click "Copy LLM Prompt" and paste it into an LLM. The prompt tells the
   LLM whether your timings are authoritative or need to be estimated
   evenly based on the same auto-detection.
3. Paste the LLM's returned script into the Director Script textarea.
4. Click "Build Plan" — the amber warnings banner reports coverage %,
   any gaps, any overlaps, and any drift between the LLM's `Start at:`
   and the SRT. Edit the script directly to fix issues, or re-prompt the
   LLM with the warnings for another pass.

### What shipped in Phase 7 (2026-04-20)

- **Cast roster state** (`yoloMusicCast` on `GenerateWorkspace.jsx`): an
  ordered array of `{id, slug, label, assetId, role}`. Persisted alongside
  every other yoloMusic* field. `yoloMusicResolvedCast` memo hydrates each
  entry against the project's image assets so rows pointing at deleted
  assets silently drop out of planning but still render as an "asset missing"
  warning in the UI.
- **Automatic legacy migration**: the old single-artist `yoloMusicArtistAssetId`
  auto-seeds into `cast[0]` with slug `artist` on first render if the cast is
  empty. After migration the legacy field is still kept in state for
  persistence continuity but the planner ignores it once the cast has entries.
  Existing projects keep working with zero user action.
- **Cast roster UI** inside the Script tab, replacing the old single-artist
  dropdown. Each row has: image-asset dropdown, slug input (auto-derived from
  the picked asset's filename but editable), display-name input, role select
  (`lead`, `co_lead`, `backing`, `instrumentalist`, `never_sings`, `other`),
  and a remove button. `+ Add cast member` appends a blank row. An empty-state
  panel explains the grammar. When `z-image-turbo` is the chosen storyboard
  workflow, a warning reminds the user that references are ignored.
- **Script-level `Artist:` field** (aliases: `Singer`, `Performer`, `Cast`,
  `Vocalist`). Added to `STRUCTURED_FIELD_PATTERNS` in
  `src/utils/yoloPlanning.js` and passed through the parsed shot object as
  `artistRaw`. Ad path unaffected — ads just never set this field.
- **Lyric `[Name]` tag lines** via `parseLyricsWithTags` in
  `musicVideoShotConfig.js`. Tags are sticky: `[Rose]` on its own line applies
  to every subsequent line until the next tag. Supports collective keywords
  (`[Both]`, `[All]`, `[Band]`) and comma/and/`&`/`ft`-separated lists
  (`[Rose, Jake]`, `[Rose & Jake]`, `[Rose ft Jake]`). Standard section
  markers (`[Chorus]`, `[Verse 1]`, `[Bridge]`, `[Outro]`, `[2x]`, etc.) are
  recognized and do NOT overwrite the active artist tag.
- **Name resolver** `resolveCastMembersFromNameList` + `normalizeCastSlug` +
  `splitCastNameList` — slug-first, label-second, whitespace/case-tolerant
  matching. Unknown names are collected as `unresolved` so the UI can surface
  them as advisory warnings.
- **Per-shot resolution priority** in `buildMusicVideoPlanFromScript`:
  1. Script `Artist:` override → hard-matched against the cast
  2. `[Name]` tag on the matched lyric line → matched against the cast
  3. `cast[0]` ("default lead") → always used when present and no override matched
  4. No reference → when the cast roster is empty entirely
  The first matching step wins; fallbacks only fire when the previous step
  produced zero resolved members. Results get stapled onto each shot as
  `resolvedArtistAssetIds: [slot1, slot2]`, `resolvedArtistSource` (for
  debug), and `resolvedArtistLabels`.
- **Planner warnings**: `buildMusicVideoPlanFromScript` now returns
  `{ scenes, warnings }` (breaking change — only one caller). Warning kinds:
  `unresolved-artist-override` (script said `Artist: jack` but no cast
  member matched), `unresolved-lyric-tag` (lyric said `[Jack]` but no
  match), `too-many-artists` (more than 2 resolved members — slots 3+ are
  dropped because the queue only has two reference slots). Surfaced as an
  amber banner below the Director Script textarea listing up to 6 messages
  with a "…N more" overflow.
- **Variant + queue wiring**: `flattenYoloPlanVariants` now passes
  `resolvedArtistAssetIds` through to each variant. `queueYoloStoryboardVariants`
  reads `variant.resolvedArtistAssetIds[0/1]` in music mode and falls back to
  the legacy `yoloMusicArtistAsset` if the per-shot resolution was empty.
  Duet shots with two resolved members naturally fill `referenceAssetId1`
  and `referenceAssetId2`, matching the slots ads use for product+model.
- **Template + lyrics placeholder** updated to demo the new grammar: the
  `MUSIC_VIDEO_SCRIPT_TEMPLATE` now has `Artist: rose` / `Artist: jake` /
  `Artist: both` on four of its five shots, and the lyrics textarea
  placeholder walks the user through a 2-singer example including a
  collective `[Rose, Jake]` tag.
- **Plan signature** gains a `castSignature` (slug:assetId:role joined) so
  editing the cast roster correctly marks the plan stale and prompts a
  rebuild — important because adding a cast member mid-project would
  otherwise leave old shots pointing at the stale default.

### What shipped in Phase 6 (2026-04-22)

- **New script-first planner.** Replaced `buildMusicVideoPlan` (lyrics +
  sliders) with `buildMusicVideoPlanFromScript({script, lyrics, concept,
  styleNotes, targetDuration})`. Each `Shot N:` block in the script becomes
  exactly one output clip — shot count, length, keyframe prompt, and motion
  prompt are all owned by the script instead of being interpolated from a
  preset.
- **Extended the shared ad-style parser** (`parseStructuredDirectorScript` in
  `src/utils/yoloPlanning.js`) to understand two music-only grammar bits:
  `Lyric moment:` (pins the shot to a line in the pasted lyrics) and
  `Length:` as an alias for `Duration:`. The `currentShot` accumulator also
  keeps `keyframePromptRaw` / `motionPromptRaw` so the music planner can
  compose separate video- and reference-image prompts. Ad path unaffected —
  the new keys default to empty and the ad consumer never reads them.
- **Music-video prompt composers** replaced the single `composeMusicShotPrompt`
  with two small composers: `composeMusicShotVideoPrompt` (for the LTX 2.3
  node-1624 PROMPT) and `composeMusicShotReferencePrompt` (for the
  storyboard still). This separates "what the singer is doing on the beat"
  from "what the reference image should look like", which matters once the
  storyboard pass starts picking up `referenceImagePrompt` in a future
  session.
- **Lyric-to-audioStart matching** via `findLyricLineIndex` +
  `estimateLyricLineStartSeconds` (both in `musicVideoShotConfig.js`). The
  matcher is three-tiered: exact normalized line → substring → 4+ word
  window. If the match fails (or there's no `Lyric moment:` line at all),
  the planner falls back to the cumulative-length audio cursor.
- **Artist reference image** (`yoloMusicArtistAssetId` +
  `yoloMusicArtistAsset` memo). Routed into the storyboard queue as
  `referenceAssetId1` when in music mode — matching the slot Ad uses for the
  product image. The UI surfaces an amber warning when the selected
  storyboard workflow is `z-image-turbo`, which ignores references.
- **Ripped out the preset/sliders UI**: `MUSIC_VIDEO_CREATIVE_PRESETS`
  picker, `yoloMusicBRollRatio`, `yoloMusicPerfWideRatio`, and
  `yoloMusicAvgShotLength` state + controls all deleted. The config
  constants still live in `musicVideoShotConfig.js` for any future callers
  but `GenerateWorkspace.jsx` no longer imports them.
- **Script tab UI** mirrors the ad Script tab: a big Director Script textarea,
  "Start from template" button (populates `MUSIC_VIDEO_SCRIPT_TEMPLATE`),
  "Copy Template" button for AI prompting, plus the expandable "Recommended
  Director Format (Music Video)" helper.
- **`MUSIC_VIDEO_SCRIPT_TEMPLATE` constant** (concrete 4-shot example:
  highway b-roll, verse close-up, pre-chorus wide, exit b-roll) seeded so the
  user can click "Start from template" and see a working format immediately.
- **`resolveMusicVideoShotTypeFromText`** + `MUSIC_VIDEO_SHOT_TYPE_ALIASES`
  accept informal shot-type strings from the script (e.g. "wide
  performance", "B-roll", "cutaway") and normalize them to the canonical
  `performance | performance_wide | b_roll`.
- **Setup tab copy** updated: the Song Length field now says "Song Duration"
  and its helper explains that it's used for Lyric-moment → audio-time
  estimation, not shot-count sizing.

### What shipped in Phase 5 (2026-04-20)

- **Replaced `YOLO_MUSIC_PROFILES`** in `generateWorkspaceConfig.js` so every
  music-video profile routes its video pass to `music-video-shot-ltx23` (the
  storyboard pass still picks between `z-image-turbo` / `nano-banana-2`).
- **Added `music-video-shot-ltx23` to `SINGLE_VIDEO_WORKFLOW_IDS`** so output
  import + single-video handling in `runJob` treats it like the other i2v
  workflows.
- **Ripped out the old `yoloMusic*` placeholder state** (title/subject/palette
  /storyIdea/shotsPerScene/anglesPerShot/takesPerAngle) and the
  `buildMusicVideoScriptFromLyrics` / `buildMusicVideoStyleNotes` helpers.
  Nothing in Ad Creation referenced any of it — verified by grep across the
  whole codebase before deletion.
- **New state** on `GenerateWorkspace.jsx`: `yoloMusicAudioAssetId`,
  `yoloMusicAudioKind`, `yoloMusicLyrics`, `yoloMusicCreativePreset`,
  `yoloMusicConcept`, `yoloMusicStyleNotes`, `yoloMusicBRollRatio`,
  `yoloMusicPerfWideRatio`, `yoloMusicAvgShotLength`, `yoloMusicTargetDuration`,
  `yoloMusicQualityProfile`, `yoloMusicPlan`, `yoloMusicPlanSignature`. All
  persisted through the existing `persistedState` plumbing.
- **New planner `buildMusicVideoPlan`** emits the shared scene→shot→angles
  plan shape with one shot per scene, plus music-specific payload
  (`musicShotType`, `audioStart`, `length`, `shotPrompt`,
  `referenceImagePrompt`) stapled onto each shot. `normalizeShotForScene` was
  updated to spread unknown shot fields through so the music payload survives
  `normalizeGeneratedYoloPlan` and `normalizePersistedYoloPlan`.
- **Music Video brief UI** replaces the "Coming Soon" banner under
  `directorSubTab === 'plan-script'` when `yoloCreationType === 'music'`:
  song-audio dropdown, audio-kind picker (`vocal_stem` / `mixed_track` /
  `instrumental`), lyrics textarea, concept + style-notes textareas, creative
  preset picker that snaps ratios+avg shot length to preset defaults, and
  three sliders (b-roll ratio / wide-shot ratio / avg shot length).
- **Music Video setup** under `directorSubTab === 'setup'` simplifies Ad's
  structure/quality/references down to a single Target Duration + a 3-button
  quality picker (`draft` / `balanced` / `premium`). The Ad setup is
  preserved intact behind `!isYoloMusicMode`.
- **Shared director sub-tabs** (Setup → Script → Keyframes → Videos) now
  render in music mode too. `yoloActiveShotsPerScene/AnglesPerShot/
  TakesPerAngle` hardcode to `1` for music mode so the shared storyboard +
  video pipeline consume the plan unchanged.
- **Video pass wiring** in `queueYoloVideoVariants`: builds a
  `musicShotByKey` lookup when in music mode, threads
  `normalizeMusicVideoShot({...})` onto each job as `job.musicShot`, plus
  `musicAudioAssetId` + `musicAudioKind` for the audio upload.
- **`runJob` audio upload + switch case:** when `job.workflowId ===
  MUSIC_VIDEO_SHOT_WORKFLOW_ID`, fetch the selected audio asset, upload via
  `comfyui.uploadFile`, then call `modifyMusicVideoShotWorkflow(...)` with
  `inputImage` (the already-uploaded reference still), `inputAudio`
  (uploaded song file), `useVocalsOnly` (true iff `audioKind ===
  'mixed_track'` AND the shot type needs vocal alignment), width/height/fps
  from the job, and `filenamePrefix = 'video/music_shot'`.

### What is explicitly not shipped yet (pick up here)

1. **One-time vocal-extract preprocessing**. Today, when the user picks
   `mixed_track` as the audio kind, every *performance* shot flips the
   workflow's built-in `USE VOCALS ONLY` switch to `true`. That means the
   Mel-Band RoFormer runs *inside* the graph on every shot — slow and costs
   extra VRAM. The plan (still the right one) is:
   - At audio import, ask `vocal_stem` / `mixed_track` / `instrumental`.
   - If `mixed_track`: queue `vocal-extract-melband` once, save the stem as
     a project asset, store both original + stem asset ids on the project.
   - Then the video pass uses the stem directly with `useVocalsOnly: false`,
     saving the RoFormer cost per shot.
   - If `instrumental`: force every planned shot's `needsVocalAlignment` to
     false so the planner picks `performance_wide` or `b_roll` (not close-up
     lip-sync).
   - `src/services/comfyui.js → modifyVocalExtractWorkflow` is already
     written and ready to call.

2. **Dedicated storyboard pass for music video**. Right now the music flow
   reuses the Ad storyboard pass as-is — meaning each shot's reference still
   uses the stock Ad prompt template (`buildYoloPlanFromScript` builds a
   generic keyframe prompt). The music planner does produce a per-shot
   `referenceImagePrompt`, but the stills pass isn't wired to use it yet. A
   small, focused change in `flattenYoloPlanVariants` (or a music-mode fork
   of `storyboardPrompt` construction) will pick it up.

3. **Lyrics ASR fallback**. The brief UI shows a note that auto-transcription
   will come later. `caption_qwen_asr_transcription.json` exists and can be
   wired to run against the vocal stem when the user clicks a "don't have
   lyrics" affordance. Low priority — user said ~100% of users will have
   lyrics to paste.

4. **Lyric-to-shot timing alignment**. The v1 planner divides lyrics into
   equal-count blocks and assigns each block to a shot at a running
   `audioStart` offset. Good enough to ship but will drift on songs with
   irregular phrasing (long bridges, tempo changes). A better v2 could
   forced-align lyrics → audio timestamps (e.g. Whisper word-level
   timestamps on the vocal stem), then snap shot boundaries to real line
   starts.

### Design decisions already agreed with user (don't re-litigate)

### Design decisions already agreed with user (don't re-litigate)

- **Stills-first, then videos.** Generate and approve reference stills
  for every shot before burning the video passes. Saves cost and catches
  bad prompts early.
- **One audio per project.** Not per-shot.
- **Vocal extraction is a one-time preprocessing step**, not per-shot.
- **Explicit `shotType` tagging at planning time**, not auto-detected
  via silence/ASR. User agreed this is more predictable.
- **B-roll percentage is a planning-time hint**, not a render-time control.
- **Prompt generation is driven by both the creative brief and the lyrics.**
  ASR is a fallback only — user confirmed ~100% of users will have lyrics
  to paste.
- **Cloud vs local:** the new shot workflow is local-only (24GB+ VRAM) by
  design. There is no cloud equivalent for audio-conditioned lip-sync in
  the registry today. Don't add one speculatively.

### Known gotchas for the future agent

- **LoRA paths have subfolders in the workflow JSON** (e.g.
  `LTX\\LTX-2\\ID-Lora\\LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors`).
  The dep-pack entries use just the basename. If the dependency checker
  does strict equality rather than basename matching, those four LoRAs
  will always report as missing even when installed. First thing to check
  when a user reports "I installed all the LoRAs but setup still says
  they're missing" — trace `src/services/workflowDependencies.js` +
  `workflowSetupManager.js`.
- **Node IDs are hardcoded.** The modifier references nodes `444`,
  `1594`, `1616`, `5100`, `2012`, `1586`, `1606`, `1591`, `1624`, `1626`,
  `1722`, `2116`, `2150`, `2179`, `2169`, `5001`. If the workflow JSON is
  ever re-exported from ComfyUI the IDs can shift. Consider adding a
  sanity-check helper that scans by `_meta.title` as a fallback before
  shipping v2 of the workflow.
- **`ComfySwitchNode` (used for USE VOCALS ONLY).** The input key is
  `switch` (boolean). Easy to assume it's `value` or `enabled` — it's
  not, double-check if behavior is flipped.
- **Seeds are offset between pass 1 and pass 2** (`seed + 1000003`). Do
  not let a UI "set seed" affordance collapse them back to the same value
  or LTX 2.3 detail quality drops noticeably.

### Relevant files

- `src/components/GenerateWorkspace.jsx` — Director Mode / YOLO Music Video UI
- `src/config/musicVideoShotConfig.js` — shot schema + presets + helpers
- `src/services/comfyui.js` — `modifyMusicVideoShotWorkflow`, `modifyVocalExtractWorkflow`
- `public/workflows/music_video_shot_ltx2_3_i2v_audio.json` — the shot workflow
- `public/workflows/vocal_extract_melband.json` — the vocal-extract workflow
- `src/config/generateWorkspaceConfig.js` — where `YOLO_MUSIC_PROFILES` lives (needs the new profile added in step 6)

---

## 3. MCP support roadmap from live Velorn editing sessions

**Added:** 2026-06-29
**Severity:** Product polish / agent capability
**Last touched:** Added MCP workflow discovery, workflow-node validation, and
Generate-from-timeline preparation tools after the launcher/log support pass.

### Shipped in this pass

- `diagnose_comfyui_connection` already identifies the configured ComfyUI
  port, API health, queue state, launcher config, likely install mode, and
  port owner.
- Added `set_comfyui_connection` so an MCP client can preview or apply a
  local port change in Velorn settings.
- Added `repair_comfyui_connection` so an MCP client can detect "configured
  port broken, another local ComfyUI port works" and propose the exact fix
  first. It defaults to `previewOnly: true`; applying requires an explicit
  `previewOnly: false` call.
- The setter changes Velorn settings only. It does not restart ComfyUI
  or edit launcher scripts.
- The setter also syncs the open renderer cache through the normal
  `saveLocalComfyConnectionPort` path, so the running app sees the new port
  without needing the Settings panel open.
- Added `control_comfyui_launcher` for preview/apply start, stop, and restart
  through the existing Velorn launcher. It defaults to preview-only and
  refuses unsafe external-process stop/restart cases.
- Added `get_comfyui_launcher_logs` for read-only recent launcher logs with a
  lightweight issue summary for port conflicts, Python import errors, custom
  node load errors, missing files/models, and CUDA memory errors.
- Added `list_velorn_workflows` so MCP clients can discover bundled
  workflow ids, categories, local/cloud runtime, image requirements, and source
  files without opening the Generate tab.
- Added `inspect_velorn_workflow` so MCP clients can inspect a bundled or
  explicit workflow JSON, extract required `class_type` node names, validate
  them against the configured local ComfyUI `/object_info`, and return mapped
  install/update hints for missing nodes.
- Added `prepare_generation_from_timeline_context` so MCP clients can preview
  and then apply a safe Generate-tab setup from the selected clip or playhead
  frame. Applying captures the frame and opens/prefills Generate.
- Added `queue_prepared_generation` so MCP clients can inspect the staged
  Generate request and, after explicit approval, queue it through the same path
  as the normal Velorn Queue button. It defaults to preview-only and
  requires a prepared timeline frame by default.
- Added `queue_timeline_generation_batch` so MCP clients can preview and then
  queue multiple WAN 2.2/LTX 2.3 image-to-video variations from one selected
  clip or playhead frame. Counts are flexible per workflow, capped to avoid
  accidental huge render batches, and apply still uses the normal Generate
  queue path.
- Added `queue_prompt_generation_batch` so MCP clients can preview and then
  queue prompt-only text-to-image/text-to-video jobs without needing a
  timeline frame. This is the first "brief to generated assets" building
  block for agents that create source images/videos before assembling a
  sequence.
- Added `create_asset_folder` so MCP clients can preview and then create
  asset-panel folders or nested folder paths. Prompt generation batches can
  target the returned folder ID so AI-created source assets do not all land in
  the project root/default generated folders.
- Added `move_assets_to_folder` so MCP clients can preview and then organize
  existing assets into folders. It supports explicit asset IDs/names plus safe
  filters such as `rootOnly` and `constantsOnly`, and can create the missing
  destination folder on apply.

### Next MCP additions worth considering

1. **Launcher port alignment.** Extend repair to notice launcher `extraArgs`
   such as `--port 8190` when Velorn is set to `8188`, then propose
   either changing Velorn or changing launcher args. This should be
   opt-in because it edits startup behavior.

2. **Safe settings mutation pattern.** For any future MCP setting write,
   follow the same shape: preview result, before/after values, narrow scope,
   no process restart by default, explicit apply call, and renderer cache
   sync when the app is already open.

3. **Generate result placement.** Added `add_asset_to_timeline` so an MCP
   agent can preview and then place a specific/latest video, image, or audio
   asset on the active timeline. It can use the playhead, selected clip start
   or end, timeline end, track end, an existing compatible track, or a new top
   video/audio track. Added `add_assets_to_timeline` for preview-first batch
   placement of explicit assets or latest matching generated assets as stacked
   review lanes or a sequential strip. Next useful layer: replace a selected
   source clip with the chosen generated variation.

4. **Visual clip keyframes.** Added `set_clip_keyframes` so an MCP agent can
   preview and then apply opacity, transform, blur, crop, and color-adjustment
   keyframes to existing visual clips. This is the foundation for natural
   requests like "fade these clips down to black," "move this layer north,"
   "blur in over 12 frames," or "animate this crop reveal." Next useful layer:
   a higher-level dip/fade helper that combines solids and opacity keyframes
   into one previewable operation.

5. **Solid color constants.** Added `add_solid_color` so an MCP agent can
   preview and then create a solid-color PNG asset, optionally placing it on
   the active timeline. New solids default to a bottom video track when the
   tool creates a track, which makes black/color plates useful underneath
   opacity fades instead of accidentally covering the edit.

6. **Sequence/timeline creation.** Added `create_timeline` so an MCP agent can
   preview and then create a named sequence/timeline, optionally inheriting the
   current timeline dimensions/fps and switching into the new sequence before
   placing generated assets, solids, titles, or review layouts.

7. **Prompt generation batches.** Added `queue_prompt_generation_batch` so an
   MCP agent can turn a written brief into a small, approved set of source
   image/video generation jobs. Added `create_asset_folder` so the same pass can
   create a named output folder first and pass its `folderId` into the batch.
   Next useful layer: a higher-level storyboard planner prompt/pass that
   recommends prompts first, waits for generated assets, then uses
   `create_timeline`, `add_assets_to_timeline`, `add_text_clip`,
   `set_clip_keyframes`, and `inspect_timeline_range` to assemble a review cut.

8. **Asset cleanup and organization.** Added `move_assets_to_folder` so an MCP
   agent can clean up the asset panel after it creates solids/constants,
   generated sources, or imported media. Useful prompt: "Move all root-level
   constants into a Constants folder; preview first."

### Relevant files

- `electron/main.js` - ComfyUI diagnostics, settings persistence, launcher
  integration, and MCP server wiring.
- `electron/mcpServer.js` - MCP tool schemas and repair orchestration.
- `src/services/mcpActions.js` - renderer-side MCP action bridge.
- `src/services/localComfyConnection.js` - canonical renderer save/cache path
  for the local ComfyUI endpoint.
- `src/components/SettingsModal.jsx` - visible MCP tool list.

---
