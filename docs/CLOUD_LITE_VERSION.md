# Velorn Cloud (Lite) — Design Notes

> Status: **Future / parked.** Not planned for the current release cycle. This
> document captures research and architectural thinking from April 2026 so we
> can pick it up without repeating the investigation.
>
> Main app work continues on the existing local-ComfyUI architecture. Come back
> to this doc when we're ready to scope a second SKU.

## 1. The idea in one sentence

A second build of Velorn — tentatively **Velorn Cloud** (or
**Lite**) — that ships **without** a local ComfyUI runtime and instead talks
to a hosted ComfyUI backend. Target audience: Mac users, low-end laptops,
Chromebook-adjacent machines, or anyone who only wants to run API-based
workflows (Grok / Kling / Seedream / nano-banana / Vidu / etc.) and doesn't
need a local GPU.

Install size drops from ~multi-GB (Python + PyTorch + models) to ~300–500 MB
(Electron shell + our UI). Startup is instant. No CUDA, no Python, no model
downloads.

## 2. Why the cloud-only path is viable

### 2.1 Compute really is cheap client-side for API workflows

For every workflow in the current starter pack that's built around a Partner
Node (Grok, Kling O3, Seedream, nano-banana-2, Vidu Q2, etc.), the heavy
lifting happens on the provider's servers. The ComfyUI process is just the
orchestrator — assembles the graph, fires an HTTP request, waits, downloads
the result. A base M1 MacBook Air would run the orchestrator fine.

### 2.2 The bottleneck isn't compute, it's the orchestrator itself

Even for an API-only workflow, local ComfyUI is a Python + PyTorch app.
PyTorch CPU wheel alone is ~1 GB. Python runtime + venv + dependencies push
a minimal install to 2–3 GB even with zero models on disk. That's the weight
we'd be trying to remove — not the models.

### 2.3 Comfy.org's hosted Cloud API makes the bottleneck go away

As of this research (April 2026), Comfy.org exposes a documented, third-party
Cloud API that is **explicitly advertised as "compatible with local ComfyUI's
API, making it easy to migrate existing integrations."**

That's the sentence that makes this whole plan realistic. Our
`src/services/comfyui.js` already speaks the protocol. We'd just repoint it
at a hosted endpoint and swap the auth.

## 3. What Comfy Cloud gives us (verified from docs)

