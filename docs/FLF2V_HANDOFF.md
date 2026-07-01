
# Feature: Right-Click "Fill Gap (FLF2V)" on Timeline

## Goal

In ComfyStudio's timeline, when there is a gap between two clips on the same
video track, right-clicking that gap should show a context menu item
"Fill Gap (FLF2V)". Selecting it must:

1. Capture the **last frame** of the clip immediately before the gap.
2. Capture the **first frame** of the clip immediately after the gap.
3. Send both frames to the Generate workspace, pre-selecting a local Wan 2.2
   14B First-Last-Frame-to-Video (FLF2V) workflow, with the generation
   length pre-filled to match the gap duration.
4. After generation completes, insert the resulting video clip directly into
   the gap on the same track, replacing the gap.

This must reuse existing app architecture, not invent a new one. The codebase
already has every primitive needed except the FLF2V workflow itself and the
gap-specific UI wiring. Do not build a parallel system.

## Repo

Clone fresh into the current folder (where this file lives):

```bash
git clone https://github.com/JaimeIsMe/comfystudio.git
cd comfystudio
npm install
```

Work on a branch:

```bash
git checkout -b feature/fill-gap-flf2v
```

## Relevant existing architecture (read these files first, in this order)

1. `src/stores/timelineStore.js` — clip/gap/track state. Search for
   `getTrackGapAtTime`-style logic (it actually lives in `Timeline.jsx`, see
   below) and `addClip`, `removeClip`/gap-closing helpers.
2. `src/components/Timeline.jsx` — this is the largest file and owns:
   - `getTrackGapAtTime(trackId, time)` (~line 796): returns
     `{ trackId, startTime, endTime }` for the gap at a given time on a
     track, or `null`. This is the function to call to find the gap's clip
     neighbors.
   - `selectedGap`, `selectGap`, `rippleDeleteSelectedGap` — gaps are already
     first-class selectable timeline objects.
   - `handleTrackLaneContextMenu` (~line 871) — right-click handler for
     empty/lane space, already calls `getTrackGapAtTime` to detect if the
     click landed on a gap. Currently it does NOT open a context menu for
     gaps (only sets up lane pointer/selection state) — this needs to be
     extended to show a menu with a "Fill Gap (FLF2V)" action when a gap is
     right-clicked.
   - `handleClipContextMenu` / `clipContextMenu` state / `handleContextMenuAction`
     (~lines 3200-3360) — this is the existing pattern for a right-click
     context menu with actions on a clip. Model the new gap context menu on
     this exact pattern (local `gapContextMenu` state: `{ x, y, gap }`,
     a ref, `useViewportClampedPosition`, click-outside-to-close effect, and
     a render block near where `clipContextMenu` is rendered, ~line 6414).
3. `src/utils/captureTimelineFrame.js` — already has
   `getTopmostVideoOrImageClipAtTime(time)` and `getSourceTimeForClip(clip, timelineTime)`
   plus a `renderTimelineCompositeStill(time, canvas, width, height)` function
   that rasterizes the frame at a given timeline time to a canvas. This is
   the exact utility to call twice: once at `gap.startTime - epsilon`
   (last frame of the clip before) and once at `gap.endTime + epsilon`
   (first frame of the clip after). Read the full file before using it,
   it has more helpers below the part already shown.
4. `src/stores/frameForAIStore.js` — a zustand store holding a single
   `{ blobUrl, file, mode }` frame object consumed by Generate workspace.
   Currently only supports one frame (`mode: 'extend' | 'keyframe'`). This
   store needs a new shape to carry TWO frames for FLF2V — do not break the
   existing single-frame consumers (`PreviewPanel.jsx`,
   `GenerateWorkspace.jsx`). Recommended: add a new mode `'flf2v'` and allow
   the stored object to optionally include `startFrame` and `endFrame`
   (each `{ blobUrl, file }`), and a `targetDurationSeconds` field for the
   gap length. Keep backward compatibility with the existing single-frame
   shape used by `extend`/`keyframe` modes.
5. `src/components/PreviewPanel.jsx` (~line 261) — existing example of
   capturing a still frame and calling `setFrameForAI` from the preview
   panel's own context menu. Read this end to end as the reference
   implementation for "capture frame, push to store, switch tabs."
