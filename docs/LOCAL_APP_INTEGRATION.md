# Accepted app improvements — local integration

Date: 2026-09-26. This is a local review integration, not a release.

## Location and preserved sources

- Active checkout: `velorn`
- Active branch: `codex/local-app-integration`; combined app commit `7e0529aed086e3067bd328bef6cd431c8761f418`.
- Original review checkout: `velorn-app-integration`, retained at detached `7e0529a`.
- Upstream base: published v0.3.36 / GitHub main `fdd8255fb717db024688a2582022aa048dd16e84`.
- Accepted local YuE2/MCP commit: `344b1b2ed1518b2d30df0623dd7a6bd8094ff781`.
- Preservation branch: `codex/preserved-app-improvements-20260926`, commit `22c2ad0e13ca1c6b6dbc9209a357ab8503577a4b`, captures all 109 dirty app files from `velorn-mcp-parity` on top of that commit.

The initial preservation commit used a separate Git index. The original working folders, branch tips, source index and dirty files were left alone during integration. All 109 source files were byte-compared against the preservation commit after verification and remained unchanged. The older dirty YuE2 copy in `velorn` was not reapplied over the newer committed implementation.

The maintainer then explicitly authorized putting the combined version in the regular `velorn` folder. Before switching, its 30 older dirty files were preserved in commit `c4371505008bd29691d5587530e43a9c9dfbbd89` on `codex/backup-velorn-before-combined-20260926`, with a browsable backup at `velorn-backup-before-combined-20260926`. All 30 file contents and original permissions were verified in the backup before switching the regular folder. The original YuE2 branch tip remains unchanged. The backup contains the older source tree, not a duplicate dependency installation.

No remote writes, PR, tag, release or main-branch movement were performed. Version and lockfile remain 0.3.36. The original review folder received its own test dependencies; the regular folder's compatible existing `node_modules` and root-owned mode-4755 Electron sandbox helper were retained without reinstalling. No user app/settings/project/ComfyUI process was restarted or modified for verification.

## Included

1. **YuE2 music:** timeline and Generate UI, guided model setup, lyrics and instrumental modes, duration handling, import/recovery, and ACE-Step compatibility.
2. **MCP editing coverage:** 157 total tools, including 27 added tools and 13 upgraded definitions for editing, effects, audio, captions, compounds, review and export; preview, Undo and freshness guards remain intact.
3. **Export safeguards and recovery:** editing/playback suspension, visible progress/cancel, worker recovery, frame-pipe ownership, bounded GPU fence polling with ordered readback fallback, and frame timestamp rounding.
4. **Viewer-only fullscreen:** preserves the mounted viewer and transport; macOS uses same-Space simple fullscreen rather than moving to a new Space.
5. **Asset-browser persistence:** project-session folder/search/scroll and persistent list/grid preference, with clean project switches and no authored dirty-state changes.
6. **ComfyUI setup and launcher safety:** explicit discovery/connect, manual-open fallback, optional launcher setup, native target validation and guarded process ownership.
7. **Settings and safe asset removal:** six searchable groups, clearer accessible section tabs, project-only default, explicit reviewed system Trash/Recycle Bin operation and partial-failure recovery.

Previously shipped editing polish, GIF/alpha support, RIFE, Discover, issue #130 export scheduling and issue #131 bounded hardware-assisted playback/proxy preparation remain present.

## Explicitly excluded

- The separate Canvas/LLM-chat feature branch.
- Creator provenance experiments.
- Agent-budget and video-production lab work, including autonomous purchasing/production experiments.

Existing baseline Flow AI and agent/editor files already on GitHub main are retained; they are not a merge of those excluded experimental branches.

## Integration decisions

- Kept upstream's self-contained hidden-export test launcher and sandboxed Electron host. Combined its frame-order/cancellation checks with the accepted forced-GPU-recovery cases.
- Preserved both the asset browser's local persistence/removal changes and the newer preparation-status UI.
- Added an atomic native idle lease around Trash: active, queued, probing or cancelling media preparation causes a clear wait/retry result before file removal. New preparation is refused while the Trash callback runs. Success and failure both release the lease. Existing preparation is not cancelled merely to delete media.
- Renderer crashes cancel preparation owned by that renderer while retaining the WebContents lifecycle registration for a later reload.
- Expanded the regression inventory to every `*.test.js/mjs/cjs` under `src` and `tests`, with no symlink/dependency traversal and at most four processes. This exposed and fixed 35 missing Japanese onboarding labels and three host-dependent RTX test fixtures; RTX production behavior is unchanged.

