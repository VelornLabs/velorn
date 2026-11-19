# Velorn v0.4.0 — New ways to create: Visuals, Sound, GPU sharing and Velo

This is the biggest Velorn release so far. You can share your graphics card with
other creators, reach Velorn from your phone, and work with Velo, the built-in
assistant. Two new tabs, Visuals and Sound, make pictures, video, voices and sound
effects through Comfy Router with your own Comfy key.

Editing, captions and export work as before. ComfyUI is still at the heart of
generation: the ComfyUI tab is there for local models and your own workflows,
and Visuals and Sound run on Comfy's own service.

## GPU sharing (Beta)

The new **GPU sharing** tab lets creators lend their graphics card to each other
when it is idle, for free.

- **Use a shared GPU:** pick a workflow someone shares, write a description, and
  the result is made on their computer and saved into your project.
- **Share your own:** add a ComfyUI workflow you saved to Velorn, test it on your
  computer, and share it with the people you invite. You can also offer it to
  everyone; a person at Velorn looks at it first.
- Shared workflows can make pictures, video and music. A music workflow takes a
  description, optional lyrics and a length of up to four minutes.
- Nobody can send their own workflow to your computer. Only the ones you added
  run there, and only the description, a picture, lyrics and a length come from
  the sender.

This is experimental. Sharing is off until you switch it on, and "no GPU
available right now" is a normal answer. Nudity and sexual content are not
allowed; an owner can report a job, and accounts that break the rules lose
access.

## Velorn on your phone

Open Velorn in your phone's browser and connect it to a computer that is running
Velorn. From the phone you can talk to Velo, make pictures and video, and use
shared GPUs, while the work happens on your computer and lands in your project.

## Velo, the built-in assistant

Sign in to a Velorn account and **Velo** can answer questions about your project
and make edits for you. With **Full access** switched on, Velo can also run
commands and work with files on your computer.

- Full access works on Windows, macOS and Linux.
- Pressing Stop, or closing Velorn, ends everything a command started.
- Velo tells you when a command will be stopped at the end of its answer.

## Visuals: pictures and video

The new **Visuals** tab makes pictures and video clips through Comfy Router,
Comfy's service for running models in the cloud. Paste your Comfy key once and
pick a model.

- You see the price before anything is charged, and what it cost afterwards.
- Several pictures from one click, and a picture as the starting point for an
  edit or a clip.
- Results are saved into the open project, in their own folder, ready for the
  timeline.
- It runs on Comfy's service and uses your Comfy credits, so ComfyUI does not
  have to be installed on your computer for this tab.

## Sound: voices and effects

The new **Sound** tab makes spoken voice and sound effects the same way, through
Comfy Router. Each voice can be heard for free before you spend anything, and a
finished sound goes to the timeline with one click.

Both tabs say on screen that they run on Comfy Router and use Comfy credits. For
local models and your own workflows, use the ComfyUI tab.

## Your Comfy credit balance

The balance at the top right now also shows when ComfyUI is not installed. It is
read with the Comfy key you pasted in Visuals.

## Director: a music video from a song

The **Director** tab starts with Music Video. Give it a song and Velorn listens to
it and writes down the lyrics with their timing, so each line can become a shot.

- Listening runs on your own computer and is free. The first time, Velorn
  downloads its listening tools (about 3 GB).
- On a computer with a graphics card, listening is much faster in this version:
  finding the voice and lining up the words now use the card when that works,
  and the processor otherwise.
- You can also bring the lyrics as a file with timings.

## Also in this release

- **Tutorials** tab.
- **Faster export.**
- What you make in Visuals, Sound and GPU sharing is filed in a folder of that
  name in the Assets panel, instead of loose at the top.
- The Windows installer now carries the Microsoft Visual C++ runtime files that
  song listening needs, so it starts on a freshly installed Windows.

## Good to know

- **Comfy credits:** Visuals and Sound spend credits from your own Comfy
  account. Velorn shows the price first and never spends without a click.
- **ComfyUI:** local models, custom workflows and the workflows you share on
  GPU sharing all run in ComfyUI on your own computer.
- **Music:** Sound has no music model yet. Music can be made on a shared GPU, or
  in ComfyUI.
- **Song listening on older computers:** without a graphics card, and on older
  processors, listening to a whole song can take a long time and may be stopped
  after 45 minutes. Bringing a lyrics file is the way around it.
- **Song listening on Intel Macs** is not available.
- **GPU sharing from the phone** shows pictures and video only, not music.

## Downloads

- `Windows Installer`: standard Windows install for most users
- `Windows Portable`: no-install Windows build
- `Mac (Apple Silicon)`: for M1, M2, M3 and newer Macs
- `Mac (Intel)`: for older Intel-based Macs
- `Linux AppImage`: portable Linux build
- `Linux deb`: Debian/Ubuntu package

Ignore the auto-generated source-code archives unless you plan to build Velorn
from source.
