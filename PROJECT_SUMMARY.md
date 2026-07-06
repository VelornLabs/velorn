# Velorn - AI Animatic Studio

## Overview
AI-powered video editing app with DaVinci Resolve-style UI. Integrates with ComfyUI for AI video generation.

| Aspect | Details |
|--------|---------|
| **Type** | React + Vite + Tailwind CSS; runs as **Electron** desktop app (`npm run electron:dev`) or web (`npm run dev`) |
| **AI Backend** | ComfyUI at `http://127.0.0.1:8188` |
| **Storage** | Electron: native paths; Web: File System Access API + localStorage |
| **Location** | `c:\Users\papa\Documents\coding_projects\general\comfyui_editing` |
| **Browser** | Chrome/Edge for web mode; Electron for desktop (recommended) |

**For new chats:** This file is the main project reference. App is ~95% complete. Latest: **Live drop preview** — dragging an asset from Assets to the timeline shows a ghost clip on the target track/time before mouse-up. Also: Inspector sliders reset on double-click; number inputs have no spinners (double-click to type); transition handle drag 1:1 with mouse; Resolve-style transition tile; timeline vertical scroll synced. See "Key Files" and "Recent Changes Log" for details.

## Running the App
```bash
npm run dev
```
Opens at `http://localhost:5173`

**Splash screen:** Place your splash image at **`public/splash.png`** (or `public/splash.jpg`). It is shown for 3 seconds when starting the Electron app (`npm run electron:dev` or the built app) before the main window opens. Subtitle on splash: "Velorn — AI Animatic Studio".

## Layout Structure

### Normal Mode (Contracted Left Panel)
```
┌─────────────────────────────────────────────────────────┐
│  [🏠] Velorn │ Project Name │ [💾]    Title Bar      │
├──┬──────────┬─────────────────────────┬──────────────┬──┤
│I │  Left    │                         │   Inspector  │I │
│C │  Panel   │        Preview          │   Panel      │C │
│O │ (Tabbed) │        Panel            │              │O │
│N │          │                         │  Transform   │N │
│  │[Generate]│                         │  Crop        │  │
│B │[Text]    │                         │  Timing      │B │
│A │[Assets]  │                         │  Effects     │A │
│R │[Workflow]│                         │              │R │
│  │[Settings]│                         │              │  │
├──┴──────────┴─────────────────────────┴──────────────┴──┤
│ [Timeline ▼] │◀◀│◀│ ▶ │▶│▶▶│ 00:00:00   Transport      │
├─────────────────────────────────────────────────────────┤
│                 Timeline (Full Width)                    │
│  Video 1  │ clip │ clip │ TEXT │                        │
│  Video 2  │      │ clip │                               │
│  Audio    │                                             │
└─────────────────────────────────────────────────────────┘
```

### Expanded Mode (Full Height Left Panel - Resolve-style)
```
┌─────────────────────────────────────────────────────────┐
│  [🏠] Velorn │ Project Name │ [💾]    Title Bar      │
├──┬──────────┬─────────────────────────┬──────────────┬──┤
│I │  Left    │                         │   Inspector  │I │
│C │  Panel   │        Preview          │   Panel      │C │
│O │ (Tabbed) │        Panel            │              │O │
│N │          │                         │  Transform   │N │
│  │[Generate]├─────────────────────────┴──────────────┴──┤
│B │[Text]    │ [Timeline ▼]│◀◀│◀│ ▶ │▶│▶▶│ Transport    │
│A │[Assets]  ├───────────────────────────────────────────┤
│R │[Workflow]│           Timeline (Shifted Right)        │
│  │[Settings]│  Video 1 │ clip │ clip │ TEXT │          │
│  │          │  Video 2 │      │ clip │                  │
│  │  [⊞][◀]  │  Audio   │                                │
└──┴──────────┴───────────────────────────────────────────┘
```

### Expand/Contract Toggle
- **Button Location**: Bottom of left panel icon bar (above collapse chevron)
- **Icons**: `PanelLeft` (expand) / `PanelLeftClose` (contract)
- **Behavior**:
  - **Contracted**: Left panel only above timeline (default)
  - **Expanded**: Left panel spans full height, timeline shifts right
- **Use Case**: More panel space for browsing assets/workflows while editing

## Project Management
On first launch, users are prompted to select a **Projects Folder**. All projects are saved here.

### New Project Dialog
- **Project Name**: Required, typed by user
- **Resolution**: Presets (HD 1080p, 720p, 4K, Vertical, Square, Instagram 4:5, Cinematic 21:9) + Custom
- **Frame Rate**: 15, 23.976, 24, 25, 30, 60 fps

### Project Folder Structure
```
MyProject/
├── project.comfystudio        # JSON (timeline, assets, settings)
├── assets/
│   ├── video/                 # Imported videos
│   ├── audio/                 # Audio files
│   └── images/                # Images
├── cache/                     # Playback cache (transcoded for smooth playback) + render cache for effects
├── renders/                   # Exported videos
└── autosave/                  # Auto-save backups
```

### Welcome Screen
- Grid of recent projects (last 10)
- Project cards show: thumbnail, name, modified date, resolution
- "New Project" and "Open Project" buttons
- Click project to open

### Import Footage
Users can import their own media via Assets Panel:
- **Supported**: .mp4, .webm, .mov, .mp3, .wav, .ogg, .jpg, .png, .gif, .webp
- Drag-and-drop or click Import button
- Files are copied to project's `assets/` folder
- Imported assets show "IMP" badge, AI-generated show "AI"
- **Create overlay** (right-click empty area or folder in Assets): Generate **letterbox**, **vignette**, or **color matte** stills (canvas PNGs) at timeline or custom resolution; added as image assets. Drag onto a video track above content and use blend mode/opacity as needed.

### Auto-save
- Saves every 30 seconds (configurable)
- Also saves on window close/refresh
- Toggle in Settings panel

### Title Bar Navigation
- **Home button** (🏠): Returns to Welcome Screen (saves & closes current project)
- **Save button** (💾): Manual save (though auto-save handles this)
- Project name displayed in center
- **Editor/Export tabs**: Resolve-style top tabs centered to the preview area

## Multiple Timelines
Each project supports multiple timelines (like DaVinci Resolve):

### Timeline Switcher
Located in the Transport Controls bar:
- Dropdown showing all timelines in the project
- Click to switch between timelines
- Shows timeline name, clip count, and resolution (if custom)
- Current timeline highlighted with accent color

