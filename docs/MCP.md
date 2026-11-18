# Velorn MCP Guide

Velorn includes a local Model Context Protocol (MCP) server so AI agents can inspect and operate on the open Velorn project. It is designed for agents such as Codex, Claude Code, Cursor-compatible MCP clients, and other open source MCP clients that can talk to a local HTTP MCP server.

The MCP server is part of the desktop app. It exposes the current project, active timeline, assets, ComfyUI connection state, generation state, visual frame inspection, safe timeline edit actions, caption actions, export actions, and workflow setup helpers.

## Local feature-parity update (unreleased)

The isolated `codex/mcp-feature-parity` checkout adds or upgrades 40 definitions; its catalog has 157 tools. This is local review work, not a published version. The full coverage matrix and verification checklist are in [MCP_PARITY_REVIEW.md](MCP_PARITY_REVIEW.md).

New coverage includes native batch Inspector/color/effects and Paste Attributes; source insert/overwrite/append and Smart Replace; compound lifecycle; normal/roll/slip/slide/ripple trims; guarded transitions; clip envelopes/EQ and ducking; frame sampling/RIFE jobs; caption add/split/retime with explicit draft ownership; installed fonts; live transport/Play Around and source-edge/two-up pictures; all UI export formats, built-in/custom presets, readiness, sequential delivery batches, native status/cancel, and packaged-ffprobe file inspection.

New writes default to preview. Apply the returned `suggestedApplyCall` unchanged, including `expectedContext`, draft revisions and opaque plan tokens. Do not reconstruct an apply request from a human-readable summary: it can lose frozen operands or stale-write guards. A rejected stale plan requires another inspection/preview. Read operations and transient playback controls do not create document Undo entries.

Snapshots use schema version 2 and include the authored audio/mask/bypass/caption/interpolation fields, generated-music provenance, In/Out, transport and compound editing context. `currentTimeline` is the active editable child when a compound is open; `editingContext.rootTimelineId` still identifies the parent. Inspect complete nested content with `inspect_compound`.

An export/generation job ID means **accepted**, not finished. Poll the matching status tool. MCP export batches run targets sequentially from a frozen authored snapshot; native job records survive renderer reload, but pending batches do not. Only explicit MCP-owned export jobs may be cancelled by MCP. `run_mcp_action_plan` stops after starting asynchronous work, and checks document context before subsequent synchronous steps. Its preview validates tool names, not a simulation of future edits. Use `tools/list` for authoritative schemas; the detailed legacy examples below do not enumerate every newer field.

## Quick Start

1. Launch the Velorn desktop app.
2. Open a project. Some setup tools work without a project, but timeline and asset tools need one.
3. Open `Settings > Agents (MCP)`.
4. Confirm the server is `Running`.
5. Connect your MCP client to:

```text
http://127.0.0.1:19790/mcp
```

The in-app settings panel also shows copyable setup commands.

For Codex:

```bash
codex mcp add velorn --url http://127.0.0.1:19790/mcp
```

For Claude Code:

```bash
claude mcp add --transport http velorn http://127.0.0.1:19790/mcp
```

For clients that use an `.mcp.json` file:

```json
{
  "mcpServers": {
    "velorn": {
      "type": "http",
      "url": "http://127.0.0.1:19790/mcp"
    }
  }
}
```

Velorn keeps this same local config in the repository root for development.

## What Agents Can Do

Velorn MCP is useful for five broad workflows:

- Review an edit: inspect timelines, clips, visible shots, frame contact sheets, disabled clips, missing media, gaps, markers, transforms, and export readiness.
- Make safe editorial changes: move, trim, split, delete, enable/disable, label, retime, adjust audio, add transitions, manage tracks, and manage timelines.
- Build graphics and polish: add text, shapes, solids, adjustment clips, GLSL effects, keyframes, motion blur, dips to black, and clip styling.
- Drive generation: prepare Generate from the current timeline frame, queue approved generation batches, inspect bundled workflows, validate ComfyUI nodes, and place generated assets back into timelines.
- Deliver: set In/Out ranges, run H.264 delivery exports, run social delivery batches, export FCPXML, and inspect exported files.

The MCP server is not a replacement for the Velorn UI. It is a project-aware control layer for agents. The best results come from asking the agent to inspect first, show a preview plan, then apply only after approval.