6. `src/components/GenerateWorkspace.jsx` (~line 3479-3510) — consumes
   `frameForAI` via a `useEffect` that does:
   ```js
   useEffect(() => {
     if (frameForAI) {
       setCategory('video')
       setWorkflowId('wan22-i2v')
       setFormError(null)
     }
   }, [frameForAI?.blobUrl])
   ```
   This needs a new branch: if `frameForAI.mode === 'flf2v'`, set
   `setWorkflowId('wan22-flf2v')` (the new workflow id you are registering,
   see below) instead of `'wan22-i2v'`, and pre-populate the
   `firstFrameAsset` / `lastFrameAsset` / `duration` form fields from
   `frameForAI.startFrame`, `frameForAI.endFrame`, and
   `frameForAI.targetDurationSeconds`. Find how `wan22-i2v`'s single frame
   currently gets attached to its `image`-type field for the same effect, and
   mirror that for two fields instead of one.
   Also find (search this file for `frameForAI` near line 11430) the second
   usage of `useFrameForAIStore.getState().frame` — that is likely where the
   captured frame is actually converted into a usable asset/file for the
   workflow's input field. Trace this carefully; the new FLF2V path must do
   the same asset-registration step for both frames.
7. `src/config/workflowRegistry.js` — `BUILTIN_WORKFLOWS` array. Already
   contains a cloud FLF2V entry for reference:
   ```js
   { id: 'seedance2-flf2v', label: 'First/Last Frame to Video (Seedance 2.0)', category: 'video', needsImage: false, description: 'Cloud first-frame/last-frame video with ByteDance Seedance 2.0', file: 'api_seedance2_0_flf2v.json' },
   ```
   and the existing local Wan 2.2 i2v entry:
   ```js
   { id: 'wan22-i2v', label: 'Image to Video (WAN 2.2)', category: 'video', needsImage: true, description: 'Animate an image into video', file: 'video_wan2_2_14B_i2v.json' },
   ```
   Add a new entry, `wan22-flf2v`, modeled on these two, pointing at a new
   bundled workflow JSON file `video_wan2_2_14B_flf2v.json` (see "Workflow
   JSON" section below). `needsImage` should be `false` (it needs two
   images, not the single generic "image" the form system expects for
   `needsImage: true` workflows — follow the same pattern Seedance's FLF2V
   entry uses).
8. `src/config/generateWorkflowCatalog.js` — has an existing
   `firstLastFrameVideoFields` schema (~line 96) already built for Seedance's
   cloud FLF2V workflow:
   ```js
   const firstLastFrameVideoFields = Object.freeze([
     field('firstFrameAsset', { label: 'First frame', type: 'assetSelect', assetType: 'image', required: true, helper: '...' }),
     field('lastFrameAsset', { label: 'Last frame', type: 'assetSelect', assetType: 'image', required: true, helper: '...' }),
     field('prompt', { label: 'Prompt', type: 'textarea' }),
     field('duration', { label: 'Duration', type: 'duration' }),
     field('resolution', { label: 'Resolution', type: 'resolution' }),
     field('seed', { label: 'Seed', type: 'seed' }),
   ])
   ```
   Reuse this exact `firstLastFrameVideoFields` array for the new catalog
   entry (do not duplicate it into a near-identical local-only variant
   unless the local Wan workflow truly needs different fields — check
   whether Wan 2.2 FLF2V needs a `clip_vision` toggle field; if so, extend
   `firstLastFrameVideoFields` with an optional field rather than forking
   it). Add a new catalog object modeled exactly on the existing
   `wan22-i2v` entry (local, route: 'local', provider: 'Local',
   runtimeLabel: '24GB+ recommended') but with `id`/`workflowId`:
   `'wan22-flf2v'`, `fields: firstLastFrameVideoFields`, and an appropriate
   `title`/`description`/`tags` (include `'flf2v'`, `'first frame'`,
   `'last frame'`, `'wan'`, `'local'`).

## Workflow JSON to add

`public/workflows/video_wan2_2_14B_flf2v.json`

This repo already ships `public/workflows/video_wan2_2_14B_i2v.json` and
`video_wan2_2_14B_t2v.json` as references for the ComfyUI API-format JSON
structure this app expects (graph of nodes with class_type, inputs, widget
values — NOT the UI-format workflow export). Open
`video_wan2_2_14B_i2v.json` first to learn the exact node graph shape ComfyUI
desktop already had loaded.

