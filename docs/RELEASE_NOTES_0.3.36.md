# Velorn v0.3.36 — Smarter background media preparation

## Hardware-assisted playback caches and proxies

Velorn now checks for a usable hardware encoder when preparing imported video for smooth playback. It uses NVIDIA NVENC on supported Windows/Linux setups or Apple VideoToolbox on supported Macs, with an automatic CPU fallback if hardware encoding is unavailable or cannot complete the job.

This addresses [issue #131](https://github.com/VelornLabs/velorn/issues/131). Thank you to **@dakipro** for raising the import CPU-usage concern.

## A calmer background queue

Playback-cache and proxy generation now share a queue, processing one encode at a time instead of starting an encode for every imported clip simultaneously. CPU thread use is bounded, and duplicate requests for the same output share work.

The asset panel now shows what is being prepared, how many jobs are waiting, current-file progress, and whether encoding is using the GPU or CPU. Failed preparation leaves the original media available for editing.

## Original media stays safe

Cache outputs are validated before replacing an existing cache. The originals remain unchanged, and normal full-quality exports continue using the original media. Playback caches retain frequent keyframes and no B-frames for responsive seeking; transparent media keeps its existing alpha-safe path.

Existing valid caches are retained. To try the new preparation path on existing footage, use **Rebuild Playback Cache**, or import new clips. Low-resolution proxies remain optional.

## Compatibility notes

- Hardware availability depends on the GPU, driver, codec and installed FFmpeg build. The existing hardware-export FFmpeg selection is also used for these preparation jobs.
- Bundled Linux FFmpeg may not include NVENC. A supported hardware-capable FFmpeg can be selected using the existing setting; otherwise preparation uses the bundled CPU encoder.
- Dedicated Intel/AMD encoding support is not added in this update. CPU decoding, audio processing and other import work may still use the CPU even when video encoding uses the GPU.
- Background jobs may finish after switching projects; stale results are not attached to the newly opened project. Closing/reloading the window cancels its pending work.

This release does not change delivery codecs, export quality settings, AI workflows or the project format.