## Safety Model

The server runs only on loopback:

```text
127.0.0.1:19790
```

Do not proxy or expose this port to a network. Any local process that can connect to the port can call the MCP server while Velorn is running.

Most write-capable tools support `previewOnly` and many default to preview mode. In preview mode the tool returns the planned operation and usually a suggested apply call. To apply, the agent calls the same tool again with:

```json
{ "previewOnly": false }
```

Recommended agent behavior:

1. Use read tools first.
2. Use `find_timeline_items` before targeting clips, markers, tracks, transitions, or assets from natural language.
3. Use `previewOnly: true` before write actions.
4. Ask for explicit user approval before applying changes that write files, queue generation, spend credits, start GPU work, change settings, or modify timelines.
5. Use `create_project_checkpoint` before risky multi-step edits.
6. Use `run_mcp_action_plan` for approved multi-step work so Velorn can checkpoint first and stop on the first error.

Undoable timeline changes use Velorn's normal undo stack. Project creation, project duplication, exports, generated assets, and imported media can write files to disk.

## A Good First Agent Prompt

After connecting your client, try:

```text
You are connected to Velorn. Call get_mcp_recipes, summarize what review and edit passes are available, then inspect the open project with get_project and get_timeline. Do not make changes yet.
```

For a timeline health pass:

```text
Review this Velorn timeline for delivery risks. Use analyze_timeline and check_media_health first. If you want to add markers, show me the add_timeline_markers previewOnly plan before applying anything.
```

For visual review:

```text
Inspect the next 20 visible shots from the playhead. Tell me what each shot shows and flag anything that looks off-story. Do not add markers until I approve a previewOnly marker plan.
```

For generation from the timeline:

```text
Use the selected clip or playhead frame as an image-to-video source. Preview the prepare_generation_from_timeline_context plan for LTX 2.3 first, then wait for my approval before opening Generate or queueing anything.
```

## Connection Details

Protocol:

- MCP over local HTTP.
- JSON-RPC endpoint: `POST http://127.0.0.1:19790/mcp`
- Server-sent-event probe: `GET http://127.0.0.1:19790/mcp`
- Server name: `velorn`
- Default protocol version: `2024-11-05`

The server starts with the desktop app. If the port is not available, check `Settings > Agents (MCP)` for the current status/error.

Tools that can work without an open project include:

- `get_project`
- `list_recent_projects`
- `open_project`
- `create_project`
- ComfyUI connection/setup tools
- workflow inspection tools
- `list_glsl_effects`

Most timeline, asset, generation, caption, and export tools need an open project and an up-to-date project snapshot.

Completed renderer actions carry a fresh snapshot in their response. Electron installs that snapshot before returning the tool result, so immediately following `get_project`, `get_assets`, `get_timeline`, and other snapshot reads see the completed action without an arbitrary sleep. Failed actions also publish their current state for inspection; failure is not a guarantee that every partial change was rolled back. If snapshot capture/install fails after an action completes, the error explicitly warns against automatically repeating the action.

Ordinary UI/playback updates still use the throttled background publisher. An asynchronous job's `started` response is not completion: continue polling its status before relying on its final output. The immediate read-after-write guarantee does not turn background jobs into synchronous operations.

## Direct JSON-RPC Smoke Test

Most users should use an MCP client, but developers can test the server directly:

```bash
curl -s http://127.0.0.1:19790/mcp \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}"
```

Call a read-only tool:

```bash
curl -s http://127.0.0.1:19790/mcp \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_project\",\"arguments\":{}}}"
```

## Recommended Workflows

### Timeline Health

Use this before export or before an agent starts editing:

1. `get_project`
2. `get_timeline`
3. `check_media_health`
4. `analyze_timeline`
5. `check_export_readiness`
6. Optional: `add_timeline_markers` with `previewOnly: true`, then apply after approval.

### Visual Shot Review

Use this for music videos, fast social cuts, and visual continuity review:

1. `set_playhead` if the user gives a start time.
2. `inspect_visible_shots` for a page of top-visible shots.
3. `inspect_timeline_range` for a sampled contact sheet across a range.
4. `inspect_clip` or `inspect_timeline_frame` for specific problems.
5. Optional: `add_timeline_markers` after preview/approval.

