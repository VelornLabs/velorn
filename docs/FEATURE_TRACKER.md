# Velorn Feature Tracker

This file is a running list of user-facing changes we have shipped or are actively shaping.

The goal is to keep one simple place for:

- release note drafting
- X / Twitter post drafting
- shortcut tracking
- screenshot and demo ideas

We should keep updating this file as new features land.

## Recently Added

### Timeline and Editing Workflow

- Preview still capture from the preview panel into project assets
- Select clips from the playhead to the end of the timeline
- Select clips from the start of the timeline to the playhead
- Split at playhead on the active track
- Split all tracks at the playhead
- Move selected clips by an exact signed offset
- Change selected clip duration by an exact signed amount
- Support both timecode and frame-based precision entry in exact-edit dialogs
- Multi-clip dragging across tracks now keeps linked and selected groups moving as one stable block, preserves spacing, and resolves crowded drops more predictably
- Linked audio and video clip pairs for imported media with audio
- Manual `Link Selected` and `Unlink Selected` actions in the timeline
- Linked audio/video pair selections can now stay multi-selected while the Inspector switches between focused `Video` and `Audio` controls
- Horizontal timeline wheel navigation
- Timeline wheel input now stays focused on horizontal timeline travel without accidental vertical track scrolling
- Playback follow so the playhead stays visible while the timeline is running
- `Arrow Up` and `Arrow Down` can jump the playhead across visible clip boundaries
- `Shift+Arrow Up` and `Shift+Arrow Down` can jump between timeline markers
- Keyboard clip-boundary and marker jumps now keep the playhead visible by following the timeline viewport
- Clip-boundary and marker navigation is now exposed through the hotkey system for reassignment
- Click empty space on a track to select a timeline gap as its own target
- Selected gaps get a visible highlight and can be cleared with `Esc`
- Ripple delete for selected clips when ripple mode is enabled
- Delete a selected gap to close that empty space directly on the targeted track
- Linked clips now stay in sync when a selected gap ripples one of them forward
- Audio fade handles now show intuitive ramp direction and a `seconds:frames` drag readout
- Preview transform bounds can extend outside the visible frame while the media stays clipped inside it
- Preview transform gizmo now has clearer corner-based rotation handles plus stronger visible bounds
- Preview viewer now lets you hide transform controls while keeping the selected clip active for looping and playback checks
- Audio clips now have per-clip Inspector gain with boosted preview, meters, and export mix support for quiet recordings
- Timeline audio meters now stop cleanly with playback and use clearer `5 dB` ruler ticks and labels
- Text clips can now be added to the active video track and jump straight into editing from the text panel, a hotkey, timeline double-click, or preview double-click
- Timeline header now surfaces a compact `Edit` group for split, copy, paste, enable or disable, delete, and text clip creation without leaving the main timeline UI
- Dragging a video clip above the top of the visible video stack can now create a new video track automatically on drop
- Inspector clip headers now surface richer media info like resolution, FPS, codec, format, size, and timecode summaries
- Inspector section collapse state now persists across app restarts
- Timeline marquee selection now works by dragging on empty track space, supports additive modifiers, and auto-scrolls while sweeping large areas
- Timeline markers now read as distinct bookmark-style flags while the playhead has a stronger transport-style indicator
- Dope Sheet keyframes now show clearer active vs secondary selection colors and support easier grouped dragging
- Dope Sheet now shows a clip reference strip above keyframe rows so animation timing can be lined up against source imagery
- Clips can now be disabled individually with a hotkey or context-menu action, while staying visible for edit decisions in the timeline
- Fixed undo for link and unlink actions

### Timeline and Sequence Management

- Timelines now appear in the Assets panel like real sequence items
- Open timelines from the Assets panel
- Rename timelines from the Assets panel
- Duplicate and delete timelines from the Assets panel
- Color-code timelines in the Assets panel
- Create new timelines from the Assets panel context menu
- Project-level undo and redo for timeline structure changes

### App and UI

- Five dark themes with live switching:
  `Midnight`, `Soft Dark`, `High Contrast`, `Arctic`, `Ember`
- Fixed the custom restore-down / maximize behavior when the app starts fullscreen
- Export now makes NVIDIA NVENC easier to understand by surfacing supported codecs, the detected GPU, and the expected encoder path

## Shortcut Notes

These are the most important shortcut-related additions or surfaced editing shortcuts we may want to call out publicly.

