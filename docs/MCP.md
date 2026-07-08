# Velorn MCP Guide

Velorn includes a local Model Context Protocol (MCP) server so AI agents can inspect and operate on the open Velorn project. It is designed for agents such as Codex, Claude Code, Cursor-compatible MCP clients, and other open source MCP clients that can talk to a local HTTP MCP server.

The MCP server is part of the desktop app. It exposes the current project, active timeline, assets, ComfyUI connection state, generation state, visual frame inspection, safe timeline edit actions, caption actions, export actions, and workflow setup helpers.

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

For interchange, preview `export_fcpxml` before writing a file.

## Tool Catalog

Velorn currently exposes 103 MCP tools.

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
| `analyze_timeline` | Produce an AI-friendly timeline health report. |
| `analyze_music_video_workflow` | Produce an AI-friendly music-video workflow health report. |

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
| `import_asset_from_path` | Preview/import a local media file into the active project. |
| `relink_asset` | Preview/relink an existing asset record to a local file path. |
| `add_asset_to_timeline` | Preview/place one project asset on the active timeline. |
| `add_assets_to_timeline` | Preview/place multiple assets as review lanes or a sequence. |
| `replace_clip_with_asset` | Preview/replace a clip with another asset while preserving the edit slot and styling by default. |

### Generation

| Tool | Purpose |
| --- | --- |
| `prepare_generation_from_timeline_context` | Preview/apply staging Generate from a selected clip or playhead frame. |
| `queue_prepared_generation` | Preview/queue the currently staged Generate request. |
| `queue_timeline_generation_batch` | Preview/queue multiple image-to-video generations from timeline context. |
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
| `export_fcpxml` | Preview/export the active timeline as FCPXML for Resolve, Final Cut, or Premiere. |

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

## Notes For MCP Client Authors

- Use `tools/list` to discover schemas at runtime. The catalog can grow over time.
- Tool results are returned as MCP content blocks, usually text containing JSON.
- Frame and contact-sheet inspection tools may include image content when requested and when size limits allow.
- Keep the MCP client connected to the local machine running Velorn. This is not a cloud API.
- Do not assume a write tool changed the project unless the returned result says it applied successfully.
- Favor explicit IDs from read tools over natural-language targeting for write tools.
- Queueing generation and running exports can take time. Poll status tools such as `get_generation_status`, `get_caption_status`, or inspect output files after completion.

