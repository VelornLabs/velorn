# Velorn v0.1.5 Draft Release Notes

## Choose The Right Download

- **Desktop app:** for most users who want to install Velorn and use the editor, Generate workflows, and export tools directly.
- **Workflow Starter Pack (optional):** for advanced ComfyUI users who want to inspect setup workflows manually in ComfyUI and prepare nodes/models outside the app.

## Highlights

- Faster timeline navigation with keyboard jumps between clip boundaries and markers
- More polished timeline behavior with horizontal-only wheel travel inside the timeline
- Better keyboard-driven editing with assignable navigation hotkeys
- Clearer NVIDIA NVENC export status with detected GPU, codec support, and expected encoder visibility

## Timeline And Editing Improvements

- Timeline wheel behavior now stays focused on horizontal travel instead of also drifting vertically when many tracks are off-screen
- `Arrow Up` and `Arrow Down` jump the playhead to the previous or next visible clip boundary
- `Shift+Arrow Up` and `Shift+Arrow Down` jump between timeline markers
- Keyboard jumps now keep the timeline viewport following the playhead so navigation stays visible on longer edits
- Clip-boundary and marker navigation now plugs into the editor hotkey system and can be reassigned in Settings

## Export And NVENC Improvements

- The export panel now makes NVIDIA NVENC support much easier to understand
- Export settings now show whether H.264 NVENC and H.265 NVENC are available in the current FFmpeg build
- The app now surfaces the detected NVIDIA GPU when available
- Hardware encoding UI now shows the expected encoder path, such as `h264_nvenc` or `hevc_nvenc`
- NVENC messaging is clearer when the selected format or codec cannot use hardware encoding

## Hotkeys And Navigation

- Boundary and marker navigation are now first-class hotkey actions in the customizable editor hotkey system
- The default navigation bindings are:
  - `Arrow Up` / `Arrow Down` for previous or next visible clip boundary
  - `Shift+Arrow Up` / `Shift+Arrow Down` for previous or next marker
- These actions continue to work alongside the existing editor keymap presets and custom bindings

## Important Setup Note

Velorn generation still depends on a separate local ComfyUI installation.

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

`Velorn v0.1.5 - Faster timeline navigation and clearer NVENC export`
