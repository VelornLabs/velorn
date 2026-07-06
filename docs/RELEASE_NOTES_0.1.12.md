# Velorn v0.1.12 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, Director Mode, Flow AI, and export features directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- New timeline tool palette (Move, Trim, Razor, Slip) with hotkeys, and a re-organized toolbar ribbon for clearer NLE-style editing
- Music video Director Mode pipeline overhauled with SRT/LRC paste, in-app song transcription, multi-artist cast support, and per-shot timing validation
- Effects stack expanded with Gaussian blur, directional blur, halation, and a properly working VHS / analog damage effect
- Topaz video upscale is now available from the Assets panel and as a Flow AI node, with live and static credit estimates
- Polished playback UX: Spacebar play/pause now works after touching sliders or transport buttons, and Windows focus rectangles are gone
- ComfyUI tab is now permanently in the title bar so the embedded ComfyUI workspace is always one click away

## Timeline And Editing Improvements

- Added a tool palette for Move/Trim/Razor/Slip, each with a hotkey, so accidental trims while zoomed out are no longer a problem
- Re-organized the timeline ribbon into logical groups (track creation, insert, tools, edit, options, navigate) with a slightly taller, easier-to-read height
- The bottom status label now reads `Timeline · [Active Tool]` so the current editing mode is always visible
- Audio fade handles redesigned as small top-corner tabs with a thin red stem, so the entire clip edge is dedicated to trimming and fades only activate from the dedicated hotspot
- One-frame clips now render at their true visual width while keeping a 24px invisible hit target so they remain easy to click without misrepresenting their duration
- Inspector clip speed control switched to a percentage scale (10% to 800%) with granular 1% steps and a clearer 100% reset
- Folder deletion is now recursive with an explicit confirmation message stating how many assets and subfolders will be removed; navigation falls back to the parent folder if the deleted folder was open

## Effects Improvements

- Added Gaussian blur and directional blur to the effects stack, with the duplicate Transform-panel blur removed
- Added halation, layered on the existing glow pipeline with a warm tint
- Rebuilt the VHS / analog damage effect to deliver real horizontal scanlines, animated grain and noise, jitter, and red/blue channel offsets for color bleed in both preview and export
- Effect parameters are unified across the inspector, real-time preview, and the export pipeline

## Music Video Director Mode

- Director Mode music videos are now driven by a structured script with per-shot control (mirrors the Ad Creation flow), including consistent characters via an "actor" selection
- Added project-level cast list with per-shot `Artist:` overrides and `[Name]` lyric tags so multi-singer songs work cleanly
- Lyrics input consolidated into a single auto-detecting textarea that accepts plain text, SRT, or LRC
- Added an explicit `Start at:` field per shot and a four-tier resolution hierarchy (explicit > matched lyric line > scene timing > linear estimate) for accurate audio alignment
- Added validation: coverage and gap reports, lyric-moment cross-check, and overlap detection so timing problems are surfaced before generation
- Added in-app song transcription using the Qwen ASR caption workflow to generate cue-level SRT inside Velorn
- Music video storyboard "Draft" quality now uses Qwen Image Edit 2509 so character references work in draft passes
- "Copy LLM Prompt" is now "Copy Prompt for ChatGPT / Claude / Gemini" with helper text explaining the round-trip workflow
- The captioning workflow has been added to Workflow Setup so its dependencies install through the same flow as everything else

## Topaz Video Upscale (Cloud)

- Right-click any video asset to upscale to 1080p or 4K with Starlight Precise 2.5 or Astra, with adjustable creativity
- Added a Topaz Video Enhance node in Flow AI with the same options exposed in a resizable, scrollable inspector
- Live credit estimates over WebSocket plus a static per-second pricing reference, matching the partner-node pricing guide

## Playback And Input Polish

- Spacebar play/pause now works even when focus is on a volume knob, transport button, or inspector slider; only true text-editing fields swallow the shortcut
- Native Chromium focus rectangles on range sliders and buttons are now suppressed when interacting with the mouse, with a subtle Velorn focus ring kept for keyboard Tab navigation
- The Create Storyboard PDF button reliably opens the PDF in your default viewer again, via Electron `shell.openPath`
- Workflow Setup gallery no longer flickers or tears while scrolling; backdrop-blur and transform animations were removed from the gallery cards

## App-wide Changes

- The embedded ComfyUI tab is now always visible in the title bar; the optional toggle has been removed since the tab is a core power-user surface
- The generic LLM tab has been hidden in favor of contextual Director Mode prompts that explicitly hand off to ChatGPT / Claude / Gemini
- "Keep" relabeled to "Cancel" in the delete folder confirmation, and the dialog now states the number of items being deleted

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
- Topaz upscaling is cloud-only; no local equivalent is included.
- Frame interpolation for smooth speed changes is not yet implemented (deferred).

## Suggested GitHub Release Title

`Velorn v0.1.12 - Timeline tools, effects stack, music video pipeline, and UX polish`
