# Velorn v0.1.10 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, the embedded ComfyUI tab, and export tools directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- The project selection screen now defaults to list view instead of thumbnail/grid view
- Patch release focused on a friendlier first-run project picker

## Welcome Screen Improvement

- New installs now open the recent-project picker in compact list mode by default
- This makes the project selection screen denser, less visually intimidating, and easier to scan on first launch
- Existing users who already saved a preferred view mode should keep their current setting

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

`Velorn v0.1.10 - Default project picker to list view`
