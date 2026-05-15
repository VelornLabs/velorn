# Stage 1: Raw RGBA frame pipe export

ComfyStudio export streams raw RGBA frames directly into FFmpeg stdin instead of writing PNG files first.

## What it changes
- Canvas/effect rendering stays the same.
- Final export can stream frames directly to FFmpeg as raw `rgba` video.

## Behavior
- Raw FFmpeg piping is the only export path for final export.
- Export fails fast if the raw pipe APIs are unavailable.

## Notes
- Preview rendering is unchanged.
- Audio still gets mixed separately and then muxed back into the final output.
- There is no PNG export path on this branch.
