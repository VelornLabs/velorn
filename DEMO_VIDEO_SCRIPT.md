# Velorn — 2–3 Minute Demo Video Script

Use this as a shooting guide: what to show, what to say, and rough timings. Total target: **2–3 minutes**.

---

## Opening (0:00–0:20) — Hook + What It Is

**On screen:** App open on Welcome Screen or Editor with a small project.

**Say something like:**
- "This is Velorn — an AI animatic and video editor that runs ComfyUI inside the app."
- "You get a Resolve-style timeline, and you can generate or extend video, images, and music without leaving the editor."

**Do:** If starting from Welcome, click into a recent project so we’re in the Editor quickly.

---

## Editor Tab (0:20–0:50) — Familiar NLE Layout

**On screen:** Editor tab, timeline with a few clips (video + maybe text).

**Show:**
- **Layout:** Left panel (tabs), big preview, right Inspector, transport bar, timeline.
- **Timeline:** Multi-track (Video 1, Video 2, Audio), clip trimming, drag to reorder.
- **Preview:** Play a bit; mention J/K/L or space for playback.
- **Inspector:** Select a clip → show Transform (position, scale, opacity), maybe Crop. Point out keyframe diamonds: "You can animate these with keyframes."

**Say:**
- "The Editor is your main workspace: timeline, preview, and inspector — trim, cut, slip, and keyframe like in Resolve or Premiere."
- "Everything you generate in the app can go straight onto the timeline."

---

## Generate Tab (0:50–1:25) — ComfyUI Inside the App

**On screen:** Switch to **Generate** tab.

**Show:**
- Workflow list: Video (T2V, I2V LTX2, WAN 2.2), Image (multi-angle, image edit), Audio (music).
- Pick one workflow (e.g. **Image to Video** or **Text to Video**).
- Enter a short prompt, set duration/resolution if visible, then **Queue**.
- Point at progress (sticky bar or queue item).
- When done (or use an already-generated asset): **Add to project** / import, then switch back to Editor and show the new clip on the timeline or in Assets.

**Say:**
- "In Generate, you run ComfyUI workflows directly: text-to-video, image-to-video, image edit, multiple angles, and music."
- "Queue a job, and when it’s done you drop the result onto the timeline — no switching to another app."

---

## Killer Feature: Extend with AI (1:25–1:55) — Must-Show

**On screen:** Editor, timeline with at least one video or image clip.

**Do:**
1. Move the **playhead** onto a video or image clip.
2. **Right-click the preview** (not the timeline).
3. Click **"Extend with AI"** or **"Starting keyframe for AI"**.
4. App switches to Generate with that frame as input. Show the card with the captured frame.
5. Choose **Image to Video (LTX2)** or **WAN 2.2**, type a prompt (e.g. "camera slowly zooms in"), queue.
6. Optional: say you can keep editing while it runs.

**Say:**
- "The big one: park the playhead on any clip, right-click the preview, and choose Extend with AI. That frame is sent to Generate; you pick a model, enter a prompt, and extend the video from there — all without leaving the editor."

---

## Quick Hits (1:55–2:25) — Optional but Strong

Pick 1–2 of these so you stay under 3 minutes:

- **Text:** Text tab → add a title or lower third → drag onto timeline. Show it in preview and maybe Inspector (font, color).
- **Assets & overlays:** Assets panel, folders, drag to timeline. Optional: right-click → Create overlay (letterbox/vignette/color matte).
- **Export:** Switch to **Export** tab → show format (H.264, ProRes, etc.), maybe Start export and show queue/ETA.
- **Multi-timeline:** Timeline switcher in transport bar → "You can have multiple timelines per project, e.g. 16:9 and 9:16."

**Say (short):**
- "You get text layers, asset folders, overlay generation, and export to H.264, HEVC, or ProRes."
- Or: "Multiple timelines per project, so you can do a horizontal and a vertical cut from the same assets."

---

## Close (2:25–3:00) — Open Source & Next Steps

**On screen:** Back to Editor or Welcome Screen.

**Say:**
- "Velorn will be free and open source. I’m still working on workflow management so it works with everyone’s ComfyUI setup — local or cloud."
- "If you’re on r/comfyui, thanks for the interest; link to the repo and a longer walkthrough will come once that’s ready. Cheers."

---

## Checklist Before Recording

- [ ] ComfyUI running at `http://127.0.0.1:8188` (or your URL) so Generate works.
- [ ] One project with a few clips (video + optional text) so Extend with AI and Editor look good.
- [ ] Optional: one pre-queued or fast workflow so you can show progress/result without waiting.
- [ ] Resolution: 1080p; capture the whole app window or main area so UI is readable.
- [ ] Close other apps/notifications; mute if you’re not talking live.

---

## One-Liner for Thumbnail / Description

**"Velorn — Resolve-style editor with ComfyUI built in. Edit, generate, and extend video in one app."**

Use this script as a roadmap; adjust wording to your style and cut any section if you’re over time.
