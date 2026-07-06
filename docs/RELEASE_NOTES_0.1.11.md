# Velorn v0.1.11 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, Director Mode, Flow tools, and export features directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- Adds Director Mode music-video workflow support with structured shot planning, coverage passes, and lip-sync-oriented tooling
- Adds Flow AI, a node-based workspace for chaining generation steps and routing results back into the same project
- Adds source-proxy playback plus commit renders to make heavier timelines easier to preview and iterate on
- Improves export and timeline reliability with cut-boundary frame fixes, zoom/playback polish, and persisted speed-adjusted clip timing

## Music Video And Flow Improvements

- Director Mode now supports richer music-video shot planning with workflow-backed performance, environmental, and detail coverage passes
- Added Flow AI, a visual node-based workspace for chaining prompt, image, video, and audio steps inside Velorn
- Flow AI writes results back into the same project asset pipeline used by Generate, making multi-step iteration easier without leaving the app
- Added bundled workflow definitions for Gemini prompt help, Topaz video enhance, vocal extraction, and music-video shot generation

## Editing And Playback Improvements

- Added low-resolution per-asset proxies for smoother timeline playback on heavier edits
- Added clearer proxy management with rebuild/generate-missing controls and better handling for unavailable or failed assets
- Added Flame-style commit renders so adjustment-driven looks can be flattened to a dedicated top-layer clip for easier playback
- Improved preview/timeline behavior around zooming, media fit, and speed-adjusted clip duration persistence

## Export And Render Reliability

- Fixed cut-boundary export flashes by forcing fresh frame presentation on large seeks before capture
- Commit renders now share the same export pipeline, keeping playback bakes consistent with final output
- GPU encoding still depends on an NVENC-capable FFmpeg build and supported NVIDIA hardware

## Important Setup Note

Velorn generation still depends on a separate local ComfyUI installation in this build.

- Local workflows may require manual node/model setup.
- Cloud workflows still use local ComfyUI and may require partner nodes plus a Comfy account API key.
- The Workflow Starter Pack remains optional and is mainly for advanced users who want to inspect or prepare workflows manually.

## Known Limitations

- This is still a pre-release style workflow-heavy desktop app.
- ComfyUI connections are local-only in this build.
- Some workflows still require manual node/model setup in ComfyUI.
- Cloud pricing and partner workflow requirements may vary by provider.
- Very large exports still use a PNG-intermediate render pipeline, so export speed can be slower than native NLEs.

## Suggested GitHub Release Title

`Velorn v0.1.11 - Director Mode passes, proxy playback, and commit renders`
