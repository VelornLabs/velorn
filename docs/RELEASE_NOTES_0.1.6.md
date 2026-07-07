# Velorn v0.1.6 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, and export tools directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- New animated caption overlay workflow with ComfyUI-based ASR, cue editing, and transparent overlay export
- New kinetic typography caption renderer with per-word motion, palettes, global controls, and per-cue direction overrides
- New traditional subtitle mode with configurable position, text style, color, and size
- New local `LTX 2.3` image-to-video workflow option in Generate
- Better tonal color controls and clearer packaged NVIDIA NVENC export support

## Captions And Typography

- Right-click a video asset and choose `Add Captions` to open the new caption workflow
- Caption transcription now runs through a bundled ComfyUI workflow using Qwen3-ASR and SRT generation
- Captions are editable before render, with cue timing and text correction in the app
- Generated caption overlays are saved as transparent WebM assets in a `Captions` folder and can be placed on the timeline automatically
- Kinetic caption styles now support:
  - per-word pop-in animation
  - palette selection
  - automatic position variety
  - per-cue placement overrides (`top / middle / bottom`, `left / center / right`)
  - motion profiles (`tamed / excited / frenetic`)
  - global size controls
- Traditional subtitle mode now supports:
  - action safe / title safe / center positioning
  - background box / outline / drop shadow / plain text styles
  - color swatches and subtitle sizing (`small / medium / large`)

## Color And Export Improvements

- Tonal color controls are more flexible and packaged NVENC detection is more reliable
- Export messaging is clearer when H.264/H.265 NVENC is or is not available
- The app surfaces the detected NVIDIA GPU and expected encoder path when possible

## Local Video Workflow Expansion

- Added a local `LTX 2.3` image-to-video workflow option alongside the existing WAN 2.2 and cloud video workflows
- Generate now groups video workflows by runtime (`Local` vs `Cloud`) to make it clearer what runs on your GPU
- Timeline-frame-driven generation now supports `LTX 2.3` in the same flow as the other single-video workflows

## Workflow Starter Pack

- Starter pack metadata has been refreshed for `v0.1.6`
- The generated starter pack now covers 14 workflow guides, including 8 local workflow entries and 6 cloud/partner entries
- The packaged starter pack artifact is ready as:
  - `release/velorn-workflow-starter-pack-v0.1.6.zip`

## Important Setup Note

Velorn generation still depends on a separate local ComfyUI installation.

- Local workflows may require manual node/model setup.
- The caption transcription flow also depends on the required local ComfyUI nodes being installed.
- Cloud workflows still use local ComfyUI and may require partner nodes plus a Comfy account API key.
- The Workflow Starter Pack remains optional and is mainly for advanced users who want to inspect or prepare workflows manually.

## Known Limitations

- This is still a pre-release style workflow-heavy desktop app.
- ComfyUI connections are local-only in this build.
- Some workflows still require manual node/model setup in ComfyUI.
- Caption transcription quality and timing depend on the installed local ComfyUI node stack and selected workflow behavior.
- Cloud pricing and partner workflow requirements may vary by provider.
- GPU encoding depends on an NVENC-capable FFmpeg build and supported NVIDIA hardware.

## Suggested GitHub Release Title

`Velorn v0.1.6 - Animated captions, kinetic typography, and subtitle controls`