### Safe Timeline Cleanup

Use this when the user asks for concrete timeline changes:

1. `find_timeline_items`
2. `inspect_clip` for any ambiguous target.
3. Preview one of `move_clips`, `trim_clips`, `delete_clips`, `split_clip`, `extract_range`, `set_clip_speed`, or `set_clip_audio`.
4. Apply only after approval.
5. Use `undo` if the result is not right.

### Generate From Timeline Context

Use this to extend, replace, or vary a shot:

1. `inspect_timeline_frame`
2. `list_velorn_workflows`
3. `prepare_generation_from_timeline_context` with `previewOnly: true`
4. Apply the prepare step only after approval.
5. `queue_prepared_generation` or `queue_timeline_generation_batch` with preview first.
6. `get_generation_status`
7. `add_asset_to_timeline`, `add_assets_to_timeline`, or `replace_clip_with_asset` with preview first.

### Community Workflow Import

Use this when the user brings a workflow from outside the official catalog — a comfy.org share URL, a downloaded .json, or pasted workflow JSON (UI/graph export format only):

1. `import_comfyui_workflow` with `previewOnly: true` and one of `url`, `filePath`, or `workflowJson`.
2. Show the user the dependency report: unknown node types, registry-resolvable node packs, model references, and `modelsMissingUrl` (community workflows almost never embed download URLs — supply `modelUrls` hints with `{ filename, url, targetSubdir }` for those).
3. Apply the import after approval. The result includes the `tpl-` workflow id, whether it is runnable, and any required extra media inputs (`assetSelect` fields).
4. `install_workflow_setup` with `previewOnly: true` — show the node packs, model files, and total download size, then apply only after explicit approval. Use `only: { nodePackIds, modelFilenames }` to install a subset.
5. Poll `get_workflow_install_status`. If it recommends a restart, restart ComfyUI with `control_comfyui_launcher`, wait for the connection, and re-preview to confirm.
6. `queue_timeline_template_generation` with `importedWorkflowId` (preview first). Map extra inputs — for example a reference face image — through `assetFieldIds` using the field ids from the preview.
7. `get_generation_status`, then place results with `add_asset_to_timeline` or `replace_clip_with_asset` after preview.

Downloads are https-only, existing files are never overwritten, and nothing installs without an applied `install_workflow_setup` call.

### Prompt To Generated Assets

Use this when the user gives a creative brief instead of a timeline source:

1. `list_velorn_workflows`
2. `create_asset_folder` with preview first.
3. `queue_prompt_generation_batch` with preview first.
4. `get_generation_status`
5. `create_timeline` if a separate sequence is useful.
6. `add_assets_to_timeline`
7. Add titles, shapes, adjustment clips, and keyframes as needed.

### Captions

Use this for timeline-wide captions or per-asset transcription:

1. `transcribe_captions` with `previewOnly: true`
2. Apply after approval.
3. Poll `get_caption_status`
4. Fix cue text or timing with `update_caption_cues`
5. `generate_captions` with preview first.
6. Apply after approval to render the caption overlay and place it on the Captions track.

### Export

Use this when delivery matters:

1. `check_media_health`
2. `check_export_readiness`
3. Optional: `set_in_out_range`
4. `export_timeline` with `previewOnly: true`
5. Apply after approval.
6. `inspect_export_file`

For social variants, preview `export_delivery_batch` before running it.

For interchange, preview `export_fcpxml` before writing a file. Use `format: "fcpxml"` for Resolve/Final Cut or `format: "premiere"` for Adobe Premiere Pro.

## Tool Catalog

Velorn currently exposes 125 MCP tools.

### Project, Recipes, And Discovery

| Tool | Purpose |
| --- | --- |
| `get_project` | Summarize the open project, active timeline, asset counts, and snapshot freshness. |
| `get_timeline` | Return active timeline tracks, clips, markers, and optionally transitions. |
| `get_assets` | Return project assets without exposing heavy blobs or preview URLs. |
| `get_ai_review_passes` | Return practical AI review recipes. |
| `get_mcp_recipes` | Alias-style recipe entry point for agents asking what Velorn MCP can do. |
| `find_timeline_items` | Search clips, tracks, markers, transitions, and assets before targeting changes. |
| `list_recent_projects` | List recent projects, even when none is open. |
| `open_project` | Preview or open a project by path or recent project name. |
| `create_project` | Preview or create a new project in the configured Projects folder. |
| `duplicate_project` | Preview or duplicate a project folder and open it on apply. |
| `save_project` | Preview or explicitly save the current project, including Director state and the active timeline. |

