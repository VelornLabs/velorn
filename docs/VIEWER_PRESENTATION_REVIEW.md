# Viewer-only fullscreen review

Local implementation: `velorn-mcp-parity`, branch `codex/export-priority`, alongside the accepted export fixes. No commit, main merge, push or release is part of this change.

## Behavior

- The viewer fullscreen button presents the existing viewer, not the editor layout. The same canvas/video remains mounted, and playback continues.
- On macOS, presentation uses Electron's simple fullscreen on the current desktop rather than opening a native fullscreen Space. Windows/Linux use their native fullscreen window mode while HTML fullscreen isolates the viewer content.
- Escape or the exit button restores the previous window bounds/maximized state and the viewer's previous zoom/pan. Entry fits the picture automatically.
- Space, J/K/L, slow shuttle, frame stepping and transport controls remain available. Hidden timeline editing shortcuts, transform/mask gizmos and clip-selection callbacks do not edit the project during presentation. Native controls such as the volume slider retain their keyboard behavior.
- The ordinary app fullscreen control stays separate. Entering viewer mode from an already fullscreen app preserves the app's prior fullscreen state on exit.
- Pending entry, failures, native exit, unmount/navigation and renderer loss are cleaned up. Presentation dimensions are not persisted as the normal window geometry.

Restart the review app before trying this: both Electron main and preload changed. An old desktop preload displays a restart message instead of falling back to the old macOS fullscreen behavior. A browser-only development session still uses ordinary browser HTML fullscreen.

## Boundaries

`PreviewPanel` uses `useViewerPresentation` and the injectable renderer controller in `src/services/viewerPresentation.mjs`. HTML fullscreen keeps the existing panel mounted; `disableHtmlFullscreenWindowResize` prevents it from automatically changing native window state. `electron/viewerPresentation.cjs` owns native presentation, restoration, lifecycle cleanup and main-frame-only IPC authorization. `viewerPresentationKeyboard.mjs` owns keyboard events while the hidden editor remains mounted.

This is a UI-only layout/presentation control, not a new authored editing operation; it does not require another MCP tool or change project serialization, Undo or export output. The separate pop-out preview window's own fullscreen behavior is unchanged.

## Verification

2026-09-18: all 42 focused tests pass; the 109-file combined inventory reports 1,216 passing, zero failures and one optional real-RIFE skip. Production build and native syntax checks pass (existing bundle/dependency warnings remain). Nine isolated sandboxed Electron UI groups pass, covering exact frame steps, shuttle/slow rates, hidden-authoring isolation, native slider keys, zoom/bounds restoration, failure rollback, unmount and delayed entry/exit races. Review artifacts: `/tmp/velorn-viewer-presentation-results-YdYhW7/`.

Run focused native/renderer/keyboard regressions:

```bash
npm run test:viewer-presentation
```

The combined MCP/editing/export regression inventory includes these tests:

```bash
npm run test:mcp-parity:regressions
npm run build
```

The isolated real-Electron fixture imports the real preview and timeline, uses synthetic media and a temporary profile, and does not open a user project or start the normal MCP server. Run a separate Vite server on a free loopback port (default fixture port 5198), then:

```bash
VELORN_TEST_URL=http://127.0.0.1:5198 PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/check-viewer-presentation.cjs
```

It writes screenshots/results to a new `/tmp/velorn-viewer-presentation-results-*` directory. The fixture matches production's frameless Linux/Windows window configuration, which matters when comparing restored bounds.

Linux real-Electron checks and simulated macOS/Windows controller tests do not replace native platform review. Before release, check on macOS that no new Space opens, Escape restores the original window, and fullscreen playback remains smooth. Also check a maximized window, an app already in native fullscreen, multiple displays, and Windows/Linux packaged builds. No current user project was changed by this feature's tests, and the normal review app was not restarted automatically.

Maintainer follow-up on 2026-09-18: confirmed the viewer fullscreen change works on Mac, Linux and Windows. Future release packaging checks remain separate.
