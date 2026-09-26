# Velorn v0.3.35 — Export scheduling hotfix

## Faster exports when the hidden renderer is throttled

Fixed an unnecessary display-refresh wait in the background export worker that could hold exports near four frames per second, even when the CPU and GPU had capacity to spare. This was reported on Windows in [issue #130](https://github.com/VelornLabs/velorn/issues/130).

The background worker now yields through an event-loop task queue rather than waiting for the invisible window to repaint. Progress reporting and cancellation remain responsive; visible direct exports and clip bakes retain their existing repaint behavior.

Export resolution, frame rate, codecs, effects, and quality settings are unchanged. The improvement depends on whether this scheduling problem affected your exports; decoding, effects, GPU readback, and encoding can still be independent bottlenecks.

Thank you to **@JLKCreative** for the detailed traces, timings, and output comparisons that documented the Windows problem.

## Scope

This is a focused patch on v0.3.34, with no unrelated feature changes.

Windows, macOS, and Linux installers are built through the normal desktop release workflow. This release is prepared as a draft for maintainer review before publication.