### Health, Inspection, And Review

| Tool | Purpose |
| --- | --- |
| `check_media_health` | Find missing files, zero-byte files, missing asset IDs, and unused assets. |
| `inspect_export_file` | Inspect an exported file for codec, duration, resolution, FPS, audio, and warnings. |
| `check_export_readiness` | Check timeline blockers/warnings for a standard delivery export. |
| `inspect_clip` | Inspect a clip, source asset, timing, transform, label, and still image. |
| `inspect_timeline_frame` | Capture the composed timeline frame at the playhead, time, or frame. |
| `inspect_timeline_range` | Sample a range and return a visual contact sheet/storyboard. |
| `inspect_visible_shots` | Find top-visible shot changes and sample each visible shot. |
| `get_generation_status` | Summarize active, failed, and recent generated asset status. |
| `get_music_video_status` | Summarize music-video workflow assets, assembled clips, and sync locks. |
| `get_music_video_plan` | Return every parsed Music Video scene and shot, including IDs, prompts, timing, workflows, active jobs, and Step 4/5 completion state. |
| `inspect_music_video_keyframe` | Inspect one Music Video Step 4 shot, including its prompt, workflow routing, active job, latest image, and generation history. |
| `regenerate_music_video_keyframe` | Preview or queue one Step 4 shot through the active Music Video keyframe settings and native routing. |
| `inspect_music_video_video` | Inspect one Music Video Step 5 shot, including its input keyframe, motion prompt, timing, active job, latest video, history, and poster. |
| `regenerate_music_video_video` | Preview or queue one Step 5 shot through the active Music Video video settings and native routing. |
| `analyze_timeline` | Produce an AI-friendly timeline health report. |
| `analyze_music_video_workflow` | Produce an AI-friendly music-video workflow health report. |

### Timeline Music Generation

| Tool | Purpose |
| --- | --- |
| `generate_music` | Preview or queue local ACE-Step or YuE 2 music from style tags and optional lyrics. Defaults to preview only. |
| `get_music_generation_status` | Check music jobs, backend, duration mode, imported assets and measured output duration. |
| `get_audio_analysis` | Inspect an audio/video asset or clip for beats, estimated BPM, loudness and silence. |

Omitting `backend` preserves the existing `"ace-step"` behavior. Select `backend: "yue2"` explicitly to use YuE 2. Both run through the connected ComfyUI with local models and no cloud credits; they require the selected backend's nodes/models. Preview first, inspect setup in the timeline Music popover, and obtain approval before queueing with `previewOnly: false`. Queueing requires an open saved project.

`durationSeconds` is 5–240 seconds: an **exact** duration for ACE-Step, but a **maximum** for YuE 2, which can stop earlier. Plans and jobs identify this with `durationMode: "exact"` or `"maximum"`. Poll `get_music_generation_status` and use the completed asset's measured duration when placing it with `add_asset_to_timeline`; do not assume a YuE 2 take fills its requested maximum.

ACE-Step retains `bpm`, `keyScale` and `timeSignature`. YuE 2 has no native equivalents, so explicitly supplying these controls is rejected rather than silently ignored. Musical preferences can be written in `tags` as best-effort guidance. For YuE 2, `instrumental: true` empties lyrics and adds an instrumental style hint; it does **not** guarantee the absence of vocals. An explicit instrumental request also overrides supplied lyrics. New audio imports into the `Generated Music` asset folder; timeline placement remains a separate approved action.

If only some variations are accepted before queueing fails, the result includes `partial: true`, a warning and the accepted `promptIds`; poll those jobs before retrying missing takes to avoid duplicates. Jobs retain their originating project. A status of `awaiting-project` with `belongsToCurrentProject: false` means reopen that project before completed audio can be imported.

### Agent-Guided Music Video Creation

These tools use the same persistent Director state as the visible Music Video UI. An agent-created project can therefore be opened, revised, regenerated, assembled, and saved through either MCP or the normal interface.

