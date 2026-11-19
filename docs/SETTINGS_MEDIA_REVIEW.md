# Settings and safe asset removal — local review

Implemented in `velorn-mcp-parity`, branch `codex/export-priority`. This follows
the accepted export, viewer, asset-browser and ComfyUI work in the same dirty
review checkout. No commit, main merge, push or release is authorized.

## Settings

Six groups replace the flat category list: General, Editing, Media & Storage,
Playback & Export, Connections, and New Project Defaults. Each group has small
focused subsections; search matches page/category labels and creator-facing
keywords. Existing `initialSection` destinations remain supported. Connection
and Launcher now open the same single ComfyUI page; the competing manual port
editor was removed. Feedback remains separate.

After maintainer review, subsection tabs were made more prominent: larger
bordered icon buttons, solid active fill, hover/focus feedback and a "Choose a
section" label. They wrap without hiding labels and support accessible
tab/panel semantics, roving focus, Left/Right and Home/End. All six themes retain
at least 4.5:1 tab-label contrast. Expanded browser verification passes 18 groups
at 1200px and 900px, including the prior removal checks, with screenshots under
`/tmp/velorn-settings-media-yLfmcv/`. This follow-up is renderer-only and does
not change preference values, native behavior or authored project state.

Playback-cache maintenance is explicitly current-project work. Hardware FFmpeg
is under advanced export tools. Cloud credentials/credit display, appearance,
timeline display and media/import preferences are grouped by purpose. Existing
settings and their storage keys remain compatible.

The old global Save wrote unrelated credentials, shortcuts, ports and paths.
It is replaced by section-specific Save API key / Save shortcuts / Save media
folders controls for drafted fields. Other preferences are labelled automatic;
connection/installation/maintenance actions remain explicit. Save failures are
shown, including native `{success:false}` replies for Pexels and shortcuts.
This is a focused UI/save-feedback cleanup, not an atomic transaction layer for
every legacy preference setter. Drafts remain in the open Settings component;
closing without Save discards unsaved drafted fields.

## Removal behavior

- `assetsRemovalModeV2` defaults to `project-only`. The legacy implicit `disk`
  setting is deliberately ignored; users must freshly opt into Trash.
- The always-visible Delete Disk / Project Only toolbar is gone. Set the
  default in **Media & Storage → Import & removal**. Explicit context-menu
  actions let users keep files or review a Trash plan without changing it.
- Project-only removal keeps every disk file. As before, removing an asset
  entry can make ordinary timeline uses unavailable; confirmation warns about
  that. Existing compound protection remains intact.
- Trash lists exact primary media and explicit cache/proxy/thumbnail paths.
  Normal copied imports keep their outside original. A linked/legacy absolute
  original is clearly marked EXTERNAL. No image-sequence source directory or
  unlisted sidecars are recursively cleaned up.
- Files shared by remaining assets are retained; native canonical-path checks
  also protect aliases. Trash refuses selected media still referenced by any
  project timeline (including compound/mask/effect references).
- Native `fs:trashAssetFiles` is editor-main-frame-only, bounded, serialized,
  regular-file-only and uses `shell.trashItem`. It rejects roots, directories,
  symlinks, traversal and ambiguous Windows paths; file identity is rechecked.
  Missing files are no-ops. There is **no permanent deletion fallback**.
- The native batch has a blocking progress dialog. A module-level transaction
  guard survives panel remounts; new renderer MCP mutations are refused during
  review/removal (simple metadata reads remain available). No filesystem Trash
  operation is exposed as a new MCP tool; asset preferences are UI-only.
- Project/selection/file-reference snapshots are rechecked after confirmation
  and native completion. Partial failures keep project entries and explain
  recovery through the OS Trash. If the panel unmounts, a window-level alert
  preserves the failure/recovery notice instead of awaiting an invisible dialog.

Native Trash is recoverable through the OS, not through Velorn Undo. Path-based
OS APIs cannot offer a perfectly atomic file-handle transaction; already-running
background edits or external filesystem changes remain possible. The checks
reduce those races and report recovery when state changes during a batch, but
do not claim filesystem-wide atomicity. Symlinked project paths deliberately
require project-only removal rather than guessing which target to trash.

## Verification

- `npm run test:settings-media`: 49 focused tests covering navigation/search,
  preferences, exact path inventories, native Trash, main-frame IPC and save
  failures. Windows/macOS native behavior uses injected platform mocks.
- The combined 120-file regression inventory passes with 1,352 tests and one
  optional real-RIFE skip. Native syntax, diff checks and production build pass
  (the existing bundle/Browserslist/Vite warnings remain).
- `scripts/check-settings-media.cjs` drives real Settings/Assets components in
  an isolated browser with synthetic assets and mocked native APIs. It covers
  default/legacy preferences, search/deep links, project-only and explicit Trash,
  external warnings, failure/partial failure/no native fallback, long scrolling
  path inventories, Windows acknowledgements, pending-operation unmount and
  fresh-store folder review. No user project, normal settings, external endpoint
  or real media is touched. All 15 groups pass; screenshots/results are under
  `/tmp/velorn-settings-media-4avOBS/`. The prior asset-browser (8 groups) and
  ComfyUI-setup (13 groups) browser regressions also pass.
- `tests/fixtures/asset-trash-electron.cjs` is a separate Electron process with
  no normal app/MCP/BrowserWindow. On Linux it successfully moved its own newly
  created disposable file to the real system Trash, refused a directory and a
  protected file, then confirmed a missing-file no-op. Results were under
  `/tmp/velorn-trash-fixture-rhBlqN`; the disposable file remains recoverable in
  system Trash. Actual macOS/Windows packaged validation is still pending.

Fully quit and reopen the review Velorn app before testing native Trash; old
preloads correctly refuse it and recommend restarting or project-only removal.
The normal app, ComfyUI and user projects were not restarted or modified.