### Timeline Operations
- **New Timeline**: Opens dialog to set name, resolution, and frame rate
- **Duplicate**: Creates a copy of existing timeline (including all clips and settings)
- **Rename**: Double-click or use edit button
- **Delete**: Remove timeline (can't delete last one)

### Timeline-Specific Settings
Each timeline can have its own resolution and frame rate:
- **When creating a new project**: Settings apply to the first timeline only
- **When creating additional timelines**: Dialog allows specifying unique resolution/fps
- **"Use Project Settings" option**: Quick toggle to inherit from project defaults
- **Custom settings**: Choose different resolution presets or enter custom dimensions

This enables workflows like:
- 16:9 main cut + 9:16 vertical cut for social media
- 4K master + 720p proxy timeline
- 30fps timeline + 24fps cinematic version

### How Timelines Work
- Assets are **shared** across all timelines in a project
- Each timeline has its own tracks, clips, resolution, fps, and other settings
- Switching timelines saves current state automatically
- Preview panel automatically adjusts aspect ratio based on timeline settings
- Timelines with custom settings show resolution badge in the switcher dropdown

## Key Files
| File | Purpose |
|------|---------|
| `src/App.jsx` | Main layout, panel state, auto-save |
| `src/stores/projectStore.js` | Project management, recent projects, file operations |
| `src/stores/timelineStore.js` | Timeline state, clips, tracks, transforms, text clips |
| `src/stores/assetsStore.js` | Asset library (AI + imported), preview state |
| `src/services/fileSystem.js` | File System Access API operations |
| `src/components/WelcomeScreen.jsx` | First-run setup, recent projects grid |
| `src/components/NewProjectDialog.jsx` | Project creation form |
| `src/components/NewTimelineDialog.jsx` | Timeline creation form with resolution/fps settings |
| `src/components/TimelineSwitcher.jsx` | Timeline dropdown for multi-timeline support |
| `src/components/TitleBar.jsx` | App title bar with home/save buttons |
| `src/components/ExportPanel.jsx` | Export UI (Resolve-style settings + queue) |
| `src/components/Timeline.jsx` | Multi-track timeline with clips, resizable track headers |
| `src/components/PreviewPanel.jsx` | Video preview with multi-layer compositing, scroll zoom |
| `src/components/VideoLayerRenderer.jsx` | Video + text layer rendering with preloading |
| `src/components/InspectorPanel.jsx` | Clip transform/crop controls, draggable number inputs |
| `src/components/TransportControls.jsx` | JKL shuttle, I/O points, playback modes |
| `src/components/GenerateWorkspace.jsx` | Generate tab: workflow list, job queue, progress, result import, timeline-frame input |
| `src/components/GeneratePanel.jsx` | Legacy AI video generation UI (Video + Audio tabs) |
| `src/stores/frameForAIStore.js` | Store for “frame from timeline” sent to Generate (Extend with AI / keyframe) |
| `src/utils/captureTimelineFrame.js` | Capture topmost video/image clip frame at playhead for AI extend |
| `src/components/LeftPanel.jsx` | Tabbed left panel container |
| `src/components/panels/TextPanel.jsx` | Text clip creation with styling |
| `src/hooks/useTimelinePlayback.js` | Timeline playback loop with loop modes |
| `src/hooks/useSnapping.js` | Clip snapping logic |
| `src/services/comfyui.js` | ComfyUI API; workflow modifiers (LTX2 t2v/i2v, WAN22 i2v, multi-angles, Qwen image edit + refs, music, mask) |
| `src/components/ImageAnnotationModal.jsx` | Annotate image for Qwen ref: circles, rects, freehand, text; colors; move/resize; export PNG |
| `src/components/OverlayGeneratorModal.jsx` | Create overlay stills: letterbox, vignette, color matte (canvas-generated PNGs added to assets) |
| `src/services/exporter.js` | Timeline export renderer + audio mix + FFmpeg handoff (blend modes via globalCompositeOperation) |
| `src/services/videoCache.js` | Video element pooling and preloading |
| `src/services/playbackCache.js` | Flame-style playback cache: transcode on import for smooth timeline playback (Electron) |

## Timeline Features
- **AI/IMP tags on clips:** Video and image clips show an **AI** (orange) or **IMP** (gray) badge next to the clip name/type, matching the Assets panel (AI-generated vs imported).
- **Multi-track**: Video tracks (add to top), Audio tracks (add to bottom)
- **Audio track names**: Default "Audio 1", "Audio 2", "Audio 3" (user can rename); add track = "Audio 4", etc.
- **Mono vs stereo**: Tracks have `channels: 'mono' | 'stereo'`. Stereo tracks render as double height with L/R bands; mono tracks single height. Export: mono tracks downmix to one channel; stereo preserved.
- **Track Headers**: Resizable by dragging right edge (100-400px, default 208px)
- **Vertical Scrolling**: Track headers (left) and track content (right) scroll together; one scrollbar on the left, right side scrollbar hidden; `min-h-0` on timeline flex chain so content area is properly scrollable
- **Clip Operations**: Drag, trim (head/tail), move, delete, split, duplicate
- **Text Clips**: Amber-colored clips with text preview on timeline
- **Snapping**: To playhead, clip edges, grid (toggle with `S` key)
- **Multi-select**: Shift+click, Ctrl+click, Ctrl+A, Alt+drag marquee
- **Ripple Edit**: Toggle with `R` key
- **Roll Edit**: Drag between adjacent clips
- **Undo/Redo**: Ctrl+Z / Ctrl+Shift+Z (50 states); Delete prioritizes timeline clip selection over Assets panel (so clip delete is undoable)
- **Transitions**: Multiple types (dissolve, fade, wipe, slide, zoom, blur). **Resolve-style tile**: dark grey overlay, transition name + duration pill (e.g. "35f"), top bar with center handle, 50% white diagonal (bottom-left to top-right). Drag left/right handle to resize transition duration (1:1 with mouse via `pixelsPerSecond`).
- **I/O Points**: `I` and `O` keys for three-point editing

## Text Clips
Text clips can be added via the **Text** tab in the left panel:
```javascript
textProperties: {
  text: 'Sample Text',
  fontFamily: 'Inter',           // 10 font options
  fontSize: 64,                  // 12-200px
  fontWeight: 'bold',            // normal, bold, 100-900
  textColor: '#FFFFFF',
  textAlign: 'center',           // left, center, right
  verticalAlign: 'center',       // top, center, bottom
  strokeColor: '#000000',
  strokeWidth: 0,                // 0-10px
  backgroundColor: '#000000',
  backgroundOpacity: 0,          // 0-100%
  backgroundPadding: 20,
  shadow: false,
  shadowColor: 'rgba(0,0,0,0.5)',
  shadowBlur: 4,
  shadowOffsetX: 2,
  shadowOffsetY: 2,
}
```
- Text presets: Title, Subtitle, Lower Third, Caption
- Inspector shows text-specific controls when text clip selected

## Clip Transform Properties
Each clip has a `transform` object:
```javascript
transform: {
  positionX: 0, positionY: 0,     // Pixels (draggable inputs)
  scaleX: 100, scaleY: 100,       // Percentage (10-400)
  scaleLinked: true,              // Lock X/Y
  rotation: 0,                     // Degrees (-180 to 180)
  anchorX: 50, anchorY: 50,       // Anchor (0-100%, draggable)
  opacity: 100,                    // Transparency (0-100%)
  flipH: false, flipV: false,     // Mirror
  cropTop: 0, cropBottom: 0,      // Edge crop (0-50%)
  cropLeft: 0, cropRight: 0,
  blendMode: 'normal',            // CSS mix-blend-mode: normal | multiply | screen | overlay | etc.
  blur: 0,                        // Blur radius in px (0–50, 0.25 step); keyframeable
}
```
- **Blend mode** (Inspector → Transform): For video/image/text clips, choose how the clip composites with layers below (e.g. screen, multiply, overlay, vignette-style darken). Export respects blend modes.
- **Blur** (Inspector → Transform): Slider 0–50px (0.25 step) for video/image/text clips. Keyframeable; applied in preview and export (CSS filter / canvas filter).

## Multi-Layer Compositing
- Clips on multiple video tracks at same time = stacked layers
- **Video 1 = TOP**, Video 2 = behind
- Text clips render on top of video layers
- Scale down top layer → see layer beneath (picture-in-picture)
- Each layer has independent transforms
- Preview shows "X Layers" badge when multiple active

## Inspector Panel (Right)
When a clip is selected:
1. **Header**: Clip name, track, duration, **Reset Transform** button
2. **Transform**: Position (draggable), Scale (link toggle), Rotation, Flip, Opacity, Anchor Point (9-grid + draggable inputs). **Double-click any slider** (Scale, Rotation, Opacity, Blur, Crop) to reset that property to default (scale 100%, rotation 0°, opacity 100%, blur 0, crop 0).
3. **Crop**: Visual preview + 4 edge sliders (double-click slider to reset to 0)
4. **Timing**: Start time, duration, trim in/out
5. **Effects**: Placeholders for Ken Burns, Camera Shake, Color Grade

**Text Clip Inspector** shows:
- Text content, font family, size (draggable input), weight
- Horizontal/vertical alignment buttons
- Colors & style (text color, stroke, background, shadow)
- Transform and timing (shared with video clips)
- **Real-time preview**: Text changes reflect immediately in preview (no need to move playhead)

## Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `J/K/L` | Reverse / Pause / Forward (speed ramps) |
| `I/O` | Set In/Out points |
| `Alt+X` | Clear In/Out |
| `X` | Split clip at playhead (on active track only; works for video, image, text) |
| `S` | Toggle snapping |
| `R` | Toggle ripple edit |
| `Ctrl+Z` | Undo (timeline; e.g. undo clip delete) |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+C` | Copy selected clips (paste at playhead with Ctrl+V on active track) |
| `Ctrl+V` | Paste copied clips at playhead on active track |
| `Delete` | Delete: timeline clips if any selected, else selected assets in Assets panel |
| `Escape` | Clear selection |
| `Ctrl+A` | Select all clips |
| `Alt+Drag` | Marquee selection (timeline) |
| `Space+Drag` | Pan (preview & timeline) |
| `Ctrl+Scroll` | Zoom (preview & timeline) |
| `Shift+Scroll` | Horizontal scroll (timeline) |

## Generate Tab (GenerateWorkspace)
The **Generate** tab offers workflow-based generation with a job queue and progress.

**Workflows (by category):**
- **Video**: Text to Video (LTX2), Image to Video (LTX2), Image to Video (WAN 2.2)
- **Image**: Multiple Angles (Characters), Multiple Angles (Scenes), Image Edit
- **Audio**: Music Generation (tags + lyrics)

**Workflow files** (in `public/workflows/`): `video_ltx2_t2v.json`, `ltx2_Image_to_Video.json`, `video_wan2_2_14B_i2v.json`, `1_click_multiple_angles.json`, `1_click_multiple_scene_angles-v1.0.json`, `image_qwen_image_edit_2509.json`, `music_generation.json`.

**Image Edit:** Qwen 2509 workflow; supports 1–2 optional reference images. **Annotate image** tool: draw circles, rectangles, freehand, and text labels on the input (or a video frame), then use as Ref 1/Ref 2. Annotation modal: color palette, move/resize shapes, text with black outline. Ref images are uploaded and wired to `image2`/`image3` on the workflow.

**Aspect ratio warning:** Shown only for image-to-video workflows (not for Text to Video).

**Features:** Prompt/negative prompt, cinematography tags (10 categories), resolution/duration/FPS/seed, input asset picker for image-based workflows, job queue with progress and result import to Assets.

**Extend from timeline frame:** Park the playhead on a video or image clip, then right-click the preview → **Extend with AI** or **Starting keyframe for AI**. The frame at the playhead (topmost clip) is captured and sent to the Generate tab; the app switches to Generate with that frame as input. Choose **Image to Video (LTX2)** or **Image to Video (WAN 2.2)**, enter a prompt, and queue. Uses `frameForAIStore` and `captureTimelineFrame`; jobs can use `inputFromTimelineFrame` so the following clip is not pushed (no ripple).

## Text Panel Features
- Text content textarea
- Font family dropdown (10 fonts)
- Font size slider (12-200px)
- Font weight dropdown
- Text alignment buttons
- Colors: text, stroke (with width), background (with opacity)
- Drop shadow toggle
- Duration presets (2s, 3s, 5s, 8s, 10s)
- Live preview
- Presets: Title, Subtitle, Lower Third, Caption

## Preview Panel Features
- **Aspect ratio**: Automatically matches current timeline's resolution settings
- Zoom: Fit, 25%-200% (also via **mouse scroll wheel**)
- Pan: Space+Drag
- Fullscreen mode
- Multi-layer video + text compositing
- Video preloading/caching for seamless clip transitions; **no black flash at cuts** (display uses cache's preloaded video element)
- **Playback cache (Flame-style)**: Video imported (AI Generate, Assets, Stock/Pexels) is transcoded in background to H.264, keyframe every 6, no B-frames; timeline uses cached file when ready for smooth playback. Cache lives in `project/cache/playback_<assetId>.mp4`. Electron only; run with `npm run electron:dev`.
- Video clips maintain aspect ratio (letterbox/pillarbox, no stretching)
- **Extend with AI:** In timeline mode, right-click preview when playhead is over a video/image clip → **Extend with AI** or **Starting keyframe for AI** to capture that frame and open the Generate tab with it as input for LTX2 i2v or WAN 2.2 i2v.

### Safe Guides & Letterbox
Preview panel includes professional overlay guides accessible via **Guides** dropdown:

**Safe Guides:**
- **Title Safe (80%)** - Yellow dashed border for text placement
- **Action Safe (90%)** - Cyan border for important action
- **Rule of Thirds** - 3×3 grid with intersection points
- **Center Crosshair** - Center point marker
- **Title + Action Safe** - Both zones shown together

**Letterbox Preview:**
- **2.35:1 Cinemascope** - Classic widescreen
- **2.39:1 Anamorphic** - Modern anamorphic
- **1.85:1 Theatrical** - Standard theatrical
- **4:3 Classic TV** - Old TV format

Letterbox shows black bars to visualize how content will appear in different delivery formats.

## Export (Resolve-style)
Export full edits (cuts, transitions, masks, text, audio) to a video file.

**Export UI:**
- Top **Editor / Export** tabs (centered to preview area)
- Tabs: **Video / Audio / File**
- Queue with **Start / Pause / Resume**
- ETA + render speed (fps)
- Performance hints (NVENC availability, cached masks, resolution/FPS)

**Video Settings:**
- Formats: MP4 (H.264/H.265), WebM (VP9), **MOV (ProRes)**
- ProRes: Profile selector (Proxy, LT, Standard, HQ, 4444); output `.mov` via FFmpeg `prores_ks`
- Encoders: software (x264/x265) or **NVIDIA NVENC** (not used for ProRes)
- CRF or bitrate mode
- Keyframe interval (auto/manual)
- Presets + NVENC P1–P7
- Resolution + FPS (project or override)
- Options: **Use cached renders**, **Fast seek**

**Audio Settings:**
- Include audio toggle
- Codec: AAC (MP4), Opus (WebM)
- Bitrate, sample rate, channels

**Implementation Details:**
- Frame-by-frame compositing to PNG sequence (canvas)
- Uses cached renders for masked clips if enabled
- Audio mixdown: **FFmpeg in Electron main process** (IPC `export:mixAudio`); fallback to OfflineAudioContext in renderer if FFmpeg unavailable or fails.
- Encoding via FFmpeg in Electron main process

## Playback Modes (Right-click Play button)
- **Normal**: Play once and stop at end
- **Loop**: Loop entire timeline continuously
- **In to Out**: Loop between In/Out points (requires I/O points set)
- **Back and Forth (Ping-Pong)**: Play forward then reverse

## Technical Notes
- **Tailwind colors**: Custom `sf-` prefix (e.g., `sf-dark-900`, `sf-accent`, `sf-blue`)
- **Color scheme**: DaVinci Resolve-inspired dark theme with desaturated colors
  - `sf-dark-*`: Deep grays (#0d0d0d to #5c5c5c)
  - `sf-accent`: Orange/red for playhead and highlights (#e85d04)
  - `sf-blue`: Desaturated blue for action buttons (#5a7a9e)
  - `sf-clip-video`: Desaturated teal for video clips (#3d7080)
  - `sf-clip-audio`: Desaturated green for audio (#2d5f4a)
  - `sf-clip-text`: Desaturated amber for text clips (#a89030)
- **Text colors**: `sf-text-primary` (#e5e5e5), `sf-text-secondary` (#a3a3a3), `sf-text-muted` (#737373)
- **Persistence**: Zustand with `persist` middleware → localStorage
- **Panel widths**: Left 200-450px, Right 200-400px, Timeline 180-450px (default 320px)
- **Layout persistence**: Editor layout (timeline height, left/right panel width, expanded state) saved to `localStorage` key `comfystudio-editor-layout` and restored on launch
- **Track headers width**: Default 208px, resizable 100-400px; persisted in `comfystudio-timeline-track-headers-width`
- **Collapsible panels**: Icon bar always visible (48px each side)
- **Full-height mode**: Left panel can expand to span entire height (Resolve-style)
- **Draggable inputs**: Position X/Y, Anchor X/Y - click+drag to adjust, double-click to edit
- **Number inputs**: Spinner arrows hidden globally (`index.css`); double-click to type value

## Keyframing & Animation
Clips support keyframe-based animation for transform properties.

### Keyframeable Properties
- Position X/Y
- Scale X/Y
- Rotation
- Opacity
- Blur
- Anchor X/Y
- Crop (Top, Bottom, Left, Right)

### Easing Functions
- `linear` - Constant speed
- `easeIn` / `easeInCubic` - Slow start
- `easeOut` / `easeOutCubic` - Slow end
- `easeInOut` / `easeInOutCubic` - Slow start and end
- `hold` - No interpolation (jump to value)

### Keyframe Data Structure
```javascript
clip.keyframes = {
  positionX: [
    { time: 0, value: 0, easing: 'easeInOut' },
    { time: 2.5, value: 100, easing: 'linear' },
  ],
  opacity: [
    { time: 0, value: 100, easing: 'easeIn' },
    { time: 1, value: 0, easing: 'linear' },
  ],
}
```
- `time` = seconds relative to clip start
- `value` = property value at that time
- `easing` = interpolation to next keyframe

### Inspector UI
Each keyframeable property has a **diamond button**:
- **Yellow filled (◆)** = Keyframe exists at current playhead position
- **Blue outline (◇)** = Property has keyframes, but not at current time
- **Gray (◇)** = No keyframes for this property

Click diamond to toggle keyframe at playhead. Use **◀ ▶** arrows to jump between keyframes.

### Timeline Markers
Clips with keyframes show **yellow diamond markers** at keyframe positions on the timeline.

### Key Files
| File | Purpose |
|------|---------|
| `src/utils/keyframes.js` | Interpolation, easing functions, utilities |
| `src/stores/timelineStore.js` | Keyframe CRUD operations |
| `src/components/VideoLayerRenderer.jsx` | Animated transform evaluation |
| `src/components/InspectorPanel.jsx` | Keyframe toggle buttons |
| `src/components/Timeline.jsx` | Keyframe diamond markers on clips |

### Store Functions
```javascript
// Add/update keyframe
setKeyframe(clipId, property, time, value, easing)

// Remove keyframe
removeKeyframe(clipId, property, time)

// Toggle keyframe at playhead
toggleKeyframe(clipId, property)

// Navigate keyframes
goToNextKeyframe(clipId, property)
goToPrevKeyframe(clipId, property)

// Clear keyframes
clearPropertyKeyframes(clipId, property)
clearAllKeyframes(clipId)
```

## Pending Features
- [ ] Keyboard: C (split), Ctrl+D (duplicate)
- [ ] Timeline markers
- [ ] Audio waveforms
- [ ] Text animation presets
- [ ] Keyframe easing editor (curve UI)
- [ ] Keyframe copy/paste

---

## Recent Changes Log

### Live drop preview when dragging from Assets (Feb 2026)

**Asset-to-timeline drag preview:**
- While dragging an asset from the Assets panel onto the timeline (before mouse-up), a **live ghost clip** appears on the target track at the current drop position. The preview shows: clip type (VID/IMG/AUD), asset name, duration (frame-quantized), and track/target time. Video/image tracks use a semi-transparent teal ghost with orange border; audio tracks use the same Resolve-style green tint. Preview updates as the cursor moves across tracks and along the timeline. On drop, the real clip is placed where the ghost was; preview clears on drop, drag leave, or drag end.
- **Implementation:** `Timeline.jsx`: state `assetDropPreview` (assetId, trackId, startTime, duration, assetType, name, willCreateTrack); `renderAssetDropPreviewClip(track)` renders the ghost; `handleDragOver` computes drop position and duration via `getDropStartTime`, `getDropPreviewDuration`, `resolveDropTrackForAsset`, `canDropAssetOnTrack`. Overlay assets (letterbox/vignette/color matte) show “+ track on drop” when a new video track would be created. `getDraggedAssetId` reads from `dataTransfer` (assetId, text/plain JSON) with fallback to `draggedAssetId` from custom events. Global `dragend`/`drop` and custom `comfystudio-assets-drag-start` / `comfystudio-assets-drag-end` clear preview. **AssetsPanel.jsx:** `notifyAssetDragStart(assetId, idsToMove)` and `notifyAssetDragEnd()` dispatch window events on drag start/end for all three asset drag surfaces (grid, list, list expanded folders) so the timeline can show preview even when `dataTransfer.getData()` is restricted during dragover in some environments.

### Inspector sliders, transitions, timeline scroll (Feb 2026)

**Inspector – double-click to reset sliders:**
- Scale (uniform or X/Y), Rotation, Opacity, Blur, and Crop (Top/Bottom/Left/Right) sliders: **double-click** resets that property to default (scale 100%, rotation 0°, opacity 100%, blur 0, crop 0). Linked scale resets both X and Y. Uses `handleSliderReset`; keyframes updated when property has keyframes. Files: `InspectorPanel.jsx`.

**Number input spinners removed:**
- All `<input type="number">` spinners (up/down arrows) hidden via global CSS so users type or use draggable inputs; double-click draggable number to edit. Files: `src/index.css`.

**Transition handle 1:1 with mouse:**
- Dragging transition left/right handle previously used fixed 20px = 1s, so the handle moved 5–8× faster than the cursor at higher zoom. Now `deltaDuration = deltaX / pixelsPerSecond` so the handle stays under the cursor. Files: `Timeline.jsx`.

**Resolve-style transition visual:**
- Transition tile: dark grey-black overlay (`#1a1a1a/85`), grey border, transition name (e.g. "Cross Dissolve") in white, duration in grey pill (e.g. "35f"), full-width white top bar with small vertical handle. **Diagonal line** from bottom-left to top-right (SVG line, 50% white) as dissolve indicator. Red edge guides removed. Files: `Timeline.jsx`.

**Timeline vertical scroll sync:**
- When tracks are resized tall, only the left (track headers) panel showed a scrollbar and scrolled; the right (track content) did not. Cause: flex items had default `min-height: auto`, so the content container grew to fit all tracks and never became scrollable. Fix: added `min-h-0` to `timelineRef`, inner flex container, and `trackContentRef` so the right side is height-constrained and scrollable; left and right sync `scrollTop` on scroll. Right-side scrollbar hidden (`.hide-scrollbar` + `scrollbarWidth: none`) so only one scrollbar is visible. Files: `Timeline.jsx`, `src/index.css`.

### Export audio fix, preview scaling, slip edit, dope sheet, playback resilience (Feb 2026)

**Export audio:** Audio mixing moved to Electron main process via FFmpeg (IPC `export:mixAudio`). Complex timelines no longer hang on WebAudio; fallback to OfflineAudioContext if FFmpeg fails. `exporter.js` calls `window.electronAPI.mixAudio` with clips/tracks/assets; main process builds FFmpeg filter graph (atrim, atempo, adelay, amix) and writes WAV.

**Export demux resilience:** Exporter tolerates `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` and bad video sources: `getMediaErrorMessage()`, `failedVideoSources` set to skip undecodable sources, seek/draw wrapped in try/catch so one bad clip doesn't abort export. `src/services/exporter.js`.

**Preview scaling:** Preview composition (position, blur, text size) now scales with panel size so framing stays correct at any window size. `previewScale` in `PreviewPanel.jsx`, passed to `VideoLayerRenderer` and `TextLayer`.

**Slip edit:** Alt+Drag on a video/audio clip body adjusts in/out points together without changing duration or timeline position. `Timeline.jsx` slipState, frame-quantized delta, clamped to source duration.

**Dope sheet:** Bottom tab "Dope Sheet" for selected clip: property lanes, keyframe diamonds, drag to retime, frame snap toggle, add/delete keyframes. `DopeSheet.jsx`, `timelineStore` `moveKeyframeTime` / `moveKeyframesAtTime`.

**Playback cache:** On project load, validate playback cache files exist; if missing, mark `playbackCacheStatus: 'failed'`. At runtime, if video fails (e.g. `video:error`, readyState 0), mark cache broken and fall back to original asset URL. `assetsStore.js`, `VideoLayerRenderer.jsx`, `videoCache.js`.

### Blur, Fullscreen, Overlay IDs, Still-Frame Duration, Audio Generation (Feb 2026)

**Blur clips:**
- Per-clip **blur** (0–50px, 0.25px step) added to transform. Inspector has Blur slider + keyframe diamond for video/image/text. Applied in PreviewPanel (`buildVideoTransform`), VideoLayerRenderer (blur combined with mask filter so both apply), and exporter. `KEYFRAMEABLE_PROPERTIES` in `keyframes.js` includes blur.

**Fullscreen preview fix:**
- Fullscreen button on preview showed black grid with no picture. Cause: fullscreen panel and inner aspect-ratio wrapper had no explicit size. Fix: panel gets `width: 100vw; height: 100vh` when fullscreen; `getAspectRatioStyle()` returns explicit width/height in fullscreen (e.g. 90vw × min(90vh, 90vw/ar)) so the video area has real dimensions. File: `PreviewPanel.jsx`.

**Color matte / letterbox / vignette “linked” to another clip:**
- Trimming, moving, or deleting an overlay (e.g. color matte) also changed another clip because two clips shared the same ID. Fix: **unique clip IDs** via `getNextClipCounter(clips, fallback)` in `timelineStore.js` (scans existing `clip-N` IDs and returns next free number). `addClip`, `addTextClip`, and `pasteClipsAtPlayhead` use it; `resolveOverlaps` split-clip IDs use a safe base; `loadFromProject` sets `clipCounter` to max(existing IDs)+1. New overlays and pastes no longer collide; re-add any clips that were already duplicated.

**Still-frame overlays snapping to one frame:**
- Letterbox, color matte, vignette (image clips with infinite source) sometimes shrank to ~0.042s and Source Duration showed "s". Cause: `sourceDuration` was null/undefined and treated as 0. Fix: **`parseClipSourceDuration()`** in `timelineStore.js` (handles Infinity, numeric, null/empty); **image clips** with null source duration are treated as **Infinity** in `updateClipTrim`, `resizeClip`, `trimClipEnd`, `getClipHandles`, and `loadFromProject`. Inspector shows "Infinity" (or "Unknown") for source duration instead of calling `.toFixed(2)` on null. Timeline right-trim logic treats image/infinite source so duration is not clamped to one frame. Files: `timelineStore.js`, `Timeline.jsx`, `InspectorPanel.jsx`.

**Audio generation (Music) validation fix:**
- Generate → Music was failing with "Required input is missing" for node TextEncodeAceStepAudio1.5 (generate_audio_codes, top_k, top_p, temperature, cfg_scale, min_p). ComfyUI Ace-Step 1.5 node was updated to require these. Fix: added these inputs to `public/workflows/music_generation.json` (node 94) with defaults (generate_audio_codes: true, top_k: 0, top_p: 0.9, temperature: 1, cfg_scale: 1, min_p: 0) and in `modifyMusicWorkflow()` in `comfyui.js` so they are always set when patching. Files: `public/workflows/music_generation.json`, `src/services/comfyui.js`.

### Extend from Timeline, List Details, Split Fix (Feb 2026)

**Extend with AI / Starting keyframe for AI:**
- Park the playhead on any video or image clip. Right-click the preview (timeline mode) → **Extend with AI** or **Starting keyframe for AI**. The frame from the **topmost** clip at the playhead is captured and sent to the Generate tab; the app switches to Generate with that frame as input.
- **Generate tab:** When a timeline frame is set, a card shows the frame thumbnail, mode (Extend / Keyframe), and **Clear timeline frame**. User chooses **Image to Video (LTX2)** or **Image to Video (WAN 2.2)**, enters prompt, and queues. The job uses the captured frame file (no asset required); `runJob` supports `job.inputFromTimelineFrame` and reads the file from `frameForAIStore`.
- **Files:** `src/stores/frameForAIStore.js` (new), `src/utils/captureTimelineFrame.js` (new; `getTopmostVideoOrImageClipAtTime`, `captureTimelineFrameAt`), `PreviewPanel.jsx` (context menu items, capture + dispatch `comfystudio-open-generate-with-frame`), `GenerateWorkspace.jsx` (frame card, use of store, job `inputFromTimelineFrame`), `App.jsx` (listener to switch to Generate tab). Import fix: use **named** import `import { useFrameForAIStore } from '../stores/frameForAIStore'` (store has no default export).

**AI/IMP tags on timeline clips:**
- Video and image clips on the timeline now show an **AI** (orange) or **IMP** (gray) badge next to the clip name (video) or next to the IMG badge (image), matching the Assets panel. Lookup via `getAssetById(clip.assetId)`; badge only when asset exists. **Files:** `Timeline.jsx` (getAssetById from store, badge in video and image clip render blocks).

**Assets list view – details columns and sortable:**
- In **list view**, a fixed header row shows columns: **Name**, **Type**, **Length**, **Size**, **Source** (AI/IMP), **Date**. Each asset row displays the same fields (thumbnail + name, type label, duration string, formatted file size, AI/IMP badge, relative time). Click any column header to sort by that column; click again to toggle ascending/descending. Sort choice is persisted in `localStorage` key `assetsListSort`. Same column layout is used for assets inside expanded folders. **Files:** `AssetsPanel.jsx` (listSortBy state, setListSort, formatFileSize, getAssetLength/Size/Source/TypeLabel, sortAssets, grid layout for header and rows; ListFolderRow updated to use same details columns for child assets).

**Split (X) at playhead – fix when ripple off:**
- Splitting a clip with **X** (or context menu **Split at Playhead**) was causing the right half to appear to disappear and the clip to the right to move left to the cut. Cause: `addClip` for the second half used the **full source duration**, so `resolveOverlaps` thought the new clip extended far to the right and trimmed/moved the following clip (Case 2).
- **Fix:** `addClip` now accepts an optional 5th parameter `options = { duration, trimStart, trimEnd }`. When provided (for the second half of a split), the new clip is created with that duration and trim, and `resolveOverlaps` is called with that duration so it does not affect the following clip. Split handlers in `Timeline.jsx` (X key and context menu) now call `addClip(..., { duration: remainder, trimStart: sourceTimeAtCut, trimEnd: sourceTrimEnd })` and no longer call `updateClipTrim`/`resizeClip` on the new clip. **Files:** `timelineStore.js` (addClip options, finalDuration/finalTrimStart/finalTrimEnd, resolveOverlaps uses finalDuration), `Timeline.jsx` (split passes options; getTimeScale used for sourceTrimEnd).

### Drag/Clip/Overlay & Copy-Paste (Feb 2026)

**Drag from Assets to Timeline (forbidden cursor fix):**
- Dragging clips from the Assets panel to the timeline was showing a red “forbidden” cursor. Cause: Assets panel set `effectAllowed = 'move'` while the Timeline sets `dropEffect = 'copy'`. The browser only allows drop effects permitted by the source.
- **Fix:** In `AssetsPanel.jsx`, all asset drag-start handlers now set `effectAllowed = 'copyMove'` so both Timeline (copy) and folder drops (move) work.

**X key / Split on text clips:**
- Pressing **X** on a text clip (split at playhead) was only shortening the clip and not creating a second clip, because the split logic looked up an asset by `clip.assetId` (text clips have `assetId: null`).
- **Fix:** In `Timeline.jsx`, when the clip is a text clip, after shortening the first part we call `addTextClip(trackId, { ...clip.textProperties, duration: remainder }, playheadPosition)` so the second half is a new text clip with the same styling. Same logic applied to the context menu **Split at Playhead** action.

**Blend modes on clips:**
- Clips (video, image, text) can use **blend modes** (e.g. screen, multiply, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity).
- **Store:** `clip.transform.blendMode` (default `'normal'`) added in `timelineStore.js` for new clips, `updateClipTransform`, and `resetClipTransform`.
- **Preview:** `PreviewPanel.jsx` `buildVideoTransform()` sets `style.mixBlendMode` when not `'normal'`.
- **Inspector:** Blend mode dropdown in Transform section for video/image clips and in the **text clip** Transform section (both inspector layouts).
- **Export:** `exporter.js` sets `ctx.globalCompositeOperation` from `clip.transform.blendMode` when drawing each layer and text clips.

**Copy / Paste clips:**
- **Ctrl+C (Cmd+C):** Copy selected timeline clips into an internal buffer (`copiedClips`), preserving relative start times.
- **Ctrl+V (Cmd+V):** Paste at playhead on the **active track**. Only clips matching the active track type are pasted (video track: video/image/text; audio track: audio). Overlaps resolved (NLE-style). One undo step for the whole paste.
- **Store:** `timelineStore.js`: `copiedClips`, `copySelectedClips()`, `pasteClipsAtPlayhead(trackId, startTime, assets)`. `resolveOverlaps` extended with optional `baseClips` and `idCounter` for batch paste.
- **Context menu:** Clip context menu has **Copy** and **Paste at Playhead** (Paste disabled when nothing copied or no active track).
- **Files:** `Timeline.jsx` (keyboard handlers, context menu), `timelineStore.js`.

**Overlay generator (Option B – generated stills):**
- Right-click in Assets panel (empty area or on a folder) → **Create overlay** section: **Letterbox overlay…**, **Vignette overlay…**, **Color matte…**. From a folder: **Create overlay in this folder…**.
- **OverlayGeneratorModal.jsx:** One modal with type tabs (Letterbox, Vignette, Color matte). Resolution: “Match timeline” or custom width×height. Optional name. Type-specific options: letterbox = aspect ratio (2.39:1, 2.35:1, 16:9, 4:3, 1:1) and bar color; vignette = strength and softness sliders; color matte = color picker. Generates PNG via canvas, creates blob URL, calls `onAdd(asset)` so the image is added to the asset library (and current or chosen folder). Overlays are normal image assets; drag onto a video track above content and use blend mode/opacity as needed.
- **Files:** `src/components/OverlayGeneratorModal.jsx` (new), `src/components/panels/AssetsPanel.jsx` (context menu items, modal state, `getCurrentTimelineSettings` for resolution).

**Image/text clips moving between tracks:**
- Generated overlay images (and other image clips, and text clips) could not be moved up/down to another track; only left/right and trim worked. Cause: vertical track switching used `clip.type` to filter tracks (`tracks.filter(t => t.type === clip.type)`); image clips have `type: 'image'` but there are no tracks with `type: 'image'` (only `video` and `audio`).
- **Fix:** In `Timeline.jsx`, when computing the target track for vertical drag, treat image and text clips as video-track clips: `trackType = (clip.type === 'image' || clip.type === 'text') ? 'video' : (clip.type || 'video')`, so they can move between Video 1, Video 2, etc.

### Generate, Assets, and UX (Feb 2026)

**Image Edit – reference images and annotation:**
- Image Edit workflow supports **1–2 optional reference images** (Qwen `image2`/`image3`). Refs chosen from Assets dropdown or created via **Annotate image**.
- **Annotate image** (button in Generate → Image Edit): Opens modal with current input image (or video frame at current time). Draw **circles**, **rectangles**, **freehand**, and **text labels**; pick **color** from palette; **move/resize** shapes (and move text). Export as Ref 1 or Ref 2 (adds to assets and sets ref). Text has black outline for readability.
- Workflow modifier `modifyQwenImageEdit2509Workflow` injects ref LoadImage nodes and wires `image2`/`image3` on `TextEncodeQwenImageEditPlus` when refs provided.
- Files: `src/components/ImageAnnotationModal.jsx` (new), `src/components/GenerateWorkspace.jsx`, `src/services/comfyui.js`.

**Multiple Angles – characters vs scenes:**
- **Multiple Angles (Characters):** `1_click_multiple_angles.json` – 8 camera angles from one character image.
- **Multiple Angles (Scenes):** `1_click_multiple_scene_angles-v1.0.json` – 8 camera angles from one scene image.
- Same modifier used for both; workflow map and WORKFLOWS in GenerateWorkspace updated.

**Image Edit copy:**
- Card and prompt placeholder updated: e.g. “remove person on left or change color of car” (replaced “inflate the subject”).

**Aspect ratio mismatch:**
- Warning shown only when workflow **needs an input image** (image-to-video). Text to Video no longer shows the warning.

**Assets panel – drag to folder:**
- Drag assets onto folders (or Root) now works in all browsers: drag data set as both custom MIME type and `text/plain`; drop handler reads `text/plain` as fallback. `effectAllowed` set to `move`.

**Assets panel – folder name Enter key:**
- In new-folder input, Enter calls `preventDefault()` and `stopPropagation()` so timeline play (global Enter) is not triggered.

**Assets panel – list view expand:**
- Each folder in list view has an **arrow** (chevron right/down). Click arrow to expand/collapse and show contents inline (subfolders + assets). Click folder name to navigate into folder. State: `expandedFolderIds` (Set).

**Assets panel – folder and asset colors:**
- Right-click folder or asset → **Color** → palette (None, red, orange, yellow, green, cyan, blue, purple, pink, gray). Store: `setFolderColor(folderId, color)`, `setAssetColor(assetId, color)`. Colored items show **left border** in grid and list. Folder context menu: Color + Delete folder.

### Black Flash Fix, Playback Cache, Input Focus (Feb 2026)

**No black flash at cuts:**
- Preview now uses the **cached video element** for display instead of a new `<video>` per layer. At cuts the preloaded, pre-seeked element is shown immediately.
- VideoLayer attaches the cache's element to a container; sync/playback use that same element.

**Playback cache (Flame-style):**
- On import (AI Generate, Assets panel, Stock/Pexels), video is transcoded in background to playback-optimized format (same resolution, H.264, keyframe every 6, no B-frames). Stored in `project/cache/playback_<assetId>.mp4`.
- `getAssetUrl(assetId)` prefers `asset.playbackCacheUrl` when set; `useClipUrl` subscribes to the asset's URL so the timeline re-renders when cache becomes ready.
- Video cache uses a dedicated key for playback-cache URL (`clipId|pb`) so we don't reuse an element that had its `src` switched (avoids black on play). Playback-cache element waits for `canplay` before considered ready.
- **Files:** `src/services/playbackCache.js` (new), `electron/main.js` (IPC `playback:transcode`), `electron/preload.js`, `src/stores/assetsStore.js` (playbackCachePath/Url, setPlaybackCache, loadFromProject restores cache URL), `src/components/VideoLayerRenderer.jsx` (useClipUrl subscribes to asset URL), `src/services/videoCache.js` (_cacheKey, _getEntry, baseClipId), `src/services/fileSystem.js` (cache folder in createProjectFolder), GenerateWorkspace/AssetsPanel/StockPanel (enqueuePlaybackTranscode after add video asset).
- Console: `[PlaybackCache] Transcoding...` and `[PlaybackCache] Ready - using cached file for playback`. Optional debug: `localStorage.setItem('comfystudio-debug-playback', '1')`.

**Keyboard / input focus:**
- Global shortcuts (J/K/L, I/O, S, R, Delete, Space, etc.) now skip when `document.activeElement` is INPUT, TEXTAREA, SELECT, or contentEditable. Fixes typing in prompt fields and Stock search bar.
- **Files:** `TransportControls.jsx`, `Timeline.jsx`, `PreviewPanel.jsx`, `AssetsPanel.jsx`.

### Delete/Undo Fix + LTX2 Image to Video (Feb 6, 2026)

**Delete key behavior:**
- When the timeline has selected clips, **Delete** now removes those clips (not assets).
- Assets panel only handles Delete when focus is in the panel *and* the timeline has no selected clips.
- Fixes the case where selecting an asset then a timeline clip and pressing Delete was deleting the asset instead of the clip.

**Undo (Ctrl+Z):**
- Timeline clip deletion is correctly undone because Delete now targets clips and `removeSelectedClips()` uses `saveToHistory()`.

**Files:** `src/components/panels/AssetsPanel.jsx` (check `useTimelineStore.getState().selectedClipIds.length` before handling Delete).

**LTX2 Image to Video workflow:**
- New option in Generate tab → Video: **Image to Video (LTX2)** (`ltx2-i2v`).
- Requires an input image; uses workflow file `public/workflows/ltx2_Image_to_Video.json`.
- Modifier: `modifyLTX2I2VWorkflow()` in `src/services/comfyui.js` (patches image, prompt, negative prompt, resolution, frames, fps, seed).
- **Files:** `src/components/GenerateWorkspace.jsx` (WORKFLOWS, workflowMap, runner case), `src/services/comfyui.js` (new modifier).

### Export Pipeline + NVENC + Queue (Feb 2026)

**Export Tab & Resolve-style Settings:**
- Added **Editor / Export** tabs in title bar, centered to preview area
- New Export panel with Video/Audio/File tabs and export queue
- Settings include codec, bitrate/CRF, presets, keyframes, resolution, FPS
- ETA + render speed with performance hints

**Export Pipeline (Full Timeline):**
- Renders full edit to PNG sequence (text, transitions, masks, transforms)
- Audio mixdown via OfflineAudioContext → WAV
- FFmpeg encoding (MP4/WebM)
- Cached render usage for masked clips
- Fast seek for quicker frame generation

**GPU Encoding (NVENC) + Detection:**
- NVIDIA NVENC toggle with preset selection
- FFmpeg NVENC detection + warnings

**Queue Controls:**
- Start/Pause/Resume queue
- Per-item status + error display

**New/Modified Files:**
| File | Changes |
|------|---------|
| `src/components/ExportPanel.jsx` | Export UI, queue, ETA, hints, settings |
| `src/services/exporter.js` | Frame renderer + audio mix + FFmpeg handoff |
| `src/components/TitleBar.jsx` | Editor/Export tabs centered to preview |
| `src/App.jsx` | Main tab layout integration |
| `electron/main.js` | FFmpeg encode + NVENC detection IPC |
| `electron/preload.js` | `encodeVideo` + `checkNvenc` bridges |
| `package.json` | Added `ffmpeg-static` dependency |

### Keyframing Feature (Feb 2026)
Added keyframe-based animation for transform properties.

**New Files:**
- `src/utils/keyframes.js` - Easing functions, interpolation utilities

**Modified Files:**
- `src/stores/timelineStore.js` - Added keyframe CRUD functions
- `src/components/VideoLayerRenderer.jsx` - Uses `getAnimatedTransform()` for animated values
- `src/components/InspectorPanel.jsx` - KeyframeButton component, animated value display
- `src/components/Timeline.jsx` - Yellow diamond markers on clips with keyframes

**How It Works:**
1. Select a clip and move playhead to desired time
2. Click diamond button (◆) next to a property to add keyframe
3. Move playhead, change value, click diamond again
4. Play timeline to see interpolated animation
5. Values smoothly transition between keyframes using selected easing

### Session Updates (Feb 2026)

**Timeline-Specific Settings:**
- Each timeline can now have its own resolution and frame rate
- New Timeline dialog with resolution/fps options (similar to New Project dialog)
- "Use Project Settings" toggle for quick inheritance
- Preview panel auto-adjusts to timeline's aspect ratio
- Files: `NewTimelineDialog.jsx`, `projectStore.js`, `TimelineSwitcher.jsx`

**Safe Guides Feature:**
- Removed aspect ratio dropdown from preview (now uses timeline settings)
- Added Guides dropdown with safe zone overlays
- Title Safe (80%), Action Safe (90%), Rule of Thirds, Center Crosshair
- Letterbox preview for 2.35:1, 2.39:1, 1.85:1, 4:3 formats
- File: `PreviewPanel.jsx`

**Inspector Panel Improvements:**
- Moved Reset Transform button to header for better visibility
- Removed duplicate/cut/delete buttons from header (use timeline instead)
- Font size input now draggable (like transform inputs)
- File: `InspectorPanel.jsx`

**Real-time Text Editing:**
- Text clip changes now reflect immediately in preview
- Fixed by adding `clips` to dependency array in VideoLayerRenderer
- File: `VideoLayerRenderer.jsx`

**Video Aspect Ratio Fix:**
- Videos no longer stretch/squeeze when placed in different aspect ratio timelines
- Uses `objectFit: 'contain'` for proper letterboxing
- Files: `VideoLayerRenderer.jsx`, `PreviewPanel.jsx`

**ComfyUI Progress Tracking:**
- WebSocket now connects directly to ComfyUI (bypasses Vite proxy)
- Real-time progress updates during video generation
- Shows current node being executed
- Warning message if WebSocket unavailable
- Files: `comfyui.js`, `useComfyUI.js`, `GeneratePanel.jsx`

### Session Updates (Feb 3, 2026)

**Linked Scale Keyframe Fix:**
- When `scaleLinked` is true and you add/remove a scale keyframe, it now creates/removes keyframes for BOTH `scaleX` and `scaleY`
- Previously only `scaleX` would get a keyframe when using the diamond button with linked scale
- Files: `src/stores/timelineStore.js` (toggleKeyframe function), `src/components/InspectorPanel.jsx` (handleTransformChange)

**Timeline Panning (Space+Drag):**
- Hold **Spacebar** and drag to pan the timeline horizontally and vertically
- Cursor changes to grab hand when spacebar is held
- Similar to panning in Premiere Pro, DaVinci Resolve, Photoshop
- File: `src/components/Timeline.jsx`

**Timeline Zoom (Ctrl+Scroll):**
- **Ctrl+Scroll** (or Cmd+Scroll on Mac) to zoom in/out, centered on mouse position
- **Shift+Scroll** to pan horizontally
- Regular scroll handles vertical track scrolling
- Hint in timeline header: `Ctrl+Scroll=Zoom | Space+Drag=Pan | Alt+Drag=Marquee`
- File: `src/components/Timeline.jsx`

**Asset URL Refresh Fix:**
- Fixed broken images/videos in timeline after page refresh
- Problem: Clips stored blob URLs that became invalid after refresh
- Solution: Clips now look up current URL from assets store using `assetId`
- Added `getAssetById()` and `getAssetUrl()` helpers to assetsStore
- Added `useClipUrl()` hook in VideoLayerRenderer
- Added `getClipUrl()` helper in Timeline
- Files: `src/stores/assetsStore.js`, `src/components/VideoLayerRenderer.jsx`, `src/components/Timeline.jsx`

**Inspector Selection Persistence:**
- Clicking on empty timeline space or scrubbing playhead no longer clears clip selection
- Inspector keeps showing the last selected clip
- Press **Escape** to explicitly clear selection when needed
- File: `src/components/Timeline.jsx`

### Color Theme Update (Feb 2026)
Updated the app's color scheme to match DaVinci Resolve more closely.

**Files Modified:**
- `tailwind.config.js` - Main color definitions
- `src/index.css` - Background colors, scrollbar colors
- `src/components/Timeline.jsx` - Playhead color (orange), clip colors (teal), I/O markers
- `src/components/TransportControls.jsx` - Play button (desaturated blue), I/O point buttons
- `src/components/PreviewPanel.jsx` - Darker preview background, play button color
- `src/components/GeneratePanel.jsx` - Generate button (desaturated blue)
- `src/components/WelcomeScreen.jsx` - Action buttons (desaturated blue)
- `src/components/NewProjectDialog.jsx` - Create button (desaturated blue)
- `src/components/InspectorPanel.jsx` - Default clip color fallback
- `src/stores/timelineStore.js` - Clip color palettes (video & audio)

**Key Color Changes:**
| Element | Old | New |
|---------|-----|-----|
| Backgrounds | Blue-tinted grays | True neutral grays (#0d0d0d - #5c5c5c) |
| Playhead | Red (#ef4444) | Orange (#e85d04) |
| Action buttons | Bright blue (#3b82f6) | Desaturated blue (#5a7a9e) |
| Video clips | Blue tints | Desaturated teal (#3d7080) |
| Audio clips | Bright green | Desaturated green (#2d5f4a) |
| Text clips | Bright amber | Desaturated amber (#a89030) |
| I/O markers | Bright blue | Desaturated blue (#5a7a9e) |
| Text colors | Cool whites | Warmer off-whites |

**Design Philosophy:**
- Darker, more neutral backgrounds (no blue tint) like Resolve
- Orange playhead matching Resolve's edit page
- All accent colors desaturated by ~30% for professional look
- Muted, functional colors that don't distract from content

### Session Updates (Feb 3, 2026 - Continued)

**Info Overlay Toggle:**
- Preview panel now has an **Eye icon** in header to show/hide info overlay
- Toggle shows/hides: resolution indicator, prompt overlay, timeline mode info
- Setting persists to localStorage
- File: `src/components/PreviewPanel.jsx`

**Asset Information Display:**
- When previewing an asset, detailed info shows in both:
  - **Preview panel overlay**: Type badge (Video/Image/Audio), resolution, duration, file size, AI/IMP badge
  - **Inspector panel**: Full asset details when no timeline clip is selected
- Helper functions: `formatFileSize()`, `formatDuration()`, `formatDate()`, `getFileExtension()`
- Files: `src/components/PreviewPanel.jsx`, `src/components/InspectorPanel.jsx`

**Image Duration Flexibility:**
- Images are no longer restricted to 5-second maximum
- Images can be extended to any length on the timeline
- `sourceDuration` set to `Infinity` for images
- Default placement duration remains 5 seconds
- File: `src/stores/timelineStore.js`

**Preview Scrubber Bar (DaVinci Resolve-style):**
- New scrubber bar below the main preview video
- Shows current time, progress bar, and total duration
- Draggable playhead for seeking
- **Context-aware**: Controls asset when previewing an asset, controls timeline when in timeline mode
- Files: `src/components/PreviewPanel.jsx`, `src/stores/assetsStore.js`

**Preview Context Switching (Source/Program Monitor):**
- Clicking an asset in Assets Panel switches preview to "asset mode"
- Clicking on timeline or a clip switches back to "timeline mode"
- Transport controls (play/pause/skip) follow the active preview mode
- Scrubber bar follows the active preview mode
- Asset videos start paused (not auto-playing or looping)
- Files: `src/components/TransportControls.jsx`, `src/components/AssetsPanel.jsx`, `src/components/Timeline.jsx`, `src/stores/assetsStore.js`

**Thumbnail Size Control:**
- Slider in Assets Panel header to adjust thumbnail size
- Three sizes: **Small** (3 columns), **Medium** (2 columns), **Large** (1 column)
- Size persists to localStorage
- Icons, badges, and text scale appropriately with size
- File: `src/components/panels/AssetsPanel.jsx`

**Folder Organization for Assets:**
- Create folders to organize assets (click folder+ icon)
- Navigate into folders by clicking them
- Breadcrumb navigation shows path (Root > Folder > Subfolder)
- **Drag-and-drop** assets onto folders or Root to move (grid and list view; uses `text/plain` fallback for drag data in all browsers)
- Right-click asset to move it to a different folder
- Delete folders (contents move to parent folder)
- Nested folders supported
- Folder count displayed in footer
- **List view:** Expand arrow next to each folder; click arrow to show/hide contents inline (subfolders + assets). Click folder name to navigate into folder. **Details columns:** When list view is active, a sortable header row shows **Name**, **Type**, **Length**, **Size**, **Source** (AI/IMP), **Date**. Click a column to sort; sort preference is persisted in `localStorage` (`assetsListSort`). Each asset row shows thumbnail, name, type (Video/Image/Audio/Mask), duration (e.g. 3s or 1:05), file size (KB/MB), AI or IMP badge, and relative date.
- **Colors:** Right-click folder or asset → **Color** → pick from palette (red, orange, yellow, green, cyan, blue, purple, pink, gray, or None). Colored items show a left border in grid/list. Store: `setFolderColor(folderId, color)`, `setAssetColor(assetId, color)` in `assetsStore.js`.
- **New folder name:** Pressing Enter to confirm folder name no longer triggers timeline play (event stopPropagation/preventDefault in AssetsPanel).
- Files: `src/components/panels/AssetsPanel.jsx`, `src/stores/assetsStore.js`

**New Store Properties (assetsStore.js):**
```javascript
folders: [],              // Array of { id, name, parentId, createdAt }
folderCounter: 1,         // Auto-increment for folder IDs
previewMode: 'asset',     // 'asset' | 'timeline' - which context controls preview

// New actions:
addFolder({ name, parentId })
removeFolder(folderId)
renameFolder(folderId, newName)
moveAssetToFolder(assetId, folderId)
setPreviewMode(mode)
```

**Asset Data Structure Update:**
```javascript
asset: {
  // ... existing fields ...
  folderId: null | 'folder-1',  // Which folder this asset belongs to (null = root)
}
```

### Session Updates (Feb 3, 2026 - Mask Generation Feature)

**AI Mask Generation via ComfyUI SAM3:**
- Generate masks from images/videos using text prompts (e.g., "person on the left", "red car")
- Uses SAM3 (Segment Anything Model 3) + MatAnyone for refined edges
- Right-click asset in Assets Panel → "Create Mask..."
- Dialog with text prompt input, progress tracking, and sensitivity settings
- Output: PNG mask (single image or sequence for videos)
- Masks appear as new assets with purple "MASK" badge

**Effects System:**
- Clips now support an `effects` array for non-destructive effects
- Mask effects can be applied to clips from the Inspector panel
- Effects can be enabled/disabled, inverted, and removed
- CSS `mask-image` property renders masks in real-time

**New Files:**
- `src/components/MaskGenerationDialog.jsx` - Mask generation UI
- `public/workflows/mask_generation_text_prompt.json` - ComfyUI workflow

**Modified Files:**
| File | Changes |
|------|---------|
| `src/services/comfyui.js` | Added `uploadFile()`, `downloadImage()`, `downloadImageSequence()`, `modifyMaskWorkflow()` |
| `src/hooks/useComfyUI.js` | Added `generateMask()`, `maskResult`, `clearMaskResult` |
| `src/stores/assetsStore.js` | Added mask asset type, `addMaskAsset()`, `getMasksForAsset()`, `getAllMasks()` |
| `src/stores/timelineStore.js` | Added effects system: `addEffect()`, `removeEffect()`, `updateEffect()`, `toggleEffect()`, `addMaskEffect()` |
| `src/components/panels/AssetsPanel.jsx` | Added "Create Mask..." context menu option, mask badge styling |
| `src/components/VideoLayerRenderer.jsx` | Added `useMaskEffectStyle()` hook for CSS mask rendering |
| `src/components/InspectorPanel.jsx` | Replaced placeholder effects with functional mask effect controls |

**Clip Effects Data Structure:**
```javascript
clip.effects = [
  {
    id: 'effect-1',
    type: 'mask',
    enabled: true,
    maskAssetId: 'asset-123',
    invertMask: false,
    feather: 0,
  }
]
```

**Mask Asset Structure:**
```javascript
{
  id: 'asset-123',
  type: 'mask',
  name: 'Person Mask',
  sourceAssetId: 'asset-456',  // Links to original video/image
  prompt: 'person on the left',
  url: 'blob:...',  // Single frame URL
  maskFrames: [...],  // For video masks (PNG sequence)
  frameCount: 120,
}
```

### Session Updates (Feb 3, 2026 - Render Cache System)

**Render Cache for Effect Playback:**
When clips have effects (like masks), real-time compositing can cause desync. The render cache pre-renders clips to ensure smooth playback.

**How It Works:**
1. Select a clip with mask effects applied
2. In Inspector panel → Effects section, click "Render Cache"
3. System renders each frame with effects baked in
4. Cached video plays back smoothly without desync
5. Cache auto-invalidates when effects change (yellow "outdated" indicator)

**Cache File Storage:**
```
MyProject/
├── project.comfystudio
├── assets/
├── cache/                          # NEW - Render cache folder
│   ├── clip-123_1234567890.webm   # Cached video with effects
│   └── clip-123_1234567890.meta.json  # Cache metadata
└── renders/
```

**New Files:**
- `src/services/renderCache.js` - Frame-by-frame rendering engine

**Modified Files:**
| File | Changes |
|------|---------|
| `src/services/fileSystem.js` | Added `saveRenderCache()`, `loadRenderCache()`, `listRenderCaches()`, `deleteRenderCache()`, `clearClipRenderCaches()` |
| `src/stores/timelineStore.js` | Added `cacheStatus`, `cacheProgress`, `cacheUrl`, `cachePath` to clips; `setCacheStatus()`, `setCacheUrl()`, `invalidateCache()`, `clearClipCache()` |
| `src/components/InspectorPanel.jsx` | Added render cache UI with progress bar, render/clear buttons, status indicators |
| `src/components/VideoLayerRenderer.jsx` | Uses cached URL when available, skips CSS masks for cached clips |
| `src/components/Timeline.jsx` | Cache status badges on clips (⚡=effects, ✓=cached, ⚠=outdated, 🔄=rendering) |
| `src/components/PreviewPanel.jsx` | Added `MaskPreview` component for frame-by-frame mask playback |

**Clip Cache Data Structure:**
```javascript
clip: {
  // ... existing fields ...
  effects: [...],
  cacheStatus: 'none' | 'rendering' | 'cached' | 'outdated',
  cacheProgress: 0-100,
  cacheUrl: 'blob:...',     // In-memory blob URL for playback
  cachePath: 'cache/clip-123_xxx.webm',  // Path on disk for persistence
}
```

**Render Cache Service (`renderCache.js`):**
- Two-phase rendering: 1) Extract all frames with masks applied, 2) Encode to WebM
- Uses `canvas.captureStream(0)` + `MediaRecorder` for encoding
- Pixel-level mask compositing (mask luminance → alpha channel)
- VP9 codec with alpha channel support (`vp09.00.10.08`)
- `requestAnimationFrame` for precise frame timing during encoding
- Progress callbacks for UI updates
- Cancellation support

**File System Cache Functions:**
```javascript
// Save cache to disk
saveRenderCache(projectDir, clipId, blob, metadata) → 'cache/clip-xxx.webm'

// Load cache from disk  
loadRenderCache(projectDir, relativePath) → { url, metadata }

// List all caches
listRenderCaches(projectDir) → [{ clipId, path, metadata }]

// Delete cache
deleteRenderCache(projectDir, relativePath)

// Clear all caches for a clip
clearClipRenderCaches(projectDir, clipId)
```

**Inspector Cache UI:**
- Shows current cache status with icon
- Progress bar during rendering
- Buttons: "Render Cache", "Re-render" (if outdated), "Clear Cache", "Cancel"
- Automatically clears cache when effects are modified

**Video Playback Improvements:**
- Reduced seek threshold from 0.08s to 0.02s for frame-accurate stepping
- Mask preview component with frame-by-frame playback
- Fixed infinite render loop when selecting masks

### Session Updates (Feb 4, 2026)

**Render Cache Disk Loading Fix:**
- Fixed issue where cached clips would not play from disk cache after page refresh
- Problem: Blob URLs stored in `cacheUrl` become invalid after page refresh
- Solution: Added `useDiskCacheLoader` hook that detects clips with `cachePath` but stale `cacheUrl`
- On detection, automatically loads the cached WebM file from disk using `loadRenderCache()`
- Creates a new valid blob URL and updates the clip's `cacheUrl` in the store
- Added `diskCacheUrls` map to track which URLs have been loaded this session
- Added `clearDiskCacheUrl()` export to properly cleanup when cache is cleared
- Files: `src/components/VideoLayerRenderer.jsx`, `src/components/InspectorPanel.jsx`

**ProRes Import & Export (Feb 4, 2026):**
- **Export**: Added format "MOV (ProRes)" with profile selector (Proxy, LT, Standard, HQ, 4444). Uses FFmpeg `prores_ks`, output `.mov`; audio AAC. No NVENC for ProRes.
- **Import**: `.mov` already supported in Assets/dialog; ProRes-in-MOV imports like any video.
- Files: `src/components/ExportPanel.jsx`, `src/services/exporter.js`, `electron/main.js`

**Launch & Layout (Feb 4, 2026):**
- **DevTools**: No longer open automatically on launch; still available via F12 or Ctrl+Shift+I.
- **Layout persistence**: Timeline height, left/right panel width, and panel expanded state saved to `localStorage` (`comfystudio-editor-layout`) and restored on next launch.
- **Default timeline height**: 320px (was 240px) so track headers are visible without resizing.
- **Track headers width**: Default 208px (was 144px); persisted in `comfystudio-timeline-track-headers-width`.
- Files: `electron/main.js`, `src/App.jsx`, `src/components/Timeline.jsx`

**Audio Tracks & Mono/Stereo (Feb 4, 2026):**
- Default audio tracks renamed to **Audio 1, Audio 2, Audio 3** (ids `audio-1`, `audio-2`, `audio-3`). User can rename as needed.
- **Stereo tracks**: Shown as double height with L/R bands in timeline (header and content); same clip spans both.
- **Mono tracks**: Single height; export downmixes stereo sources to mono for that track.
- **Export**: Respects `track.channels` (mono = downmix, stereo = keep L/R).
- Files: `src/stores/timelineStore.js`, `src/stores/projectStore.js`, `src/components/Timeline.jsx`, `src/services/exporter.js`

**Generate Tab Progress (Feb 4, 2026):**
- **Sticky progress strip** below the Generate header when generating: status text, progress bar, %, current node, queue count.
- **Real ComfyUI progress**: Bar uses `progress` from useComfyUI when available (WebSocket); otherwise time-based estimate.
- **Immediate feedback**: Progress starts at 5% and bumps at Upload (10%), Load workflow (20%), Configure (30%), Queue (40%).
- Removed "WebSocket not connected - progress may be estimated" warning (generation still works via HTTP polling).
- Files: `src/components/GenerateWorkspace.jsx`

**Video Generation Import Fix (Feb 4, 2026):**
- LTX2 and WAN 2.2 video outputs were not imported: code only checked `videos` and nodes 75/108. ComfyUI can return SaveVideo output under **`gifs`**.
- **Fix**: Check both `videos` and `gifs` for video output; scan all output node IDs (not just 75, 108); support history response with `outputs` at top level (`history?.outputs` fallback).
- Files: `src/components/GenerateWorkspace.jsx` (`pollForResult`)

### Electron Migration (Feb 4, 2026)

Converted the web app to an Electron desktop application with native file system access.

**Why Electron:**
- Native file paths instead of blob URLs (no more stale URL issues after refresh)
- No browser sandbox limitations
- Future: Native FFmpeg for frame-accurate encoding
- Future: Hardware-accelerated encoding (NVENC, QuickSync)

**Architecture:**
```
┌─────────────────────────────────────────────────┐
│ Renderer Process (React App)                     │
│  ├── fileSystem.js → window.electronAPI          │
│  └── Components → fileSystem.js                  │
├─────────────────────────────────────────────────┤
│ Preload Script (contextBridge)                   │
│  └── Exposes electronAPI to renderer             │
├─────────────────────────────────────────────────┤
│ Main Process (Node.js)                           │
│  ├── IPC handlers for file operations            │
│  ├── Electron dialog API                         │
│  └── Node.js fs module                           │
└─────────────────────────────────────────────────┘
```

**New/Modified Files:**

| File | Changes |
|------|---------|
| `electron/main.js` | Expanded with 20+ IPC handlers for file ops, dialog, settings |
| `electron/preload.js` | Exposes `window.electronAPI` with all file system methods |
| `src/services/fileSystem.js` | Dual-mode: Electron (IPC) vs Web (File System Access API) |
| `src/stores/projectStore.js` | Supports string paths (Electron) and handles (Web) |
| `src/components/WelcomeScreen.jsx` | Updated to use `openRecentProject()` for both modes |
| `package.json` | Added electron-builder config, new scripts |
| `vite.config.js` | Configured for Electron compatibility |

**Running the App:**
```bash
# Development (hot reload)
npm run electron:dev

# Build for distribution
npm run electron:build        # All platforms
npm run electron:build:win    # Windows only
npm run electron:build:mac    # macOS only
npm run electron:build:linux  # Linux only
```

**IPC API (window.electronAPI):**
- `selectDirectory(options)` - Native folder picker
- `selectFile(options)` - Native file picker
- `exists(path)` - Check if file/folder exists
- `createDirectory(path)` - Create folders
- `readFile(path, options)` - Read files
- `writeFile(path, data, options)` - Write files
- `deleteFile(path)` - Delete files
- `copyFile(src, dest)` - Copy files
- `listDirectory(path)` - List folder contents
- `pathJoin(...parts)` - Join path segments
- `getAppPath(name)` - Get special paths (documents, userData, etc.)
- `getFileUrlDirect(path)` - Get file:// URL for media playback
- `encodeVideo(options)` - Encode export frames with FFmpeg
- `checkNvenc()` - Detect NVENC support in FFmpeg
- `getSetting(key)` / `setSetting(key, value)` - Persistent settings

**File URL Handling:**
- Web mode: Uses `URL.createObjectURL()` with blob URLs
- Electron mode: Uses `file://` protocol URLs directly
- Video/audio elements work natively with file:// URLs in Electron

**What Stays the Same:**
- All React components and UI
- Zustand stores (timeline, assets, project)
- Timeline/preview/inspector logic
- ComfyUI integration
- Keyframe animation system
- Transform/crop/effects system

### Thumbnail Sprites for Fast Scrubbing (Feb 4, 2026)

Added filmstrip-style thumbnail sprite generation for instant scrubbing performance.

**How It Works:**
1. When a video is imported, thumbnail sprites are auto-generated in background
2. Sprites contain ~60 frames extracted from the video at regular intervals
3. Sprites are saved to `project/thumbnails/` folder as JPEG files
4. During scrubbing, sprite frames are displayed instead of seeking the video
5. When scrubbing stops, the precise video frame is shown

**Project Folder Structure Update:**
```
MyProject/
├── project.comfystudio
├── assets/
├── cache/
├── thumbnails/              # NEW - Sprite storage
│   ├── asset123_sprite.jpg  # Sprite image (filmstrip)
│   └── asset123_sprite.json # Metadata (frame positions)
└── renders/
```

**New Files:**
- `src/services/thumbnailSprites.js` - Sprite generation and loading

**Modified Files:**
- `src/stores/assetsStore.js` - Added `generateAssetSprite()`, `loadSpritesFromProject()`, `updateAssetSprite()`
- `src/components/VideoLayerRenderer.jsx` - Shows sprite during scrubbing, hides video
- `src/components/panels/AssetsPanel.jsx` - "Generate Thumbnails" context menu, auto-generation on import

**Asset Panel Indicators:**
- Blue filmstrip icon: Thumbnails are ready
- Spinning loader: Thumbnails being generated
- Right-click video → "Generate Thumbnails" to manually regenerate

**Scrubbing Performance:**
- Without sprites: Video decoding on each scrub (sluggish)
- With sprites: Instant CSS background-position change (smooth)
- Sprite visible during scrub, video shown when stopped

### Session Updates (Feb 17, 2026)

**Inspector Enter key + transport shortcut fix:**
- Pressing `Enter` while typing a number in Inspector now commits the value without triggering timeline playback.
- `InspectorPanel.jsx`: `DraggableNumberInput` now calls `preventDefault()` and `stopPropagation()` on Enter before commit.
- `TransportControls.jsx`: Enter-to-play now ignores key events originating from input/textarea/select/contentEditable targets.

**Fullscreen preview framing parity + scrubber:**
- Fixed fullscreen framing mismatch where fullscreen showed wider side content than normal mode.
- `PreviewPanel.jsx` now uses the same measured render dimensions path in normal and fullscreen so transform scale and container size stay aligned.
- Added fullscreen scrubber (click + drag seek) with current/total timecode in the fullscreen transport bar.

**Inspector header cleanup (text-only):**
- Removed the clip-type icon tile from video/image/text/audio inspector headers for a cleaner text-only header.
- `InspectorPanel.jsx` header now shows name/track/duration (or audio name/type) without icon boxes.

**Default track count for new projects/timelines:**
- New project and new timeline defaults now start with **1 video track** and **1 audio track**.
- Updated default/fallback track arrays in `src/stores/projectStore.js` and `src/stores/timelineStore.js`.

**Generate WAN i2v reliability guard:**
- Reviewed WAN i2v pipeline and workflow (`video_wan2_2_14B_i2v.json`): no self-referential graph loop found in the JSON.
- Added polling guard in `GenerateWorkspace.jsx`: after repeated consecutive `/history` poll failures, abort with clear error (`Lost connection to ComfyUI while waiting for generation result`) instead of polling indefinitely.

**Generate resolution presets:**
- Added `960x540` (landscape) and `540x960` (portrait) options to Video generation resolution dropdown in `GenerateWorkspace.jsx`.

---
*Backup of previous version: `backUP01_PROJECT_SUMMARY.md`*
