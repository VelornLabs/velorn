# Export Hybrid Plan (FFmpeg-first, Canvas Fallback)

## Goal
Maximize FFmpeg-native export usage for speed and stability, while preserving feature parity by using canvas only when required.

## Lane Decision
- `ffmpeg` lane: timeline uses only FFmpeg-supported operations.
- `canvas` lane: timeline uses one or more canvas-only operations.
- `auto` mode: choose `ffmpeg` when safe, otherwise `canvas` with explicit fallback reasons.

## Initial Capability Matrix

### FFmpeg lane (phase 1)
- Video clip trim/in-out.
- Sequential stitching/concat.
- Basic geometry (scale/crop/pad/position).
- Basic transitions:
  - dissolve
  - fade-black / fade-white
  - wipe-left/right/up/down
  - slide-left/right/up/down
- Audio trim/mix/fades/mux.

### Canvas-required (current)
- Clip types: `text`, `adjustment`.
- Effects: `mask`, `chromaticAberration`, `sharpen`, `filmGrain`, `vhsDamage`, `glow`, `vignette`, `letterbox`, GLSL stack.
- Non-normal blend modes (until mapped explicitly in FFmpeg graph).
- Advanced transition variants currently implemented via canvas-specific logic (`zoom-*`, `blur`).

## Implementation Steps
1. Add lane analyzer (`analyzeExportCapabilities`) and emit reasons in logs.
2. Add export mode selector:
   - `auto` (default): ffmpeg when safe, else canvas
   - `ffmpeg` (force): fail fast if unsupported
   - `canvas` (force): existing behavior
3. Implement FFmpeg graph builder for phase-1 safe set.
4. Keep existing canvas path as fallback and parity baseline.
5. Add comparison fixtures and benchmark script.

## Instrumentation
- Keep `[Export:perf]` logs for canvas path.
- Add `[Export:lane]` log lines:
  - selected lane
  - fallback reasons
  - final encoder/command summary

## Branching / Merge
- Active optimization branch: `export-optimization`.
- Integrate progressively into `dev` in small PR-sized changes:
  1. analyzer + lane logs
  2. mode selector wiring
  3. phase-1 ffmpeg lane
  4. hybrid segment rendering
