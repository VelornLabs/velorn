# Velorn Roadmap

Velorn is evolving into an AI-native editing and generation environment built around ComfyUI.

The goal is simple: make it easier to go from idea to edit to finished output inside one tool.

This roadmap reflects our current priorities. It will continue to evolve as we ship features, test workflows, and get feedback from real users.

## Current Direction

Our focus is split across three major areas:

1. Core editing polish
2. Expanded generation workflows
3. Higher-level creative tooling, including music video generation

Near-term execution note:

We want to handle the next editing improvements one at a time. The goal is to ship, test, and stabilize each feature before moving to the next one so bugs stay manageable and the workflow gets better in clear steps instead of large batches.

## What Already Exists

Velorn already includes a strong foundation that we want to keep improving:

- Timeline-based editing
- Asset browser and preview workflow
- Cut at playhead
- Marquee selection
- Audio waveforms
- Track management
- Text layers and inspector controls
- Local and cloud ComfyUI workflow support
- Built-in workflow dependency checks
- Director Mode and guided generation flows

The roadmap below focuses on making these systems faster, deeper, and more production-friendly.

## Phase 1: Core Editing Polish

These are the highest-priority editing improvements aimed at making the editor feel faster, tighter, and more professional for day-to-day use.

- Cut through all tracks at the playhead
- Select everything from the playhead to the end of the timeline
- Visual fade in and fade out controls directly on audio clips
- Capture a still frame from the preview window into project assets
- Improve clip movement and timeline precision
- Continue tightening overall editing speed and usability

### Current Step-by-Step Editing Queue

The items below are intended to be handled sequentially, not all at once.

The current Phase 1 queue is complete.

The next roadmap work now rolls into the Phase 2 precision editing items below.

## Phase 2: Precision Editing and Pro Workflow Features

This phase focuses on features that help experienced editors work faster and with more control.

Recent Phase 2 progress that is now shipped:

- Better editing toolbar coverage for split, copy, paste, enable or disable, delete, and text clip creation directly in the timeline header
- Better multi-clip movement across tracks so linked or selected groups keep their layout and drop more predictably
- Move selected clips by exact timecode offset
- Extend clip duration by a chosen amount
- Show timelines and sequences directly from the Assets panel with open and management workflows
- Fully customizable keyboard shortcuts and hotkeys in settings
- Editor keymap profiles with familiar presets such as Premiere Pro, Resolve, and Final Cut Pro
- Keep mouse-wheel behavior inside the timeline focused on horizontal travel only, without unintended vertical track scrolling when many tracks are off-screen
- Add keyboard navigation for jumping between clip boundaries and markers, including assignable bindings for next or previous clip edges and marker jumps
- Make NVENC export support easier to discover and understand in the packaged app so GPU encoding feels more obvious for users with supported NVIDIA hardware

Remaining Phase 2 priorities:

- The current editing-focused Phase 2 checklist is complete.
- The next editing priorities can now be driven by new workflow feedback and higher-level product goals.

## Phase 3: Workflow Expansion

Velorn is not just an editor. It is also a generation environment. This phase focuses on expanding creative options inside the app.

- Add more built-in workflows
- Expand both local and cloud workflow coverage
- Improve workflow discovery and usability
- Add stronger workflow grouping by use case
- Improve setup guidance for models, nodes, and dependencies
- Continue building workflows for image, video, audio, and hybrid pipelines

## Phase 4: Music Video Generation

One of the most exciting directions for Velorn is turning it into a more complete system for music-driven creative output.

This phase is focused on building a dedicated music video generation workflow that can help creators move from concept to sequence faster.

Areas we want to explore:

- Music-driven generation workflows
- Faster shot ideation for songs and visual themes
- Better sequencing between generated clips and edit decisions
- Tools that support rhythm, pacing, and structure
- A smoother path from generated visuals to a finished music video timeline

This area is still being shaped and will likely grow based on experimentation and creator feedback.

## Phase 5: Creative Automation and Higher-Level Tools

Beyond individual workflows, we want Velorn to become a stronger creative system for structured generation and editing.

Longer-term areas of interest include:

- Smarter sequence building
- Better AI-assisted edit preparation
- More advanced shot planning tools
- Stronger automation between prompts, assets, and timeline structure
- Better project templates for repeatable creative workflows

## Product Principles

As Velorn grows, we want to stay grounded in a few principles:

- The editor should feel fast and intuitive
- Generation should support the edit, not interrupt it
- Powerful features should still feel accessible
- Local-first creative workflows should remain a core strength
- Real user feedback should continue shaping priorities

## Notes

This roadmap is a living document. Priorities may shift as features ship, workflows mature, and new feedback comes in.

If you use Velorn and have thoughts on editing, generation, or workflow design, feedback is always welcome.
