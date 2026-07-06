# AI Handoff: NVENC Test Build

## Status
- Date: 2026-04-10
- Current state: waiting for external user feedback on a Windows test build
- Tester context: user reported packaged NVENC failure on an RTX 5090

## What was diagnosed
- The failure was not missing NVENC support.
- The packaged app was trying to spawn FFmpeg from inside `app.asar`, causing `ENOENT`.
- Screenshot evidence showed:
  - NVIDIA GPU detection worked
  - `h264_nvenc` was present in FFmpeg encoder output
  - the actual error was a packaged-path launch failure

## What was changed
- Added packaged binary path resolution in `electron/main.js`
  - packaged builds now prefer binaries in `resources/bin`
  - `app.asar.unpacked` is still used as a fallback
- Updated `package.json` build config
  - explicitly bundles `ffmpeg-static` into `resources/bin/ffmpeg.exe`
  - explicitly bundles `ffprobe-static` into `resources/bin/ffprobe-static/...`

## Validation already completed
- `npm run build` passed
- packed app validation succeeded in a clean output folder
- confirmed packaged files exist:
  - `release-test/win-unpacked/resources/bin/ffmpeg.exe`
  - `release-test/win-unpacked/resources/bin/ffprobe-static/win32/x64/ffprobe.exe`

## Test artifacts created
- `release-test/Velorn-0.1.5-setup-x64.exe`
- `release-test/Velorn-0.1.5-portable-x64.exe`

## Commit
- Git commit created by AI: `1627711`
- Commit message: `feat: add tonal color controls and fix packaged NVENC support`

## Important scope note
- These test builds include both:
  - the packaged NVENC / FFmpeg fix
  - the recent Inspector color workflow changes

## Known packaging note
- Building into the existing `release/` folder hit a Windows file lock on `win-unpacked`.
- Clean verification was done successfully in `release-test/`.

## If the user reports back that it works
- Keep the packaged FFmpeg fix
- decide whether to:
  - publish a proper pre-release
  - build final release artifacts into the normal release folder
  - push the commit if not already pushed

## If the user reports back that it still fails
- Ask for:
  - installer vs portable
  - exact codec tested (`H.264 NVENC` or `H.265 NVENC`)
  - exact error text or screenshot
  - whether export panel detects NVENC but export fails, or detection itself fails
- Re-check runtime FFmpeg path logging in packaged build
- Verify spawned executable path at runtime on the tester machine