The new FLF2V json must use the `WanFirstLastFrameToVideo` node
(`comfy_extras/nodes_wan.py` in a standard ComfyUI install — already
confirmed present, no custom node required) in place of whatever node
`video_wan2_2_14B_i2v.json` uses for single-image conditioning. Inputs to
wire: `positive`, `negative`, `vae`, `width`, `height`, `length`,
`batch_size`, optional `start_image`/`end_image` (wire these from two
`LoadImage`-equivalent input nodes), optional `clip_vision_start_image`/
`clip_vision_end_image`.

The exact safest approach: take the already-confirmed-working FLF2V workflow
the user built themselves locally in ComfyUI (exported via
"Save (API Format)" from the ComfyUI canvas) and use that JSON verbatim
as `video_wan2_2_14B_flf2v.json`, only renaming/aliasing input node titles if
needed so this app's existing input-mapping logic (used for `wan22-i2v`,
look at how that workflow's JSON marks its image input node so the app knows
where to inject the uploaded image — likely a `"title"` or `"_meta"` field
on the relevant node) can find and set `start_image` / `end_image` /
`length` programmatically. Locate this convention by diffing
`video_wan2_2_14B_i2v.json` against how `wan22-i2v`'s `needsImage: true`
field gets consumed in `comfyWorkflowGraph.js` or `comfyui.js`
(`grep -n "needsImage\|injectImage\|setNodeInput" src/services/comfyWorkflowGraph.js src/services/comfyui.js`)
before writing the new JSON, so the node titling matches what the input-
injection code expects.

## Gap fill flow — new code

### 1. Gap context menu (`Timeline.jsx`)

- Add `const [gapContextMenu, setGapContextMenu] = useState(null) // { x, y, gap }`
  alongside the existing `clipContextMenu` state.
- In `handleTrackLaneContextMenu`, when `getTrackGapAtTime` returns a real
  gap (duration > 0.001s) on right-click, call `e.preventDefault()` and
  `setGapContextMenu({ x: e.clientX, y: e.clientY, gap })` instead of (or in
  addition to) the current lane-pointer-state logic. Follow the exact
  click-outside-closes and viewport-clamped-position pattern already used
  for `clipContextMenu`.
- Render a small menu with one action: "Fill Gap (FLF2V)". Disable/hide it
  if either neighboring clip is not a video/image clip (audio-only gaps
  should not show this action).

### 2. Frame capture on action click

When "Fill Gap (FLF2V)" is clicked, with `gap = { trackId, startTime, endTime }`:

```js
const EPS = 1 / timelineFps // one frame, avoid landing exactly on the boundary clip's edge case
const lastFrameTime = gap.startTime - EPS
const firstFrameTime = gap.endTime + EPS
```

Use `renderTimelineCompositeStill` (or the single-clip variant if a
non-composited single-clip capture is more correct here — check whether
`captureTimelineFrame.js` exports a clip-only capture helper as well as the
composite one) at both times to get two canvases/blobs. Convert each to a
`File`/`blobUrl` the same way `PreviewPanel.jsx`'s existing
"capture frame for AI" action does it (read that code path fully — it
already solves canvas-to-blob-to-File).

### 3. Extend `frameForAIStore.js`

Add support for a two-frame payload without breaking existing single-frame
consumers:

```js
setFrame: (frame) => set({ frame }),
```

Frame shape for the new mode:

```js
{
  mode: 'flf2v',
  startFrame: { blobUrl, file },
  endFrame: { blobUrl, file },
  targetDurationSeconds: gap.endTime - gap.startTime,
  targetTrackId: gap.trackId,
  targetGapStartTime: gap.startTime, // needed later to know where to insert the result
}
```

Call `useFrameForAIStore.getState().setFrame(...)` with this shape from the
new gap-fill handler in `Timeline.jsx`, then switch the active right panel /
tab to Generate (find how `PreviewPanel.jsx` switches tabs after capturing a
frame for AI — likely a prop callback or a UI store action — and reuse it).

### 4. Consume the two-frame mode in `GenerateWorkspace.jsx`

In the existing effect at ~line 3479:

```js
useEffect(() => {
  if (!frameForAI) return
  if (frameForAI.mode === 'flf2v') {
    setCategory('video')
    setWorkflowId('wan22-flf2v')
    // populate firstFrameAsset / lastFrameAsset / duration form fields here,
    // following whatever pattern the existing single-image branch below uses
    // to turn frameForAI.file into a usable assetSelect value.
    setFormError(null)
    return
  }
  setCategory('video')
  setWorkflowId('wan22-i2v')
  setFormError(null)
}, [frameForAI?.blobUrl, frameForAI?.mode])
```

