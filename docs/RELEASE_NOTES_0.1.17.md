# ComfyStudio v0.1.17 Release Notes

## Downloads

- `Windows Installer`: standard Windows install experience for most users
- `Windows Portable`: no-install Windows build for quick testing or portable use
- `Mac (Apple Silicon)`: for M1, M2, M3, and newer Macs
- `Mac (Intel)`: for older Intel-based Macs
- `Linux AppImage`: portable Linux build
- `Linux deb`: Debian/Ubuntu package

## Highlights

- Adds custom ComfyUI workflow support so advanced users can bring their own API workflow JSONs into ComfyStudio.
- Adds a ComfyStudio Bridge for the embedded ComfyUI tab, including a `Send to ComfyStudio` button for compatible workflows.
- Adds custom keyframe and custom video workflow support inside Music Video Creation.
- Adds the People Wizard to Music Video Creation for creating or reusing character reference images.
- Improves Music Video Creation shot reruns, preview editing, model selection, custom workflow setup, and asset folder naming.
- Improves timeline editing with overwrite-style clip placement, cleaner snapping, smaller playhead handles, and more intentional playhead movement.
- Improves audio waveform rendering so timeline audio is clearer and more editor-like.
- Adds Linux release builds to GitHub Actions.

## Custom ComfyUI Workflows

- Adds starter graphs for custom image, keyframe, and video workflows.
- Adds endpoint nodes such as `COMFYSTUDIO_INPUT_IMAGE`, `COMFYSTUDIO_PROMPT`, `COMFYSTUDIO_OUTPUT_IMAGE`, `COMFYSTUDIO_OUTPUT_VIDEO`, `COMFYSTUDIO_WIDTH`, `COMFYSTUDIO_HEIGHT`, `COMFYSTUDIO_FPS`, `COMFYSTUDIO_DURATION`, and `COMFYSTUDIO_AUDIO`.
- Adds API JSON import support for custom workflows.
- Adds support for opening imported custom workflows back in ComfyUI.
- Adds custom image and custom video entries in Generate under a beta Custom tab.
- Keeps manual JSON import available even when the bridge is not installed or visible.

## Music Video Creation

- Adds custom keyframe workflow support in Step 4.
- Adds custom video workflow support in Step 5.
- Trims custom music-video audio per shot before sending it to `COMFYSTUDIO_AUDIO`.
- Makes Step 5 model controls more consistent with Step 4.
- Adds thumbnail-level rerun controls for keyframes and videos.
- Shows real generated image dimensions in previews instead of always showing the project target size.
- Shortens generated asset folder names for music-video outputs.
- Fixes new project behavior so Music Video Creation does not inherit stale state from an older project.

## People Wizard

- Adds a People Wizard flow for Music Video Creation.
- Supports creating new character images or reusing existing image assets.
- Keeps the flow inside the music-video setup instead of requiring users to leave the wizard.

## ComfyUI Tab

- Fixes auto-import for ComfyUI tab generations.
- Keeps imported ComfyUI generations organized under the generated assets area.
- Improves embedded ComfyUI download behavior so model download prompts behave more like regular ComfyUI.

## Timeline And Editor

- Adds overwrite-style drag behavior so clips can replace the section they are dropped over instead of overlapping.
- Improves snapping so it targets clip edges and the playhead instead of every small time interval.
- Makes the snap indicator thinner and less visually heavy.
- Reduces the size of the playhead top handle.
- Prevents accidental playhead jumps from clicking unrelated timeline areas such as the horizontal scrollbar.
- Improves waveform detail and contrast.

## Performance And Media Loading

- Reduces eager media loading when opening projects.
- Defers asset browser media hydration.
- Avoids eager sprite restoration on startup.
- Improves thumbnail and sprite caching behavior.
- Avoids video embeds in the music-video grid.
- Shows keyframe posters in timeline strips.

## Release Builds

- GitHub Actions now builds Windows, macOS, and Linux release assets.
- Linux release assets include AppImage and Debian package builds.

## Before You Run A Workflow

- Custom workflows must be exported from ComfyUI as API workflow JSON, not regular visual workflow JSON.
- Local workflows may require custom nodes and local model files.
- Cloud or partner-node workflows may require API keys, account credits, or model access.
- Restart ComfyUI after installing or updating custom nodes.

## Known Notes

- This is still a pre-release.
- ComfyStudio still depends on a separate local ComfyUI installation.
- Some custom workflows control their own size, FPS, duration, or audio behavior inside the graph.
- Paid lip-sync and video providers can behave differently from local LTX workflows, especially with short audio snippets.
