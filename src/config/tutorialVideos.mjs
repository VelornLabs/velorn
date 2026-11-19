// The videos shown in the Tutorials tab. This file is the whole list.
//
// To add a video: add one line to the group it belongs in.
//   v('<YouTube id>', '<title>', '<one short sentence>')
// The YouTube id is the last part of the link: https://youtu.be/<id>

const v = (youtubeId, title, description) => Object.freeze({ youtubeId, title, description })

export const TUTORIAL_GROUPS = Object.freeze([
  Object.freeze({
    id: 'start',
    title: 'Getting started',
    videos: Object.freeze([
      v('QTeXWNz90b8', 'Getting started', 'A first look at Velorn: the tabs along the top, and what each one is for.'),
      v('RIySNNAEbl4', 'Setting up with ComfyUI', 'Connect Velorn to ComfyUI, the program that makes pictures and videos on this computer.'),
      v('MX7HLtY5azQ', 'Your Velorn account', 'What a Velorn account is for, and how to make one. Editing and generation work without it.'),
    ]),
  }),
  Object.freeze({
    id: 'tabs',
    title: 'The tabs',
    videos: Object.freeze([
      v('qRck0h9sjsM', 'Editor overview', 'A tour of the Editor, where a video is put together.'),
      v('nsDaRPjGob0', 'Create overview', 'Create makes one picture, or one video, from a description.'),
      v('QeELnxcSajM', 'Sound overview', 'Sound makes three things: a voice, music, and sound effects.'),
      v('5yPAGVMiH5I', 'Stock overview', 'Stock is free footage, ready to use. The photos and videos come from Pexels.'),
      v('QaXvl__eQow', 'GPU sharing', 'Borrow a graphics card from another creator, or lend one. It is free.'),
      v('2FkIBs6fQH8', 'Export overview', 'Export turns the timeline into one video file.'),
      v('Rsw_-HPlDRE', 'The ComfyUI tab', 'The ComfyUI tab is ComfyUI itself, running inside Velorn.'),
    ]),
  }),
  Object.freeze({
    id: 'editor',
    title: 'The Editor, step by step',
    videos: Object.freeze([
      v('6cxGDYlhikI', 'Editor 1 - Assets', 'An asset is any file the project uses: a video, a picture, a song, a sound.'),
      v('SHbEGrD4yHs', 'Editor 2 - Timeline basics', 'Time runs from left to right, and each box is a clip.'),
      v('clR3CSbxjM4', 'Editor 3 - The tools', 'The row of buttons above the timeline, one by one.'),
      v('s8xSc7GUSCE', 'Editor 4 - Shortcuts', 'A shortcut is a key that does a job without the mouse.'),
      v('16WTCQIN5A4', 'Editor 5 - Text and captions', 'Text is words that someone types. Captions are words that Velorn writes, by listening to the sound.'),
      v('kIThd41Gtt0', 'Editor 6 - Transitions and effects', 'A transition changes how one clip turns into the next. An effect changes how a clip looks.'),
      v('a-Y4ufZ1Ckw', 'Editor 7 - The Inspector', 'The Inspector shows the settings of one clip. It is the place where a clip is changed.'),
      v('ENVbwI6pywo', 'Editor 8 - Keyframes and the Dope Sheet', 'A keyframe is a marked moment. It is how a picture moves, grows, or fades over time.'),
      v('h_HTbm1aBGY', 'Editor 9 - The Mixer', 'The Mixer sets how loud each sound track is.'),
      v('J2kJ_1yj2AM', 'Editor 10 - Scopes', 'A scope is a graph of the picture. It shows brightness and colour as measurements.'),
      v('P3XSTodoe_g', 'Editor 11 - Settings', 'Settings is where Velorn is adjusted to the person using it.'),
    ]),
  }),
  Object.freeze({
    id: 'phone',
    title: 'On your phone',
    videos: Object.freeze([
      v('e5YYMeo3Oq4', 'Velorn on your phone', "Use Velorn from a phone's browser. There is no app to install."),
    ]),
  }),
  Object.freeze({
    id: 'project',
    title: 'A whole project',
    videos: Object.freeze([
      v('vufOCBTg8PA', 'A music video from nothing', 'Make a music video starting from nothing. No song, no pictures, no clips.'),
    ]),
  }),
])