| Tool | Purpose |
| --- | --- |
| `get_music_video_session` | Read song, lyrics, creative direction, cast, workflows, output, passes, plan state, queue, and the resumable conversation checkpoint. |
| `configure_music_video` | Preview or set the song, lyrics, concept, style, workflows, output resolution, and FPS. |
| `update_music_video_session` | Preview or persist the current conversational phase, next question, decisions, approvals, and notes. |
| `manage_music_video_cast` | Preview or add, update, remove, replace, or clear named performers and their image references. |
| `queue_music_video_character_asset` | Preview or queue a Z-Image Turbo portrait or Multiple Angles character sheet. |
| `manage_music_video_pass` | Preview or manage alternate performance, environmental b-roll, and detail b-roll passes. |
| `set_music_video_director_script` | Validate, save, and optionally parse a master or coverage-pass director script. |
| `update_music_video_shot` | Preview or revise one parsed shot's prompts, timing, camera, type, artist, or reference overrides. |
| `queue_music_video_keyframes` | Preview or queue missing, all, or selected keyframes through native Director routing. |
| `queue_music_video_videos` | Preview or queue missing, all, or selected videos from their generated keyframes. |
| `replace_music_video_keyframe` | Preview or replace a Step 4 result with an existing project image. |
| `replace_music_video_video` | Preview or replace a Step 5 result with an existing project video. |
| `transcribe_music_video_audio` | Preview or run Qwen ASR transcription or provided-lyrics alignment. |
| `assemble_music_video_timeline` | Preview or assemble ready videos and song audio into editable coverage tracks with sync locks. |
| `replace_music_video_timeline_shot` | Preview or replace an assembled shot while preserving its edit timing, effects, transforms, and sync lock. |

### ComfyUI Setup And Workflow Support

| Tool | Purpose |
| --- | --- |
| `guide_comfyui_setup` | Beginner-friendly setup wizard for connecting Velorn to ComfyUI. |
| `diagnose_comfyui_connection` | Diagnose configured localhost port, API health, launcher state, and likely install mode. |
| `set_comfyui_connection` | Preview or set Velorn's local ComfyUI port. |
| `repair_comfyui_connection` | Probe likely ports and preview/apply a safe port-setting repair. |
| `control_comfyui_launcher` | Preview/apply start, stop, or restart through Velorn's launcher. |
| `get_comfyui_launcher_logs` | Return recent launcher logs with common issue summaries. |
| `validate_comfyui_nodes` | Check if ComfyUI node class names are available from `/object_info`. |
| `list_velorn_workflows` | List bundled workflows on the machine. |
| `inspect_velorn_workflow` | Inspect workflow JSON, extract required classes, and validate nodes. |
| `list_comfyui_templates` | Search official ComfyUI workflow templates. |
| `queue_timeline_template_generation` | Preview or queue an official ComfyUI template — or an imported community workflow via `importedWorkflowId` — from a timeline source clip. |
| `import_comfyui_workflow` | Preview or import a community ComfyUI workflow (comfy.org share URL, local .json, or inline JSON) as a runnable imported template with a dependency report. |
| `install_workflow_setup` | Preview or run the missing node-pack/model install for a workflow. Applying starts a background job. |
| `get_workflow_install_status` | Poll a dependency install job for progress, results, and restart guidance. |

### Selection, Navigation, Checkpoints, And Ranges

| Tool | Purpose |
| --- | --- |
| `undo` | Undo latest Velorn timeline or project-structure edit. |
| `redo` | Redo latest Velorn timeline or project-structure edit. |
| `set_playhead` | Move the playhead by seconds, timecode, or frame. |
| `select_clips` | Select clips by ID, filter, track, time, type, label, or search. |
| `select_assets` | Select/preview project assets by ID, name, type, folder, status, or latest match. |
| `create_project_checkpoint` | Create an in-memory MCP safety checkpoint for this app session. |
| `restore_project_checkpoint` | Preview or restore an in-memory MCP checkpoint. |
| `set_in_out_range` | Set, preview, or clear the active timeline In/Out range. |
| `run_mcp_action_plan` | Preview or run a checkpointed ordered batch of approved MCP actions. |

### Timelines, Folders, Tracks, And Transitions