## Combined verification

All checks below ran in the integration checkout, using synthetic fixtures rather than user projects.

| Check | Result |
| --- | --- |
| Full Node regression inventory | 158 files; 1,681 tests: 1,680 pass, zero fail/cancelled, one optional real-RIFE skip |
| Production renderer build | Passed, 2,239 modules; existing Vite/Browserslist/chunk warnings only |
| Native main/preload/preparation syntax and Linux dependency gate | Passed |
| Preparation suite including new native Trash boundary | 94/94 passed |
| Real renderer MCP fixture | 157-tool catalog and 40 parity definitions; apply/preview/Undo/stale guards passed |
| Settings/removal browser fixture | 18 groups passed; responsive layouts, keyboard tabs, themes, confirmation/recovery |
| ComfyUI onboarding browser fixture | 13 groups passed; simulated Linux/Windows/macOS setup, explicit connect and failures |
| Asset-browser fixture | Eight groups passed; remount, project reset, deletion fallback, persistence and no dirty edits |
| Music fixture | Passed YuE2/ACE compatibility, recovery, audition/import/Undo; synthetic audio, live generation disabled |
| Export priority fixture | Ten groups passed; UI locks, cancel/retry, worker failures and MCP exports |
| Export workspace fixture | 27 groups passed; layout/resizing, delivery presets, transport, queue and fallback labels |
| Native export activity IPC | Sandboxed hidden workers; progress, reload, cancellation, crash/close and recovery passed |
| Native GPU readback | RTX 5090; exact pixels and queued-frame order preserved in normal and forced timeout paths |
| Native hidden-export scheduling | No display-refresh callbacks; ordering/cancellation/recovery passed; six-second 1280×720 H.264 output, 144 frames at 24 fps, ffprobe and complete decode passed |
| Synthetic playback/proxy preparation | Bounded encoder concurrency, short GOP, CPU fallback and unchanged source hash passed |
| Scope audit and whitespace checks | Accepted app changes and upstream safeguards preserved; excluded experiments absent |

Native Electron checks used the existing root-owned sandbox helper from the regular checkout, without disabling the sandbox. Browser fixtures used a separate loopback-only Vite server with no ComfyUI proxies. Selected screenshots were visually inspected. No real music/model generation, credit use, public posting or user-media deletion was performed.

Temporary local review artifacts include `/tmp/velorn-settings-media-4zU7VN`, `/tmp/velorn-comfy-setup-ui-hC5ake`, `/tmp/velorn-export-priority-aufna2`, `/tmp/velorn-export-workspace-dSuYDD`, and `/tmp/velorn-export-scheduling-EQ3SBq/synthetic-export.mp4`. These are not committed and may disappear after reboot.

After promotion to the regular folder, app code matched `7e0529a` exactly. The production build, all 158 Node test files (1,680 pass, zero failures, one optional RIFE skip), native main/preload syntax and Linux dependency gate passed again there. All 27 direct dependencies and 591 installed package entries match the combined version; the only prior lock difference was application version metadata. No dependency reinstall was needed.

## Limits and review

This integration has not been packaged on Windows/macOS or published. Simulated platform tests and prior maintainer approval of fullscreen on all three systems do not replace fresh packaged-platform verification before a release. Real RIFE/model generation was not repeated. The native Trash lease coordinates playback/proxy preparation, not every possible external filesystem writer. Export UI suspension does not claim exclusive hardware ownership or cancel already-running background preparation.

For interactive review, save and fully quit other Velorn development sessions first. In a terminal:

```bash
cd velorn
npm run electron:dev
```

No runtime override or sandbox-disabling flag is needed in the regular folder. The app uses normal Velorn settings/projects when you launch it, so use a test project or a saved copy for hands-on checks. Future merge/push/release work needs separate authorization and the normal release/CLA/platform-build process.
