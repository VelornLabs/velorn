# Issue #131: hardware-assisted media preparation

Review branch: `codex/issue-131-import-cache`, based on released v0.3.35.
The maintainer approved the local implementation and authorized v0.3.36 release preparation. Keep the release draft pending final review; check CI for current validation status.

## Behavior

- Ordinary video imports still prepare full-resolution playback caches. Optional lower-resolution proxies remain opt-in through the existing Proxies toggle.
- Playback and proxy work share a single Electron-main queue. Only one cache encoder runs at once, including jobs requested by different import/rebuild entry points. Duplicate requests for the same output share work; incompatible requests cannot overwrite each other.
- The existing hardware-export FFmpeg selection and real encoder probe are reused: NVIDIA NVENC on Windows/Linux, VideoToolbox on macOS. A failed/unavailable hardware route retries with the bundled software encoder. No model, driver or FFmpeg download is automatic.
- Intel/AMD-specific encoders are not added in this patch. A machine without a usable supported encoder continues through CPU. In particular, the bundled Linux FFmpeg may lack NVENC; the existing user-selected hardware FFmpeg can provide it.
- Decoder/encoder CPU threads are bounded. Hardware **encoding** does not imply hardware decoding, audio processing or GPU-only importing.
- The asset panel shows the active operation/file, queued count, current-file progress and GPU/CPU/checking-hardware status. Completion summaries dismiss automatically; failures explain that originals remain available.
- The existing IPC names/results remain compatible. Read-only `getMediaPreparationStatus` and `onMediaPreparationStatus` expose only the calling window's jobs. Closing/reloading a window cancels its work; shared work needed by another owner survives.

## Media and editing safeguards

- Originals are read-only. Temporary outputs are validated before atomic publication; failed partial outputs are removed, leaving an existing valid cache in place.
- Playback retains source resolution, normalized constant frame rate, H.264/YUV420, a maximum six-frame GOP and no B-frames. Proxies retain their existing low-resolution role. Hardware quality controls are encoder-specific, not a claim of pixel-identical compression.
- Audio is retained when present. Alpha media continues using its original source; animated GIF/image-sequence normalization is not rerouted through opaque hardware caches.
- Normal full-quality exports use original media. Explicit proxy-review exports may use proxies, as before.
- Delayed renderer completions cannot update a removed/relinked asset or a different/reopened project. Native queue and renderer status state are transient and are not a new project-file format.
- Switching projects does not cancel existing background preparations: they may finish before the new project's jobs. Their stale results are not attached to the active project. Window reload/close does cancel owned jobs. Project-specific queue cancellation is not introduced in this patch.
- Existing valid caches are not invalidated just to change encoders. Use **Rebuild Playback Cache** to exercise the new path for an existing clip.

## Verification

```sh
npm run test:media-preparation
npm run check:media-preparation
# Optional: explicitly select an installed hardware-capable FFmpeg for a real GPU check.
node scripts/check-media-preparation.cjs --hardware-ffmpeg /absolute/path/to/ffmpeg
npm run build
```

The synthetic smoke check creates only its own temporary media. It checks source hashes, single-encoder concurrency, dimensions, fractional FPS, duration, audio/video decode, dense keyframes, no B-frames, and recovery from a failed hardware encode. `--keep` retains the synthetic files for inspection.

Local Linux RTX 5090 verification succeeded through the existing selected FFmpeg using `h264_nvenc`; CPU/failure fallback also passed. Windows/macOS encoder selection and arguments are covered by unit tests, but actual Windows NVENC and Mac VideoToolbox packaged-device validation is still required before release. A sandboxed Electron UI fixture also verified progress, fallback, failure, dismissal, subscription cleanup and narrow layout.

Verification recorded on 2026-09-26: 84 focused native/IPC/renderer/status/target tests passed, plus 51 adjacent hardware-export, alpha/GIF/image-sequence, seeking and export-scheduling checks. Release review added filesystem-identity checks for source/output aliases on case-insensitive volumes. Production renderer build, Electron syntax checks, whitespace checks and the Linux native dependency gate pass. Existing Vite/Browserslist/chunk warnings remain unrelated. No dependency upgrades were attempted.

Manual review: import several ordinary video clips, watch one active job and the queue drain, then scrub the completed clips. Repeat with Proxies enabled, a clip without audio, and an alpha clip. Check timing/audio/color visually on Windows and macOS hardware too. Do not publish based solely on Linux validation.

## Development and release review

Use the normal fresh-checkout `npm ci` / `npm run electron:dev` workflow. On Linux, keep Electron sandboxing enabled and configure the sandbox helper according to the installation environment. The review used an existing correctly configured Electron 28.3.3 runtime without changing system permissions.

Close another Velorn development session first if it owns port 5173. Synthetic verification did not stop existing app processes or alter user projects. Cross-platform tests exercise real bundled FFmpeg encoding/fallback, but successful CPU fallback on a hosted runner is not proof of physical-GPU support on that platform.
