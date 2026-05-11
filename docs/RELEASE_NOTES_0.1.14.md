# ComfyStudio v0.1.14 Release Notes

## Downloads

- `Windows Installer`: standard Windows install experience for most users
- `Windows Portable`: no-install Windows build for quick testing or portable use
- `Mac (Apple Silicon)`: for M1, M2, M3, and newer Macs
- `Mac (Intel)`: for older Intel-based Macs

## Highlights

- Adds a cleaner Create launcher with dedicated Ad Creation, Music Video Creation, and Short Film Creation entry points
- Expands Music Video Creation with model/resolution rerenders, selected-shot prompt edits, cleaner pass assembly, and improved keyframe/video controls
- Adds Short Film Creation voice, keyframe, and video wiring, including ElevenLabs text-to-speech and an LTX 2.3 dialogue video workflow
- Adds stronger short-film dialogue prompt guidance so talking shots request clear visible mouth, lip, jaw, cheek, and chin movement
- Adds playback/performance tools including timeline thumbnail toggles, GLSL preview quality controls, nearby preview caching, and per-clip layer compositing controls
- Improves export speed and persistence with export presets and faster preview-frame capture paths

## Creator Workflows

- Simplifies the Create tab into a focused workflow launcher instead of a searchable Local/Cloud browser
- Adds new creator cover images for ad, music video, and short film workflows
- Adds Short Film Creation support for planned dialogue voices, shot keyframes, video generation, selected-shot reruns, and timeline assembly
- Adds Qwen Image Edit and Nano Banana 2 keyframe renderer choices for short-film keyframes
- Adds a bundled ElevenLabs text-to-speech workflow and short-film dialogue LTX 2.3 image+audio workflow

## Editor And Playback

- Adds optional timeline thumbnail hiding for heavier edits
- Adds nearby preview caching for smoother playback around the playhead
- Adds lower-resolution GLSL preview modes so effects can be previewed more responsively
- Adds per-clip compositing behavior so lower layers are only evaluated when needed
- Improves frame snapping and frame-step behavior so timeline time display and playhead position agree more consistently
- Fixes imported video duration handling so dragged clips trim to the actual source frame duration instead of misleading rounded lengths

## Export

- Improves export performance for effect-heavy timelines
- Adds persistent export settings and export presets
- Removes lower-level export toggles that made the export panel feel too technical

## Fixes

- Fixes asset search crashes
- Fixes folder rename and text-cursor behavior in rename fields
- Fixes folder delete behavior so nested contents are deleted with the folder
- Fixes moving timelines into folders
- Fixes duplicate imports for multi-angle workflow outputs
- Fixes music-video pass assembly so performance and b-roll passes land on separate timeline tracks
- Fixes selected shot prompt editing so the spacebar works inside prompt fields

## Before You Run A Workflow

- Make sure ComfyUI itself is updated to the latest version
- Make sure all custom nodes are updated to the latest version with ComfyUI Manager
- Restart ComfyUI after updating nodes or models
- If a workflow fails with a Python or node error, the most common cause is a ComfyUI core/custom-node version mismatch

## Known Notes

- ComfyStudio still depends on a separate local ComfyUI installation
- Some advanced local workflows still require large models and sufficient VRAM
- macOS builds are produced by GitHub Actions and require repository signing/notarization secrets to be configured
