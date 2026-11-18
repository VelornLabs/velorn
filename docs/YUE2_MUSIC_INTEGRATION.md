# YuE2 music integration — local review

Implemented on `codex/yue2-timeline-music`, based on v0.3.34, then copied into `codex/mcp-feature-parity` for combined verification. On 2026-09-17 the maintainer authorized committing the combined work and merging into local `main` only. No push or release is authorized. The older uncommitted copy in the original `velorn` checkout is preserved; use the combined integration branch/local `main` for the accepted current implementation.

## User flow

- Open the timeline's **Generate Music** popover. YuE2 is the new default; ACE-Step remains selectable with its existing BPM, key and time-signature controls.
- Enter music style, optional structured lyrics, maximum length and number of takes. Instrumental is a prompt preference for YuE2, not a guarantee of no vocals.
- An open project and a connected, compatible ComfyUI are required. Missing models use the existing user-initiated setup flow. Missing core nodes require updating ComfyUI.
- Completed audio is copied into project-owned `assets/audio`, shown under Generated Music, and auditionable before adding it at the playhead or In/Out start. The clip uses the measured file duration, never the requested maximum.
- The Generate workspace has a separate **Music Generation (YuE2)** workflow. Old `music-gen` jobs and existing audio remain ACE-Step/unchanged. Flow AI keeps its existing ACE-Step contract.
- MCP `generate_music` accepts explicit `backend: "yue2"`; omitted backend remains ACE-Step for old agents. Preview remains the default. See `docs/MCP.md`.

## Runtime and compatibility

The graph uses ComfyUI core's CheckpointLoaderSimple, YuE2GenerateABC, YuE2GenerateMusic, EmptyYuE2LatentAudio, KSampler, VAEDecodeAudio and SaveAudioAdvanced. The bundled checkpoint is `models/checkpoints/yue2_3b_int8_convrot.safetensors` (3,960,938,800 bytes). No custom node pack or weights are distributed with Velorn.

Full ABC planning and 32-step DPM2/SGM Uniform sampling follow the native workflow. The latent's seconds input is linked to YuE2GenerateMusic's actual seconds output. The guided length range remains 5–240 seconds; this is a ceiling for YuE2, not a claim that every song will be exactly that long. Output is lossless stereo FLAC.

The same UI/service code is used on Windows, macOS and Linux. Actual model acceleration belongs to the ComfyUI host. Linux/RTX 5090 was exercised; Windows/macOS packaged execution and Apple GPU compatibility have not been validated. No invented minimum-VRAM guarantee is shown.

Review [current model terms](https://github.com/multimodal-art-projection/YuE/blob/main/MODEL_LICENSE) before public distribution/default decisions. Upstream includes individual creator monetization permission, while company commercial model use needs separate permission. Velorn links the terms in the new surfaces and downloads only after the user's setup action.

## Job safety

Backend/version/model provenance is saved with new audio assets. Imports are serialized and deduplicated, and only the final saver is imported. A project switch never registers the take in the newly opened project: timeline jobs wait for their initiating project; Generate uses its origin-project append path. Download/probe/import failures remain visible rather than creating nonportable temporary-URL assets. Partial queue failure returns already accepted prompt IDs.

Timeline job tracking remains session-local, as before. Closing the popover is safe, but application restart does not restore those pending job records. Finished imported media is normal project media. A take that finishes after quitting can be recovered from ComfyUI output. This change does not add a durable cross-restart queue system.

## Verification

- `npm run test:music-generation`: 62 focused tests (model graph, jobs, MCP and catalog/Generate import integration).
- Existing imported workflow, saved workflow, Qwen TTS compatibility and music visual-style tests: 23 pass.
- Production renderer build and Electron MCP syntax check pass.
- `scripts/check-music-generation.cjs` exercises the real popover, stores and import service in isolated Chrome and Electron profiles. Filesystem bridge operations are confined to a temporary project; no user project is opened or altered. It checks backend switching, persisted input, disconnected-state gating, actual-duration insertion, playback and Undo/Redo.
- Optional `VELORN_MUSIC_LIVE=1 VELORN_TEST_ELECTRON=1` smoke uses local ComfyUI on port 8189 only after checking its queue is empty. A 12-second YuE2 sample generated, saved, decoded and inserted successfully on 2026-09-17. This is a pipeline test, not a musical-quality benchmark.

For UI checks, run Vite separately on port 5198 (or set `VELORN_TEST_URL`), then run the script with an installed Playwright module (`PLAYWRIGHT_MODULE_PATH` can supply its path). `VELORN_TEST_ELECTRON=1` selects the repository's installed Electron instead of Chrome. Live generation is opt-in and uses the GPU; standard UI tests use synthetic audio.
