# ComfyStudio

ComfyStudio is an open-source desktop AI video workstation for creators who use ComfyUI. It brings planning, generation, asset management, timeline editing, captions, effects, and export into one project-based app.

Use built-in local and cloud workflows, bring your own ComfyUI API workflow JSON, or install the bundled ComfyStudio Bridge so a graph open in ComfyUI can be sent back into ComfyStudio.

**Website:** [comfystudiopro.com](https://comfystudiopro.com)

**Downloads:** [GitHub Releases](https://github.com/JaimeIsMe/comfystudio/releases)

<p align="center">
  <img src="docs/readme/editor-timeline.png" alt="ComfyStudio editor with generated assets, preview, timeline tracks, and inspector" />
</p>

## What ComfyStudio Is For

- Creating music videos from lyrics, timing, characters, keyframes, video shots, and timeline edits.
- Building UGC-style creator ads and small-business ads with editable shot plans.
- Running curated local and cloud image/video workflows from one Generate workspace.
- Running custom ComfyUI image, video, keyframe, and music-video workflows inside the app.
- Editing generated clips with tracks, transitions, effects, captions, proxy/cache tools, and export.
- Keeping generated media, prompts, workflow outputs, and timelines organized inside a project.

ComfyStudio is not a replacement for ComfyUI. It is the production layer around ComfyUI: plan the work, send jobs to ComfyUI, collect the outputs, and finish the edit.

<p align="center">
  <img src="docs/readme/create-workflows.png" alt="ComfyStudio Create workspace with UGC, business ad, music video, and short film creators" />
</p>

## Download

Most users should download the packaged desktop app from the [GitHub Releases page](https://github.com/JaimeIsMe/comfystudio/releases).

Release assets include:

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

Ignore GitHub's auto-generated source-code archives unless you plan to build ComfyStudio from source.

## Main Features

### Generate

Generate runs built-in local workflows, cloud/partner workflows, and custom ComfyUI workflows.

- Local image, video, image-edit, audio, and utility workflows.
- Cloud workflows such as Nano Banana 2, GPT Image 2, Seedance, Kling, and other partner-node routes where available.
- Custom Image and Custom Video workflows for users who want ComfyStudio to run their own ComfyUI API graphs.
- API JSON import for advanced users who prefer exporting workflows manually from ComfyUI.
- ComfyStudio Bridge support so compatible graphs can be sent from ComfyUI back to the correct ComfyStudio panel.
- Workflow setup checks for missing nodes, models, credentials, and configuration.

### Create

Create contains guided creator workflows built on ComfyStudio's Director Mode engine.

- **Music Video Creation** - turns a song, lyric timing, characters, references, and a director script into keyframes, video shots, and an editable timeline.
- **UGC Creator** - builds creator-style social ads with hooks, dialogue, product demos, try-ons, testimonials, and editable shot-by-shot outputs.
- **Business Ad Creator** - builds offer-first ads for local businesses, ecommerce products, events, services, and small teams.
- **Short Film Creation** - experimental script-to-scene coverage workflow. This is still very beta and may have rough edges.

### Music Video Creation

The Music Video Creator supports:

- Song import and lyric timing.
- ASR transcription or pasted-lyrics alignment into SRT.
- People/cast setup, including existing character sheets.
- Per-shot keyframe prompts, reference images, prompt copy, prompt editing, image replacement, and shot reruns.
- Built-in keyframe routes such as Qwen Image Edit and Nano Banana 2.
- Custom keyframe workflows using ComfyStudio endpoint nodes.
- Built-in video routes such as LTX 2.3 Music and WAN 2.2.
- Custom video workflows with optional injected keyframe image, prompt, seed, width, height, FPS, duration, and audio.
- Timeline assembly from generated shot assets.

<p align="center">
  <img src="docs/readme/music-video-custom-workflow.png" alt="Music Video Creator keyframe step with custom ComfyUI workflow controls and generated keyframes" />
</p>

### Timeline Editor

The editor includes:

- Project asset browser.
- Multi-track video/audio timeline.
- Clip trimming, moving, snapping, overlap replacement behavior, and transitions.
- Adjustment layers and visual effects.
- Inspector controls.
- Proxy/cache tools for smoother playback.
- Export panel for final renders.

### MoGraph

MoGraph is a beta motion-graphics workspace for designing titles, lower thirds, callouts, and reusable graphic presets without leaving the app.

<p align="center">
  <img src="docs/readme/mograph.png" alt="MoGraph preset gallery with lower-third preview and style controls" />
</p>

### Captions

Captions can be generated from edited timeline audio and styled in-app.

- Timeline-aware transcription.
- Caption style presets.
- Font, color, outline, background, shadow, and animation controls.
- Saved caption style presets for reuse.
- Live preview with play/scrub controls and safe-zone overlays.
- Export-ready caption renders.

### Flow AI

Flow AI is a node-based workspace for chaining generation steps and routing results back into the same project asset pipeline used by Generate.

<p align="center">
  <img src="docs/readme/flow-ai.png" alt="Flow AI node canvas with prompt, keyframe, animation, and asset output nodes" />
</p>

### Export

The Export tab includes practical render presets, hardware-accelerated options where available, queue controls, and project-aware output settings.

<p align="center">
  <img src="docs/readme/export-settings.png" alt="ComfyStudio export settings with presets, codec controls, and export queue" />
</p>

### Stock

The Stock tab uses Pexels so you can search and import photos or videos directly into the current project. A Pexels API key is optional and can be added in Settings.

### ComfyUI Integration

ComfyStudio talks to a local ComfyUI server and can also help launch it.

- Default endpoint: `http://127.0.0.1:8188`
- Custom port support in Settings.
- Windows launcher support for a configured ComfyUI start script.
- macOS launcher support for a configured `ComfyUI.app`.
- Optional auto-start, stop-on-quit, and restart behavior.
- Embedded ComfyUI tab for opening and editing graphs.
- ComfyUI account login support inside the embedded ComfyUI tab.
- ComfyUI credit balance display when available.

Only localhost/loopback ComfyUI endpoints are supported in the desktop app.

## Custom Workflows

Custom workflows are one of the main reasons ComfyStudio exists.

Advanced users can:

1. Open a starter graph from ComfyStudio.
2. Modify it in ComfyUI.
3. Keep the required ComfyStudio endpoint nodes.
4. Send it back with the ComfyStudio Bridge or import the API workflow JSON manually.
5. Run that graph from ComfyStudio as part of a creator flow or from Generate.

Common endpoint nodes include:

- `COMFYSTUDIO_INPUT_IMAGE`
- `COMFYSTUDIO_PROMPT`
- `COMFYSTUDIO_SEED`
- `COMFYSTUDIO_WIDTH`
- `COMFYSTUDIO_HEIGHT`
- `COMFYSTUDIO_FPS`
- `COMFYSTUDIO_DURATION`
- `COMFYSTUDIO_AUDIO`
- `COMFYSTUDIO_OUTPUT_IMAGE`
- `COMFYSTUDIO_OUTPUT_VIDEO`

If an endpoint is present, ComfyStudio can inject that value. If an endpoint is not present, the graph controls that setting itself.

<p align="center">
  <img src="docs/readme/comfyui-bridge.png" alt="Embedded ComfyUI graph with ComfyStudio endpoint nodes and Send to ComfyStudio button" />
</p>

## Requirements

Minimum for normal app use:

- A separately installed local ComfyUI.
- Enough disk space for generated media and project assets.

Optional integrations:

- Comfy account login or API key for paid partner-node workflows.
- Pexels API key for the Stock tab.
- LM Studio for the local LLM Assistant.

Local workflow requirements vary by model. Some workflows can run on modest GPUs, while heavy video workflows may need 24 GB+ VRAM. Cloud workflows shift most of that requirement to the provider but may require credits.

## First Run

1. Install and launch ComfyStudio.
2. Choose a projects folder.
3. Create or open a project.
4. Configure ComfyUI in `Settings > ComfyUI Connection`.
5. Use `ComfyStudio > Getting Started` from the bottom menu if you want the guided setup path.

If ComfyUI is running on a non-default port, update the endpoint in Settings and run the connection test.

## ComfyUI Setup Notes

ComfyStudio ships workflow JSON files, but workflows still need the correct ComfyUI environment.

Depending on the workflow, users may need:

- Custom nodes installed in ComfyUI.
- Model files in the expected folders.
- Cloud/partner credentials.
- CORS enabled for the local ComfyUI endpoint.
- Enough local VRAM for the selected model and resolution.

Inside Generate, use the workflow setup and dependency tools when something is missing.

## Run From Source

For development, run the Electron app:

```bash
npm install
npm run electron:dev
```

Browser-only `npm run dev` is useful for frontend work, but Electron is the normal development path because many features depend on desktop APIs.

## Build Commands

```bash
npm run build
npm run electron:build:win
npm run electron:build:mac
npm run electron:build:linux
```

Packaged artifacts are written to `release/`.

For release process details, see:

- `docs/RELEASE_PROCESS.md`
- `docs/CI_SECRETS.md`
- `docs/AI_RELEASE_HANDOFF.md`

## Roadmap

See [ROADMAP.md](ROADMAP.md).

<p align="center">
  <a href="ROADMAP.md">
    <img src="docs/roadmap-overview.svg" alt="ComfyStudio roadmap overview" />
  </a>
</p>

## Contributing

ComfyStudio is open source, and contributions are welcome.

See:

- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`

## License

ComfyStudio is licensed under the GNU General Public License v3.0. See `LICENSE`.

Versions released before this license change remain available under the license terms they were released with.