Trace exactly how the existing single-frame branch sets the `image` field's
form value from `frameForAI.file` (it likely registers the file as a
temporary asset via `addAsset` from `assetsStore.js`, then sets the field
value to that new asset's id). Do this twice — once for `startFrame` into
`firstFrameAsset`, once for `endFrame` into `lastFrameAsset` — and set the
`duration` field from `frameForAI.targetDurationSeconds`.

### 5. Insert the result back into the gap

After the FLF2V generation completes and the user accepts/queues the output
(follow whatever existing "send generated video to timeline" action already
exists for other local video workflows — search `GenerateWorkspace.jsx` for
`timelineAddClip` usage), the resulting clip should NOT just be appended to
the timeline like a normal generation. It must be inserted with
`startTime: frameForAI.targetGapStartTime` on `frameForAI.targetTrackId`,
replacing the gap exactly. Check `timelineAddClip`'s signature in
`timelineStore.js` for how to specify an explicit `trackId` and `startTime`
rather than appending at the playhead. If the generated clip's duration
doesn't exactly match `targetDurationSeconds` (likely, since Wan generates in
fixed frame-count chunks), trim it to fit or leave a residual gap/overlap and
warn the user in a toast/notification rather than silently breaking the
timeline.

After successful insertion, call `useFrameForAIStore.getState().clearFrame()`
to release the blob URLs (existing store already does `URL.revokeObjectURL`
in `clearFrame`).

## Build

After implementation, build the Electron app for Linux:

```bash
npm run build
npm run electron:build:linux
```

Artifacts land in `release/`. If Docker is preferred (per the repo's own
docs) for a clean native Linux build instead of the host toolchain:

```bash
./scripts/docker-build-linux.sh
```

## Acceptance criteria

- Right-clicking a gap between two video clips on the same track shows a
  context menu with "Fill Gap (FLF2V)" (and only that gap-fill action — do
  not add unrelated menu items).
- Clicking it captures correct last/first frames from the two neighboring
  clips (verify visually against the actual frames, not black/blank
  captures).
- Generate workspace opens already configured: video category, the new
  `wan22-flf2v` workflow selected, both frame fields populated, duration
  field matching the gap length.
- Running generation produces a video and, once accepted, that video is
  inserted exactly into the original gap's position and track — no
  duplicate clips, no leftover gap markers, no shifted neighboring clips.
- Existing single-frame "extend"/"keyframe" flows (`PreviewPanel.jsx` →
  `wan22-i2v`) still work unmodified.
- `npm run electron:build:linux` succeeds and produces a runnable AppImage
  or `.deb` in `release/`.
---

## Current State (Handoff Notes — 2026-06-19)

Branch: `feature/fill-gap-flf2v` in `/home/y/.App/ComfyStudio/comfystudio/`
Latest commit: `c14154b fix(flf2v): fall back to ffmpeg-static via IPC for HEVC/unsupported codecs`

### What works (verified end-to-end)

Right-click on a gap between two video clips on the timeline → "Fill Gap (FLF2V)" →
- captures the last frame of the clip before the gap (single-clip capture, robust against HEVC/AV1/etc. via ffmpeg fallback)
- captures the first frame of the clip after the gap
- dispatches a frame payload to the Generate workspace where the bundled Wan 2.2 14B FLF2V workflow is pre-selected and a self-contained "Flf2vDraftCard" shows the previews + form
- user clicks "Queue Video" → frames upload to ComfyUI, prompt is queued with the form's width/height/fps/duration + prompt + negative prompt, polled to completion, downloaded
- result is saved into the project's `assets/video/` via `importAsset`, gets `absolutePath` + `url` + duration/fps/width/height set, `generateAssetPoster` + `generateAssetSprite` fire for thumbnail/scrubber, then inserted into the timeline gap with `timelineStore.addClip` at `targetGapStartTime` on `targetTrackId`
- after success the card switches the tab back to editor so the user lands on the timeline and sees the freshly-inserted clip
- the card stays open (no auto-clear) so the user can re-queue with different params if the output is wrong

