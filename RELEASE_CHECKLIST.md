# Velorn Release Checklist

Use this as the single "ship it" playbook when preparing a public release.
Update this file as process changes so future chats and future contributors can continue from the same source of truth.

## How To Use This File

- Copy this checklist into your release PR description.
- Check items as they are completed.
- If anything in this process changes, update this file in the same PR.

---

## Release Metadata

- [ ] Target version:
- [ ] Release branch:
- [ ] Planned release date:
- [ ] Release owner:

---

## 1) Code Freeze and Scope

- [ ] Stop merging non-release features.
- [ ] Confirm release scope and write a short "what is in / what is out" note.
- [ ] Confirm no destructive or risky refactors are in-flight.
- [ ] Confirm `git status` is clean before final build work.

---

## 2) Security and Secret Exposure Gate

- [ ] Run a repo scan for hardcoded secrets (api keys, tokens, private keys).
- [ ] Confirm `.env` files are not tracked (already covered by `.gitignore`, still verify).
- [ ] Confirm no local settings files are tracked (keys should remain local only).
- [ ] Confirm no auth-bearing URLs were committed (query params with keys/tokens).
- [ ] Confirm workflow JSON files do not include real credentials.
- [ ] Confirm no user projects, exported media, or local test assets are bundled into the repo or release artifacts.
- [ ] Confirm no copyrighted brand/reference images were accidentally left in workflow JSON defaults, docs screenshots, or example assets.

Notes:
- Comfy API key and Pexels key are designed to be stored locally (Electron user data / localStorage), not in git.
- A scan of current repo files should still be run before every release.

Optional but recommended:
- [ ] Run a git history secret scan before public launch.

---

## 3) Product Guardrails (Current Decisions)

Keep these unless intentionally changing product direction:

- [ ] ComfyUI remains local-only (loopback/localhost), no LAN/remote mode by default.
- [ ] ComfyUI default port remains `8188`, with settings override and reset button.
- [ ] LLM tab remains local-only (LM Studio) for now.
- [ ] Generate tab dependency preflight remains enabled (single workflow + Director Mode beta queue gating).
- [ ] Hardware tiers remain visible in Generate (`Lite`, `Standard`, `Pro`, `Cloud`).
- [ ] Starter Pack remains the official setup bridge for advanced ComfyUI users.

---

## 4) Workflow Starter Pack (Required)

If any workflow or dependency changed, do all of this before shipping:

- [ ] Update `src/config/workflowRegistry.js`.
- [ ] Update `src/config/workflowDependencyPacks.js`.
- [ ] Run:

```bash
npm run starter-pack:build
```

- [ ] Verify generated outputs:
  - `docs/workflow-starter-pack/starter-pack.manifest.json`
  - `docs/workflow-starter-pack/INDEX.md`
  - `docs/workflow-starter-pack/workflows/*.md`
- [ ] Review generated files for accuracy (IDs, tier labels, model paths, node names).
- [ ] Add/update ComfyUI-importable setup workflow JSON files (replace `setupWorkflowFile: pending` entries when available).
- [ ] Package starter pack as a versioned zip for release assets (example: `comfystudio-workflow-starter-pack-vX.Y.Z.zip`).
- [ ] Upload starter pack zip to GitHub Release assets.
- [ ] Ensure release notes point users to starter pack download.

---

## 5) Functional Smoke Tests (Must Pass)

### Editor and Timeline

- [ ] Drag asset to timeline and scrub/hover without major CPU spikes.
- [ ] Drag multiple selected assets from Assets panel to timeline and confirm all selected clips are inserted in sequence.
- [ ] Video without audio does not auto-create audio clip.
- [ ] Video with audio does create audio clip.
- [ ] Preview transform controls work (move, rotate, scale) and commit correctly.

### Generate and ComfyUI

- [ ] ComfyUI connection test works from settings (local port).
- [ ] Generate blocks queueing when required dependencies are missing.
- [ ] Director Mode beta queueing also blocks on missing dependencies and shows details.
- [ ] "Open in ComfyUI" behavior is clear to user (tab switch + workflow guidance).
- [ ] Generate docs/help buttons open the correct page for current mode/workflow.
- [ ] Single workflow cloud estimate renders credits + USD and only appears for cloud workflows.
- [ ] Director Mode cloud estimate renders credits + USD for selected workflows and handles dynamic pricing copy cleanly.
- [ ] Structured Director script format populates scene context, keyframe prompt, motion prompt, camera direction, and duration after `Build Plan`.
- [ ] `Create Storyboard PDF` export works and uses project title + simplified shot IDs.

### Effects and Media

- [ ] Film grain overlay looks acceptable in both static and looped use.
- [ ] Playback remains smooth on representative test projects.

