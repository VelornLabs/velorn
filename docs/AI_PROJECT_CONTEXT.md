# Velorn Project Context

This document gives a new coding agent enough durable context to work on Velorn without relying on a previous chat or one developer machine.

## Product

Velorn is an open-source desktop AI video workstation. It combines a real multi-track editor with guided AI generation, project asset management, captions, effects, export, and a local MCP control layer for agents.

The founder's background is VFX and editorial. Product decisions should reflect real production workflows while keeping AI video approachable for people who do not want to operate a node graph.

Core product principles:

- Make the common creative path simple and guided.
- Keep outputs editable on a real timeline.
- Let advanced users bring custom workflows without making every user manage nodes.
- Keep local editing useful without ComfyUI. Only generation features and explicitly ComfyUI-backed utilities should require it.
- Prefer visible review and iteration over one-shot automation for creative work.
- Preserve user projects and existing behavior before optimizing architecture.
- Keep creator-facing editing capabilities agent-accessible: when adding an authored operation, review its MCP schema, shared/native action, inspectable result, preview/apply guards and Undo/error tests. UI-only layout controls need not become agent configuration. See `docs/MCP_PARITY_REVIEW.md` for the current local coverage checklist.

## Technical Shape

Velorn is an Electron desktop application with a React renderer.

- **Electron main process:** `electron/main.js`
  Owns native windows, filesystem IPC, dialogs, FFmpeg processes, export workers, ComfyUI launching, workflow installation, and the local MCP server.
- **Preload bridge:** `electron/preload.js`
  Exposes a limited `window.electronAPI` surface to the renderer. Renderer code should use this bridge rather than Node APIs directly.
- **React renderer:** `src/App.jsx` and `src/components/`
  Owns visible workspaces, editor interaction, preview, Generate, captions, settings, and export UI.
- **State:** `src/stores/`
  Zustand stores hold project, timeline, asset, workflow, generation monitor, and transient UI state. Some slices persist to local storage; the project file remains the durable creative document.
- **Services:** `src/services/`
  Domain logic for projects, workflows, generation, captions, media preparation, export, MCP actions, and filesystem abstraction.
- **Configuration:** `src/config/`
  Built-in workflow registries, setup catalogs, model/node dependencies, and other product configuration.

Electron main and renderer are separate processes. If renderer code needs native filesystem, subprocess, or OS behavior, add a narrow IPC handler in `electron/main.js` and expose only the required method through `electron/preload.js`.

## Project Data

Each Velorn project is a folder with project-owned assets, renders, cache data, autosaves, and a `project.comfystudio` JSON document. The legacy filename is retained for compatibility and should not appear as the product name in user-facing text.

Important rules:

- Prefer project-relative media paths so projects can move between Windows, macOS, and Linux.
- Keep absolute-path fallback and relinking behavior intact for older projects.
- Do not put generated test media or personal projects in the repository.
- Project hydration coordinates `projectStore`, `timelineStore`, and `assetsStore`; changing one contract can affect project opening, autosave, MCP snapshots, and export.
- Timeline edits should use existing store actions so undo, dirty tracking, autosave, and MCP snapshots stay accurate.

## Editing And Preview

The timeline and editor are driven mainly by `timelineStore` and `assetsStore`. Preview is assembled from timeline clips rather than delegated to a traditional NLE engine.

`CanvasPreviewRenderer.jsx` combines video/image sources, text and shape rasters, masks, compositing, transitions, transforms, and effects. Cache keys and source versions matter: a paused frame may need repainting even when the playhead frame number has not changed.

Export aims to match the editor but has multiple paths:

- Native/FFmpeg paths are used when the edit can be represented safely and efficiently.
- Canvas/frame-pipe rendering is used for visual states that need the renderer's composition logic.
- Export runs in a hidden Electron worker window to isolate heavy rendering from the main UI.
- Hardware encoding and Windows-only NVIDIA RTX upscaling are optional capabilities and must have clear availability/fallback behavior.

