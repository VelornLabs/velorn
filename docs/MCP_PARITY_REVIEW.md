# Local MCP feature-parity review

Status: reviewed and authorized for a **local commit and fast-forward into local `main`** on 2026-09-17. No GitHub push, tag or release is authorized. See Git history for the exact integration revision.

Checkout: `velorn-mcp-parity`

Branch: `codex/mcp-feature-parity`

Base: published v0.3.34 / `140d3b6`, plus the accepted YuE2 work. Local `main` is checked out in `velorn-discover-gif`. The original `velorn` checkout remains on `codex/yue2-timeline-music` with its older uncommitted copy preserved; its authored files were not edited by this task. No agent-budget-lab changes were included.

## Start here

1. Save and quit the other running Velorn instance, and stop its development server. Only one instance should own MCP port 19790.
2. In a terminal:

   ```bash
   cd velorn-mcp-parity
   npm run electron:dev
   ```

3. Open a disposable test project or duplicate an existing project first. Reconnect the MCP client so it refreshes `tools/list`. The new catalog has **157 tools**: **27 additions and 13 upgraded definitions**, plus guarded existing caption actions.
4. Review one group below at a time. Have the agent inspect, preview, then apply the exact returned `suggestedApplyCall`; inspect the result, and try Undo. A successful preview makes no authored changes.

Dependencies in this local checkout reuse the installed packages via links; the Vite cache is isolated. No package versions were changed. Do not remove the original installed dependencies while using these links. A future standalone checkout can install normally using the existing lockfile.

## Review checklist

| Check | Try it | MCP tools |
| --- | --- | --- |
| ☐ Multi-clip Inspector | Change two clips' position/opacity/color, add or adjust a shared effect, then Undo once. Locked or animated values must be protected. | `set_clip_style`, `set_clip_color`, `inspect_clip_effects`, `edit_clip_effects` |
| ☐ Paste Attributes | Copy only selected attribute groups; leave unrelated values and keyframes alone. | `paste_clip_attributes` |
| ☐ Source edits and replacement | Insert/overwrite/append a marked source range with linked audio. Smart Replace a shot with a custom source In while preserving its edit. | `edit_source`, `replace_clip_with_asset` |
| ☐ Advanced trim | Normal multi-clip tail trim, then roll/slip/slide/ripple. Inspect accepted bounds and Undo each operation. | `trim_clips`, `edit_trim` |
| ☐ Two-up source review | Ask for the last outgoing and first incoming frames at a cut. The live playhead should not move. | `inspect_source_frame`, `inspect_edit_point` |
| ☐ Transitions | Add, change, and remove a transition. Preview should report its actual safe duration. | `add_transition`, `update_transition`, `remove_transitions` |
| ☐ Compounds | Create, inspect children, open/edit, return to parent, rename, uncompound, and Undo. | `inspect_compound`, `create_compound`, `open_compound`, `close_compound`, `rename_compound`, `uncompound` |
| ☐ Audio | Adjust gain/fades, editable volume points, and EQ. Analyze dialogue for ducking, inspect its job, explicitly apply the proposed envelope, then Undo. | `inspect_clip_audio`, `set_clip_audio`, `audio_ducking` |
| ☐ Frame interpolation | Inspect sampling/cache state; choose Frame/Blend/Optical Flow. Preview and explicitly build or cancel a RIFE cache. | `clip_interpolation` |
| ☐ Captions and fonts | Read actual live cues, add a cue at explicit seconds, split at a text caret, adjust start/duration, remove an accidental cue, and Undo a live edit. List installed font families. | `get_caption_status`, `update_caption_cues`, `list_fonts`; existing transcription/generation retained |
| ☐ Transport | Play/pause, step, forward/reverse slow rates, loop a selection or In/Out, and Play Around. Clip timing and Undo history must not change. | `get_transport_state`, `control_transport` |
| ☐ Export presets and formats | List built-in/custom presets; save, rename, delete a custom preset. Preview MP4, WebM, ProRes, audio, GIF and PNG sequence exports, including In/Out. | `list_export_presets`, `save_export_preset`, `rename_export_preset`, `delete_export_preset`, `export_timeline` |
| ☐ Export jobs and QC | Preview two delivery targets, apply, inspect progress until both finish. Try pause-after-current/resume/cancel. Inspect a completed file. Do not equate a returned job ID with completion. | `check_export_readiness`, `export_delivery_batch`, `get_export_status`, `control_export_batch`, `cancel_export`, `inspect_export_file` |
| ☐ Existing music | YuE2 remains the timeline default; ACE-Step remains available. Generated music provenance is visible in asset inspection. | `generate_music`, `get_music_generation_status` |

## Safety and behavior

