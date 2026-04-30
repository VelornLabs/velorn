# ComfyStudio v0.1.13 Release Notes

## Downloads

- `Windows Installer`: standard Windows install experience for most users
- `Windows Portable`: no-install Windows build for quick testing or portable use
- `Mac (Apple Silicon)`: for M1, M2, M3, and newer Macs
- `Mac (Intel)`: for older Intel-based Macs

## Highlights

- Adds an LTX-inspired first-run setup path so new users can choose Quick Start or Bring Your Own ComfyUI and see what is ready before generating
- Adds Workflow Setup starter kits for Low VRAM Local Video, Best Local Quality, Cloud Quality, and Music Video Kit
- Adds Music Video Director Mode shot-control chips for camera movement, shot size, energy, and performance mode, plus project style cards for reusable looks
- Fixes Settings > File Paths so Output Directory and Workflows Directory can be selected with the native folder picker and persist after reopening Settings
- Fixes LTX 2.3 spatial upscaler setup so the model is checked and installed under `latent_upscale_models`, matching ComfyUI's `LatentUpscaleModelLoader`
- Fixes Music Video Director Mode shot timing so explicit `Length:` values above 5 seconds are preserved up to the music-video limit

## UX And Positioning

- Reframes onboarding around a simple ready-to-generate path: Projects Folder, ComfyUI Connection, Workflow Setup, and Ready To Generate
- Adds starter kits in Workflow Setup so users pick the kind of project they want to make instead of manually decoding every workflow graph
- Updates site copy to position ComfyStudio as a full AI video workstation: generate, direct, edit, upscale, and finish with local, cloud, or hybrid workflows
- Makes Music Video Project Cast and Style Cards feel like first-class project controls, not hidden prompt plumbing

## Fixes

- Wired the File Paths browse buttons to Electron's native directory picker
- Saved and restored Output Directory and Workflows Directory through app settings
- Updated LTX 2.3 Image-to-Video and Music Video Shot dependency metadata for the spatial upscaler
- Kept ad-style Director Mode duration defaults short while allowing music-video plans to use longer shot durations

## Before You Run A Workflow

- Make sure ComfyUI itself is updated to the latest version
- Make sure all custom nodes are updated to the latest version (use the ComfyUI Manager and update all)
- Restart ComfyUI after updating
- If a workflow fails with a Python or node error, the most common cause is a ComfyUI core update that requires a matching custom node update

## Known Notes

- ComfyStudio still depends on a separate local ComfyUI installation
- Built-in workflow setup checks still assume standard model filenames unless users run custom workflows directly in the ComfyUI tab
- Extra ComfyUI model paths are tracked as a future workflow setup compatibility improvement
