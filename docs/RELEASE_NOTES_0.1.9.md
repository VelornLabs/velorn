# Velorn v0.1.9 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, the embedded ComfyUI tab, and export tools directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- Fixes the missing animated hero/video on the project selection screen in packaged desktop builds
- Patch release focused on installed-app behavior rather than workflow changes

## Welcome Screen Fix

- Fixed the project selection hero media paths so the packaged Electron app resolves the bundled video and poster correctly
- The welcome screen now builds those asset URLs from Vite's runtime base path instead of assuming web-server-root paths
- This specifically addresses the case where installed builds showed a dark/empty hero area even though the media files were present inside the app package

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

`Velorn v0.1.9 - Fix packaged welcome screen hero video`
