# Issue #130 — hidden export scheduling

The export worker is a never-shown Electron window. With background throttling disabled, its document can report `visible` even though the window is not displayed. `requestAnimationFrame` is therefore not a reliable event-loop yield for this worker. Waiting every four frames can stall exports near four frames per second on affected systems.

## Focused correction

- `ExportWorker` supplies an explicit runtime-only `offscreen` flag.
- A per-export scheduler uses `MessageChannel` tasks for offscreen progress and decoder/IPC yields, with a timer fallback for runtimes without that API.
- Foreground direct exports and bakes retain repaint opportunities.
- Both the frame-loop progress yield and the pre-encoding yield use the scheduler.
- The scheduler closes its ports in `finally`, including errors and PNG-sequence cleanup.
- Existing `uiYield` diagnostics remain available; `progressYield`, `taskYield`, and scheduling mode distinguish the waits.

No codec, quality, frame-sampling, GPU-readback, native IPC, or editor-locking behavior changes are included.

## Reproducing the regression check

```bash
npm ci
npm run test:export-scheduler
npm run check:export-worker-scheduling
```

Set `VELORN_TEST_NATIVE_ENCODE=1` to also render a six-second, 1280×720, 24fps H.264 file and verify all 144 frames with FFprobe and a full FFmpeg decode. The fixture launches its own loopback Vite server and a sandboxed, never-shown Electron window. All media is synthetic; native output goes into a newly created temporary profile, never a user project.

The renderer deliberately suspends every animation-frame callback. Tests check correct-color frames, exact ordering of five one-frame shots, cancellation, pipe failure and recovery, plus timer and native IPC responsiveness. The test must finish with zero animation-frame requests.

On headless Linux, run under Xvfb with Electron's sandbox helper correctly installed. Do not disable the sandbox to make this regression pass. `VELORN_TEST_ELECTRON_BINARY` can select another unpacked Electron runtime; it is not a packaged-app smoke test.

## Validation and limits

Local Linux testing with Electron 28.3.3 passed the never-shown native-encode fixture. A six-second synthetic export completed in approximately two seconds, with a valid 144-frame H.264 output. This is a scheduling regression check, not a benchmark for a complex timeline.

The focused unit/export/media inventory passes 131 tests. The production renderer build and Linux native dependency gate pass. RIFE hardening passes 44 tests with one optional real-runtime test skipped.

The `Export Scheduling Regression` workflow repeats the unit and native-encode fixture on Windows, Linux, Apple Silicon macOS, and Intel macOS. Check its actual result for the release commit; configuration alone does not prove those platforms passed. Desktop packaging and signing remain the normal release workflow, followed by maintainer review of the draft.

An unrelated stalled GPU readback can still make an export slow even after scheduling is fixed. Use phase timings rather than assuming every slow export has the same cause.