- `E`: Select clips from playhead to end
- `Shift+E`: Select clips from start to playhead
- `X`: Split at playhead on active track
- `Shift+X`: Split all tracks at playhead
- `Ctrl+Shift+M`: Open `Move by Offset...`
- `Ctrl+L`: Link selected clips
- `Ctrl+Shift+L`: Unlink selected clips
- `S`: Toggle snapping
- `R`: Toggle ripple edit
- `M`: Add marker at playhead
- `Arrow Up` / `Arrow Down`: Jump to previous or next visible clip boundary
- `Shift+Arrow Up` / `Shift+Arrow Down`: Jump to previous or next marker
- `D`: Enable or disable selected clips
- `T`: Add a text clip at the playhead and start typing
- `+` / `-`: Zoom timeline in and out
- `Esc`: Clear selected clips, markers, transitions, or gap targets
- `Delete` / `Backspace`: Ripple delete selected clips while ripple mode is on, or close a selected gap

Notes:

- `Change Duration...` currently has no default shortcut.
- Editor hotkey presets also exist for Velorn, Premiere-style, Resolve-style, and Final Cut-style bindings.

## Screenshot and Demo Ideas

Good visuals to capture for posts, release notes, or short clips:

- Theme picker in Settings showing all five dark themes
- `Move by Offset...` dialog showing timecode and frame modes
- Timeline selection from playhead to end / from start to playhead
- Split on one track versus split all tracks
- Sequence items mixed directly into the Assets panel
- Linked video/audio clips moving together across the timeline
- `Link Selected` / `Unlink Selected` context menu actions
- Multi-clip drag across several video and audio tracks while linked pairs stay together and snap cleanly without jitter
- Timeline wheel scrolling and playhead follow during playback
- Gap targeting highlight on an empty section of a track before ripple-delete lands
- Ripple delete closing a selected hole on one track without touching others
- Audio fade drag with the new `seconds:frames` badge over the waveform
- Audio Inspector gain boosting a quiet clip above `0 dB` while the meter reacts live
- Timeline audio meters dropping cleanly to silence on stop with the denser `5 dB` scale visible beside them
- Add text on the active track and immediately type into the Inspector after creating or double-clicking a text clip
- Timeline header showing the new compact `Edit` group while split, copy, paste, delete, and text buttons enable and disable with selection state
- Drag a clip above the top video lane and release to show automatic top-track creation
- Preview transform gizmo showing out-of-frame bounds and corner rotation handles
- Preview toolbar toggling transform controls on and off while the same clip stays selected
- Inspector header showing clip start / duration / source timing in `hours:minutes:seconds:frames`
- Empty-lane drag marquee grabbing a large block of clips without needing `Alt`
- Timeline ruler showing the new marker flag styling versus the warmer playhead indicator
- Dope Sheet showing selected time columns and multi-keyframe drag across several properties
- Before/after clip organization using multi-clip drag across tracks

## Suggested X / Social Talking Points

- Velorn is getting faster for real editing, not just generation
- Precision editing now supports exact offsets in timecode or frames
- Timeline workflows are more NLE-like with sequence management inside Assets
- Linked audio/video clip pairs help keep sync intact while editing
- Multi-clip drags now feel more dependable because grouped clips keep their layout and stop snapping to themselves
- Navigation is quicker with wheel scrolling, `+` / `-` zoom, and playhead follow
- Empty-space targeting lays the groundwork for ripple delete and future gap actions
- Ripple delete now makes cleanup faster for both clips and selected dead space
- Fade handles feel more like an NLE with clearer ramp direction and drag timing feedback
- Inspector audio gain now boosts quiet clips directly in preview and export without leaving the editor
- Timeline audio meters now feel more trustworthy with cleaner stop behavior and a clearer ruler
- Text editing is becoming faster by letting you create or re-enter text clips without hunting through side panels
- The timeline is becoming more mouse-friendly by surfacing core split, copy, paste, delete, enable or disable, and text actions directly in the header
- Preview transforms feel closer to Photoshop / After Effects with more legible bounds and rotation handles
- Inspector headers now show clip metadata and timecode more like a real editing app
- Large timeline selections are faster now that marquee drag works directly from empty track space
- Markers and the playhead are easier to parse at a glance thanks to clearer color and shape separation
- Keyframe editing is getting faster with clearer selected states and more usable multi-key dragging
- New dark themes make the app feel more customizable without changing the default look

## Next Up

Current Phase 1 roadmap queue is complete.

The recent editing-focused Phase 2 roadmap items around exact edits, sequence access, navigation, hotkeys, and NVENC discoverability are now shipped.

The next major work can move to newly prioritized editing ideas or the broader workflow-expansion items in `ROADMAP.md`.