| Tool | Purpose |
| --- | --- |
| `create_timeline` | Preview or create a new sequence/timeline. |
| `switch_timeline` | Preview or switch the active sequence/timeline. |
| `rename_timeline` | Preview or rename a sequence/timeline. |
| `duplicate_timeline` | Preview or duplicate a sequence/timeline. |
| `delete_timeline` | Preview or delete a sequence/timeline. |
| `create_asset_folder` | Preview or create asset-panel folders, including nested paths. |
| `move_assets_to_folder` | Preview or move assets into a folder using IDs/names or safe filters. |
| `move_unused_assets_to_folder` | Preview or move unused project assets into a folder without deleting files. |
| `add_track` | Create a new timeline track. |
| `update_track` | Preview/update track name, mute, lock, visibility, channels, or order. |
| `remove_track` | Preview/remove a timeline track and its clips, with last-track protection. |
| `add_transition` | Preview/add native transitions between clips or on clip edges. |
| `update_transition` | Preview/update transition type, duration, alignment, or settings. |
| `remove_transitions` | Preview/remove native transitions. |

### Timeline Editing

| Tool | Purpose |
| --- | --- |
| `set_clip_label_color` | Set or clear clip label colors. |
| `set_clips_enabled` | Enable or disable timeline clips. |
| `add_timeline_markers` | Add labeled markers at times, frames, or the playhead. |
| `remove_timeline_markers` | Remove markers by ID, color, label, range, or all markers. |
| `set_timeline_marker_properties` | Rename, recolor, or move markers. |
| `move_clips` | Preview/move clips to a track or start time. |
| `trim_clips` | Preview/update clip timing and trim values. |
| `delete_clips` | Preview/delete clips, optionally with ripple. |
| `split_clip` | Razor clips at a time. |
| `extract_range` | Remove a time range across unlocked tracks, optionally ripple-closing the gap. |
| `set_clip_speed` | Retime clips from 0.1x to 8x and optionally reverse. |
| `set_clip_audio` | Set audio gain and fades. |
| `set_clip_style` | Batch-update label color, enabled state, transform, crop, blur, blend mode, and motion blur. |

### Media Placement And Replacement

| Tool | Purpose |
| --- | --- |
| `search_stock_media` | Search Pexels photos/videos and open the same results in Velorn's Stock tab. |
| `import_stock_media` | Preview/bulk-import selected Pexels IDs or the first N non-duplicate results into a project folder. |
| `import_asset_from_path` | Preview/import a local media file into the active project. |
| `relink_asset` | Preview/relink an existing asset record to a local file path. |
| `add_asset_to_timeline` | Preview/place one project asset on the active timeline. |
| `add_assets_to_timeline` | Preview/place multiple assets as review lanes or a sequence. |
| `replace_clip_with_asset` | Preview/replace a clip with another asset while preserving the edit slot and styling by default. |

Pexels search/import requires the user's API key in `Settings > Stock (Pexels)`. A safe agent flow is:

```text
Search Pexels photos for "ocean drone shots" with search_stock_media. Show me the result IDs first. Then preview importing 10 non-duplicate results with import_stock_media into Stock/Pexels/Ocean Drone Shots. Wait for approval before applying, and do not place anything on the timeline until I approve a separate add_assets_to_timeline preview.
```

`import_stock_media` re-runs the search before applying so result IDs are validated against Pexels instead of accepting arbitrary download URLs. Imported files become project-owned media and keep Pexels source/creator provenance in their asset metadata.

### Generation

| Tool | Purpose |
| --- | --- |
| `prepare_generation_from_timeline_context` | Preview/apply staging Generate from a selected clip or playhead frame. |
| `queue_prepared_generation` | Preview/queue the currently staged Generate request. |
| `queue_timeline_generation_batch` | Preview/queue multiple image-to-video generations from timeline context. |
| `queue_h3_reference_video` | Preview/queue one MiniMax H3 image+audio reference performance shot without opening the ComfyUI canvas. |
| `get_generation_queue_status` | Poll live Generate jobs, prompt IDs, progress, failures, and imported result asset IDs. |
| `queue_prompt_generation_batch` | Preview/queue text-to-image or text-to-video generations from prompts. |

### Captions

