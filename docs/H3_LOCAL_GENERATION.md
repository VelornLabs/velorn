# Local H3 generation recognition

The desktop's native generation broker fetches `/object_info` from its configured
ComfyUI instance before assessing a graph. The H3 workflow was stopped because
`MiniMaxH3ReferenceToVideo` was not yet in the audited local class/module table.
It was classified **unknown**, not proven paid, so Ask before cloud required
approval. No generation had been submitted when that request was denied.

`generationSpendingPolicy.cjs` now recognizes the eight exact registered classes
in `comfy_extras.nodes_minimax_h3`: EmptyMiniMaxH3LatentAV, MiniMaxH3ImageToVideo,
MiniMaxH3AddGuide, MiniMaxH3ReferenceToVideo, MiniMaxH3SigmaShift,
MiniMaxH3FunControlNetApply, MiniMaxH3LatentUpscaleWithModel and PH3ImageConditioning.
Audited ComfyUI source revision: `2c75dc1b379a59e0880619d029607af5169a62ef`.
Module SHA256: `75514fe9093c589da231938287ef0ceeb2dcf31179143a1de9a269fb2f7bb626`.
These implementations perform local conditioning, tensor, latent and model-patch
operations. The `comfy_api.latest` import is the node schema interface, not a
paid generation client. The table does not allowlist the entire module namespace.

This is shared desktop logic: no account, path, GPU model, template ID, saved
trust record, resolution or model filename is special-cased. Existing local
LTX/WAN/SD and audio recognition stays unchanged. A fresh installation with the
same core nodes gets the same classification. Other missing/custom nodes can
still make a graph unknown; this is not a promise that every future workflow or
hardware combination will run. Source-level portability tests do not constitute
macOS/Windows binary testing.

Server-reported API, pricing and provider evidence still wins over local
recognition. Mixed cloud graphs, custom overrides, missing metadata and unknown
new classes retain their existing approval behavior. No new approval or tool
restriction was introduced. Local recognition is not graph validation or proof
that an arbitrary server is honest. It never claims a numeric price.

Tests: `generationSpendingH3.test.cjs` reproduces the old rejection and checks
all eight classes, override/API negatives, both policies, different endpoints,
Linux/macOS/Windows-style project paths, model folders and creative settings.
The real Electron fixture `check-generation-spending-native.cjs` also exercises
the renderer helper, sandboxed preload and native broker with synthetic H3
responses. No test runs a model or touches real accounts/settings.