### LLM

- [ ] Local LM Studio connection and model listing still work.

---

## 6) Build and Artifact Validation

- [ ] Install dependencies from lockfile:

```bash
npm install
```

- [x] Production web build:

```bash
npm run build
```

- [ ] Build desktop artifacts for target platform(s):

```bash
npm run electron:build:win
# optional
npm run electron:build:mac
npm run electron:build:linux
```

- [ ] Confirm artifacts are generated under `release/`.
- [ ] Install/run artifact on a clean machine or VM.
- [ ] Verify first-launch flow and basic generation path.

### Cross-Platform Dev Startup Gate (Open Source Critical)

- [ ] Validate fresh startup on Windows (clean clone or clean unzip): `npm install` then `npm run electron:dev`.
- [ ] Validate fresh startup on macOS (clean clone or clean unzip): `npm install` then `npm run electron:dev`.
- [ ] Confirm CSS toolchain config loads on both platforms (no PostCSS/Tailwind config parse errors such as `Unexpected token 'export'`).
- [ ] Confirm Generate tab and Director flow open without startup errors on both platforms.
- [ ] Record tested Node/npm versions for Windows and macOS in release notes.
- [ ] Linux validation remains optional until explicitly in release scope.

---

## 7) Documentation and Release Notes

- [x] Update root `README.md` if behavior/workflow requirements changed.
- [x] Keep setup docs explicit for both macOS and Windows quick-start (`npm install`, `npm run electron:dev`).
- [ ] Ensure hardware tier guidance still matches actual workflows.
- [ ] Ensure starter pack docs are current (`docs/workflow-starter-pack/README.md`).
- [x] Publish/update a single user manual entry point (quick start + deep dive).
- [x] Document the Director Mode structured script template with at least one copy/paste example.
- [x] Document cloud estimate behavior: credits, approximate USD conversion, and when dynamic pricing labels appear.
- [ ] Write release notes with:
  - major features/fixes
  - known limitations
  - setup requirements
  - starter pack link

### In-App Contextual Docs (Do Not Skip)

- [ ] Add `Docs` / `Help` button(s) inside Generate so users can open guidance in context.
- [ ] Add Director Mode beta-specific docs covering: script input, style notes, shot settings, references, and queue flow.
- [ ] Include "what goes where" guidance with screenshots/examples for ad creation and music video creation.
- [ ] Link directly from Generate docs to dependency troubleshooting and starter pack instructions.
- [ ] Ensure docs links work in packaged builds (external URL or bundled local docs fallback).

### Getting Started Guide

- [x] Implement manual `Getting Started` guide accessible from `Velorn > Getting Started`.
- [x] Guide covers projects folder, ComfyUI port, connection test, workflow setup expectations, and a basic app tour.
- [ ] Include clear "where files go" guidance (models/nodes/workflows/output folders).
- [x] Add a replayable entry point so users can reopen onboarding later.
- [ ] Verify onboarding works on a clean user profile and does not block normal usage.

---

## 8) Open Source Readiness

- [x] Confirm license is present and accurate.
- [ ] Confirm no private/internal-only files are tracked.
- [ ] Confirm dependency/licensing obligations are documented.
- [ ] Confirm packaged binaries and large assets are expected and intentional.
- [ ] Fill out public repo metadata (`package.json` author/repository/homepage/bugs as applicable).
- [x] Add community files appropriate for public contributions (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` or equivalent support policy).
- [ ] Confirm screenshots/demo media intended for the repo are safe to publish publicly.

Notes:
- `package.json` author is now populated.
- `repository`, `homepage`, and `bugs` should be added once the public repo URL exists.

---

## 9) Publish Steps

- [ ] Create final release commit/tag.
- [ ] Create GitHub Release with changelog.
- [ ] Upload app artifacts and starter pack zip.
- [ ] Verify downloads and checksums (if published).
- [ ] Announce release with quick-start instructions.

---

## 10) Post-Release Checklist

- [ ] Run install test from public artifacts.
- [ ] Monitor first user issues for setup friction.
- [ ] Capture follow-up fixes for next patch release.
- [ ] Update this checklist with any lessons learned.

---

## AI Handoff Template (Copy Into New Chat)

Use this when starting a new chat so the next assistant has exact context:

```md
Project: Velorn (Electron + React + ComfyUI local integration)
Goal for this session:
Current branch:
Latest commit:
Uncommitted changes:
Release target version/date:

Non-negotiable product decisions:
- ComfyUI local-only (no LAN/remote by default)
- LLM tab local-only for now
- Dependency preflight gating enabled (single + Director Mode beta)
- Hardware tiers shown in Generate
- Starter pack is required release artifact

Current blockers:
Next concrete task:
```

