# ComfyStudio v0.1.23

## Highlights

- Added FCPXML timeline export from the Export panel, so ComfyStudio edits can be imported into DaVinci Resolve, Final Cut Pro, and Premiere workflows for finishing.
- Added Step 5 video replacement import in Music Video generation, including replacing a shot with a newly imported video or an existing project video.
- Added cast image import in Music Video generation so character/person references can be brought in directly from local files.
- Added generation completion sounds with settings for enabling the sound, choosing the tone, and adjusting volume.
- Improved preview prompt regeneration in Music Video generation.
- Improved short film shot-list handling, including clearer rebuild behavior from an edited script.
- Improved local ComfyUI connection checks so pre-existing local ComfyUI sessions are detected more reliably.
- Fixed music keyframe reference routing for Qwen Image Edit and related keyframe workflows.

## FCPXML Export Notes

- Export is currently one-way only: ComfyStudio can export `.fcpxml`, but importing XML back into ComfyStudio is not included yet.
- Exported XML includes media paths, clip timing, source trims, lanes, and ComfyStudio clip metadata notes.
- Advanced editor features such as effects, transitions, text clips, speed ramps, multicam, and color corrections are not preserved yet.

## Setup Notes

- ComfyStudio still depends on a separate local ComfyUI installation for local generation.
- Some workflows may require manual node or model setup in ComfyUI.
- If a workflow fails inside ComfyUI, test the bundled workflow directly in ComfyUI to confirm local model/node compatibility.
