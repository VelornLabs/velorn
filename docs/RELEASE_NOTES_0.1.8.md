# Velorn v0.1.8 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, the embedded ComfyUI tab, and export tools directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- Much smaller desktop package size by removing an unused bundled local caption-transcription runtime
- Current ComfyUI-based caption workflows continue to work as before
- Patch release focused on packaging cleanup rather than workflow or UI changes

## Packaging And Size Reduction

- Removed the old unused local Whisper caption-transcription path from the Electron main process
- Removed the corresponding preload IPC bridge and renderer-side service that were no longer used by the live caption UI
- Dropped the bundled `@huggingface/transformers` dependency from the desktop app package
- This also removes the transitive ONNX runtime payload that had been inflating the packaged build size

## Captions

- The current captioning workflow in Velorn still uses the ComfyUI/Qwen ASR path
- Timeline caption transcription remains supported through the existing ComfyUI-based flow
- This release is intended to preserve current caption behavior while eliminating a dead fallback implementation

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
- GPU encoding depends on an NVENC-capable FFmpeg build and supported NVIDIA hardware.

## Suggested GitHub Release Title

`Velorn v0.1.8 - Smaller app package with caption runtime cleanup`