| Tool | Purpose |
| --- | --- |
| `transcribe_captions` | Preview/start Qwen ASR caption transcription for timeline or asset scope. |
| `get_caption_status` | Poll caption transcription/render jobs and get the cue draft. |
| `update_caption_cues` | Edit the cue draft before rendering. |
| `generate_captions` | Preview/render an animated transparent caption overlay and place it on the Captions track. |

### Graphics, Effects, And Keyframes

| Tool | Purpose |
| --- | --- |
| `add_solid_color` | Preview/create a color or black constant asset and optionally place it on the timeline. |
| `add_adjustment_clip` | Preview/create an adjustment clip for color, blur, GLSL, and keyframed effects. |
| `duplicate_clip` | Duplicate a clip while preserving style, transform, effects, and keyframes. |
| `add_text_clip` | Create a text clip with typography, transform, animation, or keyframes. |
| `update_text_clip` | Preview/update an existing text clip. |
| `add_shape_clip` | Create shape clips for rectangles, rounded rectangles, ellipses, polygons, or lines. |
| `update_shape_clip` | Preview/update an existing shape clip. |
| `list_glsl_effects` | List GPU-backed effects, parameters, ranges, defaults, and presets. |
| `add_glsl_effect` | Preview/add a GLSL effect to a visual clip. |
| `update_glsl_effect` | Preview/update an existing GLSL effect. |
| `remove_glsl_effect` | Preview/remove a GLSL effect. |
| `set_clip_keyframes` | Preview/set visual keyframes for opacity, transform, blur, crop, color, and shape style. |
| `add_dip_to_black` | Preview/apply dip-to-black opacity fades between adjacent visual clips. |

### Export

| Tool | Purpose |
| --- | --- |
| `export_timeline` | Preview/start a timeline export through Velorn's export worker. |
| `export_delivery_batch` | Preview/run several delivery exports such as 16:9, 1:1, and 9:16. |
| `export_fcpxml` | Preview/export modern FCPXML for Resolve/Final Cut or XMEML v5 for Adobe Premiere Pro. |

## Preview/Apply Examples

Preview marker creation:

```json
{
  "tool": "add_timeline_markers",
  "arguments": {
    "markers": [
      {
        "timeSeconds": 12.5,
        "label": "Check continuity",
        "color": "#ffa500"
      }
    ],
    "previewOnly": true
  }
}
```

Apply after approval:

```json
{
  "tool": "add_timeline_markers",
  "arguments": {
    "markers": [
      {
        "timeSeconds": 12.5,
        "label": "Check continuity",
        "color": "#ffa500"
      }
    ],
    "previewOnly": false
  }
}
```

Preview a small generation batch:

```json
{
  "tool": "queue_prompt_generation_batch",
  "arguments": {
    "folderPath": "AI Spots / Product Demo",
    "items": [
      {
        "workflowId": "z-image-turbo",
        "prompt": "Premium tabletop product hero shot, soft cinematic light, clean background",
        "variations": 2,
        "width": 1280,
        "height": 720
      }
    ],
    "previewOnly": true
  }
}
```

Preview a MiniMax H3 lip-sync shot before spending credits:

```json
{
  "tool": "queue_h3_reference_video",
  "arguments": {
    "imageAssetId": "asset-reference-frame",
    "audioAssetId": "asset-exact-audio-segment",
    "shotId": "S01",
    "prompt": "Use Image 1 as the exact identity and composition reference. Use Audio 1 as the exact and sole performance-timing reference. Synchronize every visible mouth movement precisely to the supplied audio.",
    "durationSeconds": 9,
    "resolutionTier": "2K",
    "aspectRatio": "16:9",
    "previewOnly": true
  }
}
```

After explicit approval, repeat with `previewOnly: false`, then poll:

```json
{
  "tool": "get_generation_queue_status",
  "arguments": {
    "workflowId": "minimax-h3-r2v",
    "includeDone": true
  }
}
```

Preview a delivery export:

```json
{
  "tool": "export_timeline",
  "arguments": {
    "target": "h264_hd",
    "resolution": "1080p",
    "filename": "client_review_v1",
    "previewOnly": true
  }
}
```

## Troubleshooting

### The MCP client cannot connect