The "Change workflow" button on the card opens an inline popover with the bundled profile + an "Import JSON file..." option (auto-detects the FLF2V schema from the imported JSON's node types). Selection persists to localStorage so reopening the app keeps the same workflow.

### Bug fixes applied along the way (final commit history)

| commit | what it fixed |
| --- | --- |
| `a4b78b2` | initial FLF2V feature (right-click → fill → splice) |
| `ee9ebed` | reset per-job state on new frameForAI so 2nd fill wasn't stuck in previous run's "Done" |
| `72b3005` | state-ref for gapContextMenu inside handler + diagnostic logging |
| `489a1e9` | capture each neighbor clip directly instead of compositing the full timeline (the composite renderer returns false when the requested time lands past a clip edge) |
| `df660bc` | URL-encode file:// paths before setting as video/image src |
| `fa9a9f2` | load clip media via fetch + Blob URL (bypasses Chromium file:// encoding quirks) |
| `c14154b` | fall back to ffmpeg-static via IPC for HEVC/unsupported codecs |

### Root causes (in order they were diagnosed)

1. **prompt_id extraction always falsy** — `comfyui.queuePrompt()` returns the prompt_id string directly, not `{ prompt_id }`. Fixed: `const promptId = await comfyui.queuePrompt(workflow)`.
2. **Swapped start/end frame wiring** — WanFirstLastFrameToVideo's `start_image` / `end_image` inputs pointed at the wrong LoadImage nodes. Fixed in `wan22Flf2v.js`.
3. **"No videos" after success** — ComfyUI's `SaveVideo` node reports output under `images` with `animated: [true]`, not `videos`. Fixed: `collectVideoOutputs` checks the `images + animated` path.
4. **Inserted clip blank in timeline** — `importAsset()` returns an asset with `absolutePath` but no `url` field; `timelineStore.addClip` reads `asset.url` for both source and thumbnail. Fixed: resolved the URL via `getAbsoluteFileUrl(asset.absolutePath)` before calling addClip.
5. **Inserted clip 5s blank for a 2.5s gap** — same root cause as #4; with proper URL + duration + fps set on the asset, addClip used the real duration.
6. **No thumbnail generated** — `AssetsPanel`'s import path auto-fires `generateAssetPoster` + `generateAssetSprite` after `importAsset`; Flf2vDraftCard was bypassing that. Fixed by calling both explicitly.
7. **Tab return to editor on completion** — added a `comfystudio-switch-tab` custom event + a generic handler in `App.jsx`.
8. **Second gap fill did nothing** — multiple distinct causes, fixed in sequence (see commits ee9ebed, 72b3005, 489a1e9).
9. **HEVC clip capture failure** — Chromium on Linux has no H.265 decoder; `<video>` element fires `onerror` with `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`. Fixed by adding `media:extractFrame` IPC handler in `electron/main.js` that uses ffmpeg-static to extract a single PNG frame as fallback.

### Key files for the next agent

1. `/home/y/.App/ComfyStudio/comfystudio/src/components/Flf2vDraftCard.jsx` — the submit card (no catalog dependency, reads a profile)
2. `/home/y/.App/ComfyStudio/comfystudio/src/components/Flf2vWorkflowPicker.jsx` — bundled + import picker
3. `/home/y/.App/ComfyStudio/comfystudio/src/services/builtinWorkflows/wan22Flf2v.js` — bundled workflow JSON + node ID map (swap start/end fix is in here)
4. `/home/y/.App/ComfyStudio/comfystudio/src/services/builtinWorkflows/flf2vProfiles.js` — registry + auto-detect for imported JSON
5. `/home/y/.App/ComfyStudio/comfystudio/src/utils/captureTimelineFrame.js` — `captureGapBoundaryFrames`, `captureSingleClipFrame`, `loadClipSourceAtTime` (with blob URL + ffmpeg fallback), `encodeFileUrl`, `filePathFromFileUrl`
6. `/home/y/.App/ComfyStudio/comfystudio/src/components/Timeline.jsx` — `handleFillGapFlf2v` (the right-click action), uses state-ref for gapContextMenu
7. `/home/y/.App/ComfyStudio/comfystudio/electron/main.js` — `media:extractFrame` IPC handler (ffmpeg fallback)
8. `/home/y/.App/ComfyStudio/comfystudio/electron/preload.js` — exposes `window.electronAPI.extractVideoFrame`
9. `/home/y/.App/ComfyStudio/comfystudio/src/App.jsx` — `comfystudio-switch-tab` listener (switches the main tab to whatever name is in `event.detail.tab`)
10. `/home/y/.App/ComfyStudio/comfystudio/src/stores/frameForAIStore.js` — extended with `mode: 'flf2v'` payload shape (startFrame, endFrame, targetDurationSeconds, targetTrackId, targetGapStartTime)

### Fork & PR

- Working repo (fork): https://github.com/asgitcode-tech/comfystudio
- Original: https://github.com/JaimeIsMe/comfystudio
- Open a PR back to the original at: https://github.com/JaimeIsMe/comfystudio/compare/main...asgitcode-tech:feature/fill-gap-flf2v?expand=1
- PR title: `Fill Gap (FLF2V) — generate video between two clips using Wan 2.2 14B`
- PR body (verbatim):

  ```
  I pushed my fork with this change, please review:
  https://github.com/JaimeIsMe/comfystudio/compare/main...asgitcode-tech:feature/fill-gap-flf2v?expand=1

  Adds a right-click "Fill Gap (FLF2V)" action on the timeline. When you
  right-click the gap between two video clips, it captures the last frame
  of the clip before and the first frame of the clip after, opens the
  Generate workspace with the bundled Wan 2.2 14B first/last-frame
  workflow pre-selected, and splices the resulting video back into the
  original gap on completion.

  Also removes the quit-time prompt asking whether to stop or leave ComfyUI
  running — ComfyUI now stays running across ComfyStudio restarts by
  default.

  Includes a workflow picker so users can switch between bundled and
  imported FLF2V workflow JSONs (selection persists across restarts).

  14 files changed: 2013+ insertions, 59 deletions.
  Branch: feature/fill-gap-flf2v
  ```

### Sanity-check after rebuild

```bash
# Extract app.asar and verify the ffmpeg fallback + blob URL code is in
npx --yes @electron/asar extract /opt/ComfyStudio/resources/app.asar /tmp/asar_check
python3 -c "
import glob
txt = open(glob.glob('/tmp/asar_check/dist/assets/index-*.js')[0]).read()
print('extractVideoFrame:', 'extractVideoFrame' in txt)
print('DEMUXER_ERROR handled:', 'DEMUXER_ERROR' in txt or 'no supported streams' in txt)
print('encodeFileUrl present:', 'encodeURIComponent' in txt)
"
grep -c 'media:extractFrame' /tmp/asar_check/electron/main.js   # expect 1
grep -c 'extractVideoFrame' /tmp/asar_check/electron/preload.js   # expect 1
```

### Build commands (host, no Docker)

```bash
cd /home/y/.App/ComfyStudio/comfystudio
npm run build                                    # vite build only

# Electron mirror (if not already running):
mkdir -p /tmp/electron-mirror/28.3.3
ln -sf /home/y/Downloads/electron-v28.3.3-linux-x64.zip /tmp/electron-mirror/28.3.3/electron-v28.3.3-linux-x64.zip
nohup python3 -m http.server 8765 --directory /tmp/electron-mirror &
# Build:
ELECTRON_MIRROR="http://127.0.0.1:8765/" npm run electron:build:linux

# Install:
sudo dpkg -i release/ComfyStudio-0.1.20-linux-amd64.deb
```

---

## Current State (Handoff Notes — 2026-06-18, superseded by the section above)

Branch: `feature/fill-gap-flf2v` in `/home/y/.App/ComfyStudio/comfystudio/`

### Build artifacts (current)

- `/home/y/.App/ComfyStudio/comfystudio/release/ComfyStudio-0.1.20-linux-amd64.deb`
- `/home/y/.App/ComfyStudio/comfystudio/release/ComfyStudio-0.1.20-linux-x86_64.AppImage`
- Install with: `sudo dpkg -i /home/y/.App/ComfyStudio/comfystudio/release/ComfyStudio-0.1.20-linux-amd64.deb`
- Latest `app.asar` md5: must be re-verified after every build.

### What works

1. **Timeline right-click → "Fill Gap (FLF2V)" context menu** — implemented in `src/components/Timeline.jsx`:
   - `gapContextMenu` state (x, y, gap), viewport-clamped position
   - `isGapFillable(gap)` — checks both neighbours are video/image clips
   - `handleFillGapFlf2v()` — captures `gap.startTime - 1/fps` and `gap.endTime + 1/fps` via `captureTimelineFrameAt`, sets `frameForAI` to mode `'flf2v'`
   - Dispatches `comfystudio-open-generate-with-frame` (handled in `src/App.jsx` to switch main tab to Generate)

2. **Frame-capture store** — `src/stores/frameForAIStore.js` extended with `mode: 'flf2v'` payload shape:
   ```js
   { mode: 'flf2v',
     startFrame: { blobUrl, file },
     endFrame:   { blobUrl, file },
     targetDurationSeconds,
     targetTrackId,
     targetGapStartTime }
   ```
   `clearFrame()` revokes all blob URLs.

3. **Generate workspace card** — `src/components/Flf2vDraftCard.jsx` (new file, ~430 lines):
   - Self-contained — does NOT go through the catalog.
   - Renders two captured-frame previews, gap duration badge, prompt textarea, width/height/seed inputs, **Queue Video** button.
   - Bundled workflow JSON inline at `src/services/builtinWorkflows/wan22Flf2v.js` (built from the user's tested `▶️ Video FLF.json`).

4. **Submit flow** — at Queue:
   1. Uploads both frames to ComfyUI via `comfyui.uploadFile()`
   2. Deep-clones bundled workflow JSON
   3. Mutates inputs in memory: image filenames, prompt text, negative text, length, fps, seed, filename_prefix
   4. `comfyui.queuePrompt(workflow)` → `promptId`
   5. Polls `/history/<promptId>` every 2s
   6. On done: downloads the output video, registers it as an asset, splices it into the original gap via `timelineStore.addClip(targetTrack.id, newAsset, gap.startTime, fps, {...})`, calls `clearFrameForAI()`.

5. **Quit prompt suppressed** — `electron/main.js` — both `mainWindow.on('close')` and `app.on('before-quit')` now unconditionally `comfyLauncher.detach()` instead of showing the "Stop ComfyUI / Leave ComfyUI / Cancel" dialog. ComfyUI stays running across ComfyStudio restarts.

6. **Models bundled by user** at `/home/y/ComfyUI/models/` — same files the workflow references:
   - `clip/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
   - `vae/wan_2.1_vae.safetensors`
   - `unet/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` + `_low_noise_`
   - `loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` + `_low_noise_`

### What still does NOT work — current blocker

After clicking **Queue Video**, the new error is:

> `Prompt outputs failed validation Node 94 (CreateVideo) [exception_during_inner_validation] Exception when validating inner node — '-8'`

### Why it fails — root cause history

The bundled workflow at `src/services/builtinWorkflows/wan22Flf2v.js` is **derived from the user's UI workflow `▶️ Video FLF.json`** at `/home/y/ComfyUI/user/default/workflows/▶️ Video FLF.json`. That UI workflow has TWO WanFirstLastFrameToVideo pipelines (A=4-step lightx2v, B=20-step lightx2v) sharing most helper nodes. **Pipeline A is the active one.**

Earlier iterations of the conversion picked the wrong half:

- **First try (broken)**: Picked node 81 (which is WanFLF2V for pipeline B). Node 81 lacked the `width/height/length/batch_size` widget values in the API format, so WanFirstLastFrameToVideo had nothing to render against. **Error**: `KSamplerAdvanced (node 85) — tuple index out of range`.

- **Second try (still broken)**: Switched to node 67 (WanFLF2V for pipeline A, correct choice), but **failed to remap the VAEDecode node**. The user's pipeline A actually uses VAEDecode `node 8` (canonical 87) — not node 85 (which is the pipeline B VAEDecode). The CreateVideo `node 60` (canonical 94) was wired to receive images from `node 8`, but the conversion kept `images: ["8", 0]` (literal original ID) instead of remapping to `"87", 0`. So at submit time, ComfyUI received `images: ["8", 0]` referring to a node that doesn't exist in the bundled graph. **Current error**: `CreateVideo (node 94) — '-8'`.

### The fix that needs to land

The bundled workflow at `src/services/builtinWorkflows/wan22Flf2v.js` must have CreateVideo's `images` input remapped from `["8", 0]` to `["87", 0]`, AND the bundled JSON must include node 87 (VAEDecode) wired from KSampler 85's `samples` output and VAELoader 90's `vae` output.

The current bundled JSON file (`src/services/builtinWorkflows/wan22Flf2v.js`) is regenerated by the Python conversion script at `/tmp/convert.py` (the canonical-remap version that produces the correct graph). After regenerating, the inline export in the JS module is `export const WAN22_FLF2V_WORKFLOW_JSON = { ... }` followed by `export const WAN22_FLF2V_NODES = { ... VAE_DECODE: '87', ... }`.

**Verify after build** that node 87 in the bundled JSON has `inputs.samples: ["85", 0]` and `inputs.vae: ["90", 0]`, and node 94 has `inputs.images: ["87", 0]` (NOT `["8", 0]`).

### Files touched by this feature

```
M src/components/GenerateWorkspace.jsx       # removed catalog wiring, added Flf2vDraftCard import
M src/components/Timeline.jsx                # added gap context menu + fill handler
M src/config/generateWorkflowCatalog.js     # removed wan22-flf2v entry
M src/config/workflowRegistry.js            # removed wan22-flf2v entry
M src/services/comfyui.js                    # removed modifyWan22FLF2VWorkflow dispatch
M src/stores/frameForAIStore.js             # extended with flf2v mode
A src/components/Flf2vDraftCard.jsx         # NEW — self-contained submit card
A src/services/builtinWorkflows/wan22Flf2v.js  # NEW — bundled workflow JSON
M electron/main.js                           # removed quit prompt
M public/workflows/video_wan2_2_14B_flf2v.json  # still exists, unused
```

### Build commands (host, no Docker)

```bash
cd /home/y/.App/ComfyStudio/comfystudio
npm run build                                    # vite build only

# Full electron build (needs local mirror at 8765 serving electron-v28.3.3-linux-x64.zip)
# Mirror:
mkdir -p /tmp/electron-mirror/28.3.3
ln -sf /home/y/Downloads/electron-v28.3.3-linux-x64.zip \
       /tmp/electron-mirror/28.3.3/electron-v28.3.3-linux-x64.zip
nohup python3 -m http.server 8765 --directory /tmp/electron-mirror &
# Build:
ELECTRON_MIRROR="http://127.0.0.1:8765/" npm run electron:build:linux

# Install:
sudo dpkg -i release/ComfyStudio-0.1.20-linux-amd64.deb
# Then quit ComfyStudio if open and relaunch.
```

### Key files for next agent to read

1. `/home/y/.App/ComfyStudio/comfystudio/src/components/Flf2vDraftCard.jsx` — the submit card (no catalog dependency)
2. `/home/y/.App/ComfyStudio/comfystudio/src/services/builtinWorkflows/wan22Flf2v.js` — bundled workflow JSON
3. `/home/y/.App/ComfyStudio/comfystudio/src/components/Timeline.jsx` (gap context menu + `handleFillGapFlf2v` ~line 945)
4. `/home/y/.App/ComfyStudio/comfystudio/src/stores/frameForAIStore.js` (flf2v payload)
5. `/home/y/ComfyUI/user/default/workflows/▶️ Video FLF.json` — source UI workflow (DO NOT modify)

### Sanity-check command after fix

```bash
# Extract app.asar and verify node 87 has the right chain
python3 -c "
import re, json
with open('/tmp/asar5/asar/dist/assets/index-*.js'.replace('*','XX')) as f: pass
"
# (extract first, then grep)
npx --yes @electron/asar extract /opt/ComfyStudio/resources/app.asar /tmp/asar5
python3 <<'PY'
import re, json, glob
for f in glob.glob('/tmp/asar5/asar/dist/assets/index-*.js'):
    txt = open(f).read()
    def extract(nid):
        i = txt.find(f'"{nid}":')
        if i < 0: return None
        j = txt.find('{', i)
        depth = 0
        while j < len(txt):
            if txt[j] == '{': depth += 1
            elif txt[j] == '}':
                depth -= 1
                if depth == 0: return txt[i:j+1]
            j += 1
    for nid in ('85', '87', '94', '98'):
        b = extract(nid)
        if b: print(f'== {nid} =='); print(b[:200])
PY
# Expect: 87 has samples:["85",0], vae:["90",0]
# Expect: 94 has images:["87",0]
# Expect: 85 latent_image:["86",0]
```

### What the next agent should do

1. Re-run the conversion with the correct VAEDecode mapping (`8: 87` not `8: 85`).
2. Verify CreateVideo 94's `images` field is `["87", 0]` after remap.
3. If still broken, dump the full submitted workflow JSON from the dev console and compare it byte-for-byte against the user's working ComfyUI workflow (exported via ComfyUI's "Save (API Format)" → compare with `/home/y/ComfyUI/user/default/workflows/▶️ Video FLF.json`).
4. The user's UI workflow **works** when loaded directly into ComfyUI. Anything different in the bundled JSON is the bug.