Do not assume browser preview behavior, FFmpeg output, and packaged Electron behavior are identical. Test the boundary affected by a change.

## ComfyUI And Generation

Velorn talks to a separately installed local ComfyUI server, normally at `127.0.0.1:8188`. It can launch configured local installations and embeds ComfyUI as an advanced workspace.

Generation supports:

- Curated built-in local and cloud workflows.
- Guided creators such as Music Video, UGC, Business Ad, and Short Film.
- Imported API-format workflows and workflows captured through the Velorn Bridge.
- Custom workflow bindings for prompts, media inputs, seeds, dimensions, duration, FPS, and output nodes.
- Dependency inspection and approved installation of custom nodes/models when metadata is available.

Custom workflow support is important. Do not restrict imported workflows to the bundled catalog. Detection code must tolerate real-world node naming while avoiding accidental binding to the wrong string or media field.

Cloud workflows may spend credits. Keep costs visible and require explicit approval before an agent queues paid work.

## Agents And MCP

Velorn starts a loopback MCP server at `http://127.0.0.1:19790/mcp`. The main server is implemented in `electron/mcpServer.js`; renderer-side action handling lives in MCP services and application state.

MCP is a control layer over the same visible project, not a separate project model. Agents can inspect media and timelines, review frames, edit, generate, caption, and export.

Safety expectations:

1. Read before writing.
2. Resolve ambiguous timeline targets before mutation.
3. Use `previewOnly` where supported.
4. Ask for approval before file writes, timeline changes, generation, credit spending, model/node installation, or export.
5. Use project checkpoints for risky multi-step work.
6. Keep the MCP server loopback-only.

See `docs/MCP.md` for the current tool catalog and recipes.

## Development

Install and run:

```bash
npm ci
npm run electron:dev
```

Production renderer build:

```bash
npm run build
```

Tests are currently focused Node test scripts rather than one universal suite. Inspect the `test:*` scripts in `package.json` and run tests covering the changed domain. Direct service tests commonly use:

```bash
node --experimental-default-type=module --test path/to/test.js
```

For Electron CommonJS files, a useful first syntax check is:

```bash
node --check electron/main.js
node --check electron/preload.js
```

Build warnings about existing large chunks and mixed dynamic/static imports are known. Do not confuse them with a failed build, but do not add avoidable bundle growth.

## Git And Releases

- Repository: `https://github.com/VelornLabs/velorn`
- License: GPL-3.0-only.
- Use focused branches and commits. Do not mix generated media, experiments, and release work into feature commits.
- Never discard a dirty checkout to update it. Make a clean worktree or fresh clone, then migrate intended changes deliberately.
- GitHub Actions builds Windows, macOS, and Linux from release tags; development can happen on Ubuntu without changing that release model.
- Releases are created as drafts and reviewed by the maintainer before publication.
- Read `docs/AI_RELEASE_HANDOFF.md` and `docs/RELEASE_PROCESS.md` before release work.

## Where To Look First

- Product overview: `README.md`
- Current agent handoff: `docs/AI_CURRENT_HANDOFF.md`
- MCP behavior: `docs/MCP.md`
- Release procedure: `docs/AI_RELEASE_HANDOFF.md`
- Feature history and demo ideas: `docs/FEATURE_TRACKER.md`
- App shell: `src/App.jsx`
- Project persistence: `src/services/fileSystem.js`, `src/stores/projectStore.js`
- Timeline behavior: `src/stores/timelineStore.js`, `src/components/Timeline.jsx`
- Preview composition: `src/components/CanvasPreviewRenderer.jsx`
- Export UI/worker: `src/components/ExportPanel.jsx`, `src/components/ExportWorker.jsx`
- Electron/native layer: `electron/main.js`, `electron/preload.js`
- MCP server: `electron/mcpServer.js`