- **Base URL:** `https://cloud.comfy.org`
- **Auth:** single header — `X-API-Key: <user's key>`. Keys generated at
  [platform.comfy.org/login](https://platform.comfy.org/login).
- **Endpoints that map directly to what Velorn already calls:**

  | Velorn needs | Comfy Cloud endpoint |
  | --- | --- |
  | Queue prompt | `POST /api/prompt` |
  | Fetch outputs | `GET  /api/history/{prompt_id}` |
  | Cancel pending | `POST /api/queue` |
  | Stop running | `POST /api/interrupt` |
  | Upload inputs | `POST /api/upload/image` |
  | Download outputs | `GET  /view?filename=...&type=output` |
  | Node catalog | `GET  /api/object_info` |

- **WebSocket** is supported with the same message types our client already
  subscribes to: `executing`, `execution_start`, `execution_success`,
  `execution_error`, `progress`, `status`. The auto-import bridge in
  `src/services/comfyAutoImport.js` would Just Work™ against it.

- **Subscription tiers** (Comfy.org's pricing, not ours):

  | Tier      | Concurrent jobs |
  | --------- | --------------- |
  | Free      | 1               |
  | Standard  | 1               |
  | Creator   | 3               |
  | Pro       | 5               |

### 3.1 Reference links (for future-us)

- [docs.comfy.org/development/cloud/overview](https://docs.comfy.org/development/cloud/overview) — overview + auth + examples
- [docs.comfy.org/development/cloud/api-reference](https://docs.comfy.org/development/cloud/api-reference) — full endpoint list
- [docs.comfy.org/development/cloud/openapi](https://docs.comfy.org/development/cloud/openapi) — OpenAPI 3.0 spec
- [github.com/Comfy-Org/docs/blob/main/openapi-cloud.yaml](https://github.com/Comfy-Org/docs/blob/main/openapi-cloud.yaml) — machine-readable spec, track via git
- [platform.comfy.org/login](https://platform.comfy.org/login) — API key dashboard
- [comfy.org/cloud/pricing](https://www.comfy.org/cloud/pricing) — subscription tiers
- Related: [docs.comfy.org/development/comfyui-server/api-key-integration](https://docs.comfy.org/development/comfyui-server/api-key-integration) — headless mode + API Key integration, also relevant to local-runs-with-partner-nodes

## 4. Alternative backends (keep in back pocket)

If Comfy.org's Cloud API changes policy, gets throttled, or pricing moves the
wrong way, these are vendor-neutral fallbacks that preserve the same
Velorn-Lite architecture:

1. **Comfy Deploy** ([comfydeploy.com](https://comfydeploy.com)) — explicitly
   built to expose ComfyUI via third-party API.
2. **RunPod Serverless ComfyUI templates** — users bring their own pod, we
   provide the URL field.
3. **Self-hosted Modal app** — if we ever want to operate our own fleet.

A good design target for Lite is therefore **"run against any ComfyUI-
compatible endpoint"**, not "run against Comfy.org specifically." Marketing
can pick a default ("Ships ready for Comfy Cloud") without locking us in.

## 5. Architecture sketch

### 5.1 What stays the same

- The entire Electron shell (`electron/main.js`, `preload.js`, timeline UI,
  assets panel, generate panel).
- `src/services/comfyui.js` — already abstracted around a base URL +
  WebSocket. Add one more auth mode (header injection) and it's done.
- `src/services/comfyAutoImport.js` — the status-broadcast scan pattern we
  just built in April 2026 is **the right pattern** for cloud too; it doesn't
  assume the client is the prompt's originator.
- Starter-pack workflows (`docs/workflow-starter-pack/...`) — the same JSON
  files. Cloud executes them identically.
- `src/services/comfyPartnerAuth.js` — already exists. Repurpose the auth
  plumbing for the `X-API-Key` flow.

### 5.2 What gets removed from the Lite build

- `electron/comfyLauncher.js` and anything it imports.
- `src/components/ComfyLauncherChip.jsx`,
  `ComfyLauncherLogViewer.jsx`,
  `ComfyLauncherSettingsSection.jsx`.
- `src/components/WorkflowSetupSection.jsx`'s model/custom-node install UI.
- The entire `resources/comfy/` staging in the packaged app.
- `scripts/build-workflow-starter-pack.mjs` — we still ship workflow JSONs,
  but we don't ship models or custom-node packages.
- Model-manifest UI, starter-pack installer, ffprobe/ffmpeg bundling can
  stay (still useful for local export/encoding).

### 5.3 What gets added

- A **"Sign in / paste API key"** flow in `GettingStartedModal.jsx`. Probably
  opens an external browser to `platform.comfy.org/login`, user pastes key
  back, we store it in the OS keychain via
  [keytar](https://github.com/atom/node-keytar) (or equivalent).
- A **ComfyUI tab** that's a `BrowserView` pointed at
  `https://app.comfy.org/<session>` (or wherever their web editor lives).
  User opens/edits custom workflows in-situ. Velorn still captures their
  outputs via the same auto-import bridge.
- A **"Bring your own endpoint"** power-user mode — a URL + API key text
  pair in Settings. Preserves the vendor-neutral positioning.
- A **subscription status indicator** somewhere in the UI so users aren't
  surprised by hitting their Free-tier concurrency limit.

### 5.4 Shape of the client change

```
src/services/comfyui.js
  ├─ mode: 'local' | 'cloud'
  ├─ baseUrl                      ← '127.0.0.1:8188' or 'cloud.comfy.org'
  ├─ apiKey                       ← null for local, required for cloud
  └─ every fetch()/ws() adds:
       if (mode === 'cloud') headers['X-API-Key'] = apiKey
```

One conditional, one header, one URL. That's the delta, in principle.

## 6. Open questions (to resolve when we pick this up)

Before writing any Lite-specific code, budget ~30 minutes of curl-driven
validation against a real Comfy Cloud account to confirm the following.
These are the only things that can actually derail the plan:

1. **WebSocket auth shape.** Is the `X-API-Key` passed as an HTTP header
   during the WebSocket upgrade, as a query param, or via an initial auth
   message on the socket? Docs are terse; a single `wscat` test will tell us.
2. **Uploads.** Does `POST /api/upload/image` accept exactly the same
   multipart shape as local ComfyUI? Several starter-pack workflows upload
   reference images — this must be bit-for-bit compatible or we'll have to
   branch the upload service.
3. **File view / download.** Does `GET /view?filename=...&subfolder=...&type=output`
   behave identically? Our auto-import downloads every output this way.
4. **Partner-node availability.** Does Comfy Cloud have every Partner Node
   our starter pack workflows reference today (Grok, Kling O3, Seedream,
   nano-banana-2, Vidu Q2, etc.)? The docs suggest yes, but per-workflow
   verification is needed before we can claim "all starter-pack workflows
   work in Lite."
5. **CORS / origin rules.** Electron can spoof origin so unlikely to be a
   blocker, but worth checking — especially for the embedded WebView tab.
6. **Rate limits & error shapes.** How does Cloud report 429s or subscription
   issues? We want a clean "Upgrade your plan" UX, not a cryptic 401.
7. **Output retention.** How long does Comfy Cloud keep a generated file
   addressable via `/view`? Our auto-import races to copy outputs into the
   user's project as soon as the prompt completes, which side-steps the
   concern, but worth confirming to avoid "asset vanished after 24h" bugs.
8. **Workflow editor embeddability.** Will Comfy.org's hosted editor render
   inside an Electron `BrowserView` with third-party auth, or do they frame-
   bust / require their top-level origin? If they frame-bust, the "embedded
   ComfyUI tab" experience degrades to "Open in browser" — still usable but
   less magical.

**Risk status line from the docs:** *"The API is experimental and subject to
change. Endpoints, request/response formats, and behavior may be modified
without notice."* Not unstable, but we should monitor the
[Comfy-Org/docs](https://github.com/Comfy-Org/docs) repo for breaking changes
and version-pin our expectations.

## 7. Product positioning (for when this becomes a shipped SKU)

- **Name candidates:** Velorn Cloud, Velorn Lite, Velorn Go.
- **Tagline direction:** "Runs on any laptop. Pay per generation. Zero setup."
- **Distinct from full Velorn:** different icon, different onboarding,
  different landing page. Don't cannibalize — users self-select by hardware.
- **Pricing model:** user pays Comfy.org directly for compute. We optionally
  wrap a small markup + a managed-credits flow later. MVP: just BYO key.
- **Migration path:** a user who outgrows Lite (wants custom models, local
  LoRAs, offline use) can switch to full Velorn with the same project
  files, same asset library, same workflow JSONs. Enforcing file-format
  parity across the two SKUs is a first-class requirement.

## 8. Effort estimate (rough, subject to #6 validation)

Assuming the curl validation in §6 passes cleanly:

- **Lite MVP (Comfy Cloud only, no custom endpoint support):** ~1 week of
  focused work. Mostly UI gating, an auth flow, a build-config branch, and
  removing the launcher code path. No architecture changes.
- **Lite v1 (vendor-neutral, "bring your own endpoint"):** +3–5 days on top
  of MVP for the Settings UI and validation of third-party URLs.
- **Lite v1.5 (embedded web editor tab):** +3–5 days, contingent on
  frame-bust behaviour from Comfy.org. If it frame-busts, drop to an "Open
  in browser" button and save the time.

Total realistic window when we decide to do it: **2–3 weeks of engineering,
plus QA across Mac / Windows / (maybe) Linux.**

## 9. What to do right now: nothing

This document exists so that when we're ready we don't have to re-derive
any of this. The current release cycle stays focused on full Velorn
(local ComfyUI, starter-pack install, the auto-import bridge, mask rendering,
context menu polish, the WAN 2.2 timeout adaptivity, etc.).

When the day comes, the first commit on a `lite/` branch should be a
30-minute curl session that answers §6.1–6.4. Everything else follows.
