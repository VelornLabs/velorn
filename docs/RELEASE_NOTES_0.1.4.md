# Velorn v0.1.4 Draft Release Notes

## Highlights

- Major timeline and editing polish since `v0.1.3`
- Added customizable editor hotkeys and keymap presets for faster editing
- Stronger inspector, preview, and dope sheet workflows
- Improved project autosave and recovery safety
- Better sequence and timeline management in the Assets panel
- Refreshed workflow starter pack metadata and release assets for `v0.1.4`
- New `MoGraph` workspace in beta for building transparent motion graphics assets inside Velorn

## Editing And Timeline Improvements

- Added exact clip move-by-offset editing with signed timecode or frame entry
- Added exact clip duration changes with signed timecode or frame entry
- Improved multi-clip dragging so grouped and linked clips move more predictably across tracks
- Added stronger sequence management directly inside the Assets panel
- Timelines and sequences can now be opened, renamed, duplicated, deleted, and color-tagged from Assets
- Added more direct timeline editing actions in the header and context flows
- Improved linked audio/video editing behavior for imported media
- Improved gap targeting and ripple-delete cleanup behavior
- Improved text-clip creation and re-entry flows
- Added stronger editing feedback across markers, selection, snapping, and timeline interaction
- Added customizable editor hotkeys plus familiar keymap presets

## Hotkeys And Keymap Improvements

- Added customizable editor hotkeys in Settings so more timeline actions can match the way you already edit
- Added built-in keymap presets for `Velorn`, `Premiere-style`, `Resolve-style`, and `Final Cut-style` bindings
- Surfaced faster default shortcuts for common actions like playhead-based range selection, split, exact move-by-offset, linking, markers, snapping, ripple mode, text creation, and clip enable/disable
- Included `Change Duration...` in the customizable hotkey system as well, even though it does not ship with a default binding yet

## Project Save And Recovery Improvements

- Improved project autosave behavior with rolling snapshot history stored inside each project
- Kept only the most recent autosave snapshots so recovery stays useful without growing forever
- Added save-on-close coverage so projects are more likely to persist cleanly when the app closes or refreshes
- Added a recovery path on the welcome screen so a project that fails to open can offer `Open latest autosave`
- Improved invalid or corrupted project-file handling so bad project JSON is reported more safely instead of crashing the app on load

## Inspector, Preview, And Supporting Polish

- Improved inspector clip headers and clip metadata visibility
- Improved preview transform bounds, handles, and overall manipulation clarity
- Added better transform visibility controls while keeping clip selection active
- Improved audio fade handle behavior and fade drag feedback
- Added per-clip Inspector gain for quieter audio recordings
- Improved timeline audio meters and ruler readability
- Improved Dope Sheet selection feedback and clip/keyframe alignment cues

## Beta: MoGraph Workspace

- Added a dedicated `MoGraph` tab in the main app shell
- Added a preset gallery with categories, favorites, recents, and search
- Added live motion preview with playback and scrubbing
- Added quick controls for text, layout, color, typography, motion, and output
- Added character-level FX controls for offsets, scale, opacity, delay, tint, and rotation
- Added transparent motion asset rendering directly into project Assets
- Added a workspace error boundary so a workspace crash does not take down the full app
- This workspace is still beta and should be presented as an early creative playground rather than a fully finished production feature

## Workflow And Release Prep Updates

- Updated bundled workflow files for newer image-edit and Seedream flows
- Refreshed workflow starter pack manifests, release metadata, and checksums
- Regenerated starter pack release notes for `v0.1.4`
- Added a draft marketing/release site under `site/velorn`

## Important Setup Note

Velorn generation still depends on a separate local ComfyUI installation.

- Local workflows may require manual node/model setup.
- Cloud workflows still use local ComfyUI and may require partner nodes plus a Comfy account API key.
- The Workflow Starter Pack remains optional and is mainly for advanced users who want to inspect or prepare workflows manually.

## Known Limitations

- This is still a pre-release style workflow-heavy desktop app.
- ComfyUI connections are local-only in this build.
- Some workflows still require manual node/model setup in ComfyUI.
- Cloud pricing and partner workflow requirements may vary by provider.
- The `MoGraph` workspace is still beta and may continue changing quickly.

## Suggested GitHub Release Title

`Velorn v0.1.4 - Editing polish and MoGraph workspace`