- New write tools default to preview. Native editing plans protect locked tracks/clips, animated properties, linked groups, source limits, compounds, and transitions. Rejected/no-op edits do not create phantom history. Approved edits use the existing Undo path.
- Carry preview context and opaque plan tokens unchanged. A project switch, renderer reload, compound navigation, changed sequence dimensions, or authored revision makes old plans invalid. Inspect/preview again; never silently retry a stale mutation.
- Common document context deliberately ignores playback, selection and UI layout. Selection/playhead-dependent editing operands are frozen in native preview plans. Transport is navigation, not an authored edit.
- Action completion and the current editor snapshot travel in one IPC response; Electron installs the snapshot before reporting completion. Follow-up reads after completed MCP edits/imports/project changes require no sleep. Background UI/playback publishing remains throttled, and asynchronous jobs still need status polling. Failed actions refresh inspection state too; a snapshot failure explicitly warns against replaying an already completed action.
- Snapshots now include audio envelopes/EQ/gain/fades, masks, bypass, lock/link state, captions, interpolation/cache state, music provenance, In/Out and transport. While inside a compound, `currentTimeline` identifies the actual editable child; `editingContext` names the parent. `inspect_compound` returns its full child document.
- Exact-source inspection matches the trim viewer: reverse/ramped/RIFE timing, retained edge frames, private decoder and confirmed frames. It intentionally excludes timeline effects/compositing. Use the existing composed-frame/range tools for final-picture review. Unsupported or unconfirmed frames are reported, not substituted with a stale poster.
- Caption **agent-session drafts and Caption workspace drafts remain separate**. Live captions are shared project state. Drafts are session-local, carry their own revision/ownership, and can explicitly be cleared. An empty draft cannot be generated. Live cue edits preserve styles.
- Ducking is the existing level-based detector, not speech recognition; it does not analyze downstream EQ/inserts. Its analysis job does not change the timeline until a separate apply. Volume points include hidden trimmed points; inspect before replacing the full envelope.
- RIFE uses the existing native engine/cache, not ComfyUI. Reverse/transparent media remain unsupported. A build is local GPU work and writes a project cache; preview does not start it. Startup cancellation and source/project changes are guarded.
- Export uses existing UI render paths and advisory readiness checks. Intentional black/silence is not a blocker. Jobs have native IDs and terminal status; only explicit MCP-owned jobs can be cancelled by these tools. The next batch target starts after actual completion, not worker startup. Existing output paths are refused.
- Export batches freeze the approved authored snapshot. Later editing cannot change queued outputs. Native job history lasts until app exit; pending MCP batches are renderer-session-local, not durable overnight queues. UI queue and MCP queue are separate. Presets are shared with the UI.
- `run_mcp_action_plan` previews tool names, **not a simulation of all future edits**. Preview individual tools first. It checkpoints, checks context at step boundaries, stops on errors by default, and pauses after starting an asynchronous job so the agent can inspect its status before continuing. A failed checkpoint or context ownership change always stops the plan.
- Native source Insert/Overwrite/Append supports video/audio; images still use existing placement tools. Smart Replace preserves the edit; deprecated fit-to-source-duration requests are rejected rather than silently retiming it. Normal batch edge trim rejects reverse clips; explicit supported native trim modes retain their own constraints. No nested compounds were added.
- UI-only layout controls (panel widths, keyframe viewport zoom) are not required to author equivalent edits and were not turned into MCP configuration surfaces.
- This is not a promise that legacy tools are permission sandboxed. Agents still need normal user authorization for expensive generation, disk writes or external actions. No payment, automatic purchasing, publishing, or account access was added.

## Verification

Local verification on 2026-09-17:

- **106 focused MCP tests passed.**
- **1,104 passed, 0 failed, 1 optional real-RIFE-runtime test skipped** across the 99-file combined regression inventory.
- Public JSON-RPC-to-renderer/store checks passed in both Chrome and sandboxed Electron, including real H.264 source-frame decoding. The music UI/import/Undo smoke passed with synthetic local audio and no GPU request.
- Existing Export UI checks passed: 27 workspace groups, 9 readiness groups and 9 custom-preset groups.
- Production build, Electron/native-helper syntax checks, clean diff formatting, and Linux x64 native runtime gate passed. Existing Vite CJS, Browserslist-age and large-chunk warnings remain.

Run:

```bash
npm run test:mcp-parity
npm run test:mcp-parity:regressions
npm run build
npm run runtime:verify-native
```

The public JSON-RPC/renderer/store integration fixture is `scripts/check-mcp-parity.cjs`, using an isolated Vite server at `127.0.0.1:5198`. Set `PLAYWRIGHT_MODULE_PATH` to the available Playwright package. Set `VELORN_TEST_ELECTRON=1` for the sandboxed Electron fixture. It tests schema/handler coverage, real previews/apply/Undo, stale rejection, audio, transport, compound child readback, and actual H.264 source decoding without changing a real user project.

Native export tests exercise the actual IPC handler code with disposable worker doubles, plus real bundled FFmpeg/ffprobe on temporary synthetic media. They cover exclusivity, sequencing, cancellation ownership, early cancel, errors, renderer crashes, and close/load failures. They do not claim that every final media format has been rendered on every operating system.

The public integration fixture now uses the real action bridge and throttled publisher, without refreshing snapshots before each RPC. It checks immediate create/import/place/edit/Undo/error/compound readback in Chrome and sandboxed Electron. Six freshness regressions reproduce the pre-fix race and cover native ordering, concurrent asynchronous actions, failed snapshots, and foreign/expired IPC responses.

A subsequent authorized live pass created disposable projects under `Documents/velorn_projects`, exercised native editing/Undo/captions/audio/compounds and completed MP4/WAV exports. After the freshness fix, actual project creation, media import, clip placement, and 20 rapid edit/read/Undo/read cycles passed without sleeps, forced snapshots, or retry polling. The original projects and regular app instance were not modified. All work remains local: no cloud spend, ComfyUI jobs/model downloads, or GitHub actions. Windows and macOS packaged smoke checks still belong to release verification.

Future feature work should include its public schema, real renderer/native action, inspectable state, preview/apply/error/Undo coverage, and a review row here (or a successor checklist). `test:mcp-parity` and the public integration fixture guard against schema/dispatcher drift.