- Make sure the Velorn desktop app is running.
- Check `Settings > Agents (MCP)` for `Running`.
- Confirm the endpoint is `http://127.0.0.1:19790/mcp`.
- If the port is unavailable, another local process may already be using `19790`.
- Restart Velorn after changing development branches or rebuilding Electron code.

### The agent says no project is open

Open a project in Velorn, then try again. The agent can call `list_recent_projects` and `open_project`, but most timeline and asset tools need an active project snapshot.

### A write tool previews but does not apply

That is expected. Ask the agent to repeat the same tool call with `previewOnly: false` after you approve the preview.

### The agent cannot find the right clip

Ask it to use `find_timeline_items`, `inspect_visible_shots`, or `inspect_clip` before making changes. Prefer exact clip IDs for write actions.

### ComfyUI generation fails

Ask the agent to use:

1. `diagnose_comfyui_connection`
2. `get_comfyui_launcher_logs`
3. `validate_comfyui_nodes`
4. `inspect_velorn_workflow`

These tools can distinguish port issues, missing custom nodes, missing models, launcher problems, and workflow compatibility issues.

### Exports fail or look wrong

Ask the agent to run:

1. `check_media_health`
2. `check_export_readiness`
3. `export_timeline` with `previewOnly: true`
4. `inspect_export_file` after export

For square or vertical exports, make sure the agent previews `deliveryFraming` so you know whether the output will fit or crop the timeline frame.

### Editing is temporarily paused during export

Velorn gives export priority. While rendering, new timeline edits, Undo/Redo, transport, project switches, generation, installation and expensive media inspection are refused with an export-in-progress error. A `previewOnly` request is not automatically exempt: some previews decode or render media. Lightweight document/metadata inspection and `get_export_status` remain available. Wait for completion or use `cancel_export` / `control_export_batch` before starting more work. Do not retry blocked writes in a tight loop.

The visible progress dialog can also cancel an agent-started export. For an MCP batch owned by the current renderer session, its Cancel button cancels pending targets as well as the active job. UI queues pause remaining targets on Cancel and retain Pause after current. A renderer restart loses pending MCP batch targets, as before; the native active job still exposes status and cancellation. These guards do not cancel generation or unrelated processes that were already running when export began.

## Notes For MCP Client Authors

- Use `tools/list` to discover schemas at runtime. The catalog can grow over time.
- Tool results are returned as MCP content blocks, usually text containing JSON.
- Frame and contact-sheet inspection tools may include image content when requested and when size limits allow.
- Keep the MCP client connected to the local machine running Velorn. This is not a cloud API.
- Do not assume a write tool changed the project unless the returned result says it applied successfully.
- Favor explicit IDs from read tools over natural-language targeting for write tools.
- Queueing generation and running exports can take time. Poll status tools such as `get_generation_status`, `get_caption_status`, or inspect output files after completion.

## Create and Sound tools

These reach the models of the Create and Sound tabs. Added 2026-11-10.

| Tool | What it does |
| --- | --- |
| `get_create_models` | Reads the Create model list kept in Velorn: picture, video, voice and sound-effect models with ids, choices, recorded prices and the voice list. No network, nothing spent. |
| `generate_create_media` | Preview (default) returns a `planId` and estimated price for one request with a model from `get_create_models`. Apply takes only that `planId` with `previewOnly:false`. Every apply needs the person's own spending confirmation, on the computer or on their paired phone. |
| `get_comfy_router_status` | Cached readiness and the list of Router requests, including Create ones. |
| `control_comfy_router_image` | Refresh or cancel one known request by `jobId` (any Create kind). |
| `import_comfy_router_image` | Add a finished result (picture, clip or sound) to the project by `jobId`. |
| `generate_local_voice` | The built-in local voice (Kokoro): free, on this computer. Preview returns the plan and voices; apply starts one recording and returns a `promptId`. |
| `get_local_voice_status` | Status of local voice recordings and their finished audio assets. |

Recipe, a clip from a project picture: `get_create_models` -> `generate_create_media`
with `modelId`, `prompt`, `seconds`, `resolution`, `inputImageAssetId` -> show the
person the price -> `generate_create_media` with `planId` and `previewOnly:false`
(the person confirms) -> `control_comfy_router_image` refresh until `COMPLETED` ->
`import_comfy_router_image` -> `add_asset_to_timeline`.

