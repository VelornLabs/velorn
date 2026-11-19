// The starter for "My own workflow": for people who already build ComfyUI
// workflows. It is not a working example. It lays out the nodes Velorn fills
// in down the left, each with a note beside it, and the node that saves the
// result on the right. The builder puts a model in the middle and connects
// them.
//
// These are ComfyUI graphs (the kind the ComfyUI tab saves), so they carry
// positions and notes.

const NOTE_W = 340
const NODE_X = NOTE_W + 30
const NODE_W = 300
const GAP = 40

// [name, node type, output type, height, the note beside it, widget values]
const TEXT = ['PrimitiveStringMultiline', 'STRING', 170]
const NUMBER = ['PrimitiveInt', 'INT', 90]
const PICTURE = ['LoadImage', 'IMAGE', 330]

const PICTURE_INPUTS = [
  ['VELORN_PROMPT', ...TEXT, 'NEEDED. Velorn writes the description of the shot here.\n\nConnect it to your model\'s prompt.', ['']],
  ['VELORN_REFERENCE_IMAGE_1', ...PICTURE, 'Optional. Velorn puts the picture of the person in the shot here.\n\nConnect it to your model\'s first reference picture. A shot with nobody in it leaves this out.'],
  ['VELORN_REFERENCE_IMAGE_2', ...PICTURE, 'Optional. A second person, if the shot has two.\n\nDelete this node if your model takes one person.'],
  ['VELORN_PLACE_IMAGE', ...PICTURE, 'Optional. Velorn puts the picture of the place here.\n\nConnect it to another reference picture on your model. A shot with no place leaves this out.'],
  ['VELORN_SEED', ...NUMBER, 'Optional. Velorn puts a new number here each time, so no two pictures match.\n\nConnect it to your model\'s seed.', [0, 'fixed']],
  ['VELORN_WIDTH', ...NUMBER, 'Optional. The width of the picture: 1280 for 16:9, 720 for 9:16.\n\nConnect it only if your model takes any size.', [1280, 'fixed']],
  ['VELORN_HEIGHT', ...NUMBER, 'Optional. The height of the picture: 720 for 16:9, 1280 for 9:16.\n\nConnect it only if your model takes any size.', [720, 'fixed']],
]

const VIDEO_INPUTS = [
  ['VELORN_INPUT_IMAGE', ...PICTURE, 'NEEDED. Velorn puts the shot\'s keyframe here.\n\nConnect it to your model\'s starting picture.'],
  ['VELORN_PROMPT', ...TEXT, 'NEEDED. Velorn writes how the shot moves here.\n\nConnect it to your model\'s prompt.', ['']],
  ['VELORN_AUDIO', 'LoadAudio', 'AUDIO', 150, 'Optional. Velorn puts the shot\'s piece of the song here, already cut to length.\n\nConnect it if your model makes the lips follow the song.'],
  ['VELORN_DURATION', 'PrimitiveFloat', 'FLOAT', 90, 'Optional. The length of the shot in seconds.\n\nConnect it to your model\'s length. If your model counts frames, put a maths node in between.', [5]],
  ['VELORN_FPS', ...NUMBER, 'Optional. Frames per second.', [24, 'fixed']],
  ['VELORN_SEED', ...NUMBER, 'Optional. Velorn puts a new number here each time.\n\nConnect it to your model\'s seed.', [0, 'fixed']],
  ['VELORN_WIDTH', ...NUMBER, 'Optional. The width of the video.\n\nConnect it only if your model takes any size. Some need set sizes, like 704 instead of 720.', [1280, 'fixed']],
  ['VELORN_HEIGHT', ...NUMBER, 'Optional. The height of the video.\n\nConnect it only if your model takes any size.', [720, 'fixed']],
]

function build({ inputs, heading, middle, save }) {
  const nodes = []
  let id = 0
  const add = (node) => { nodes.push({ id: ++id, flags: {}, order: nodes.length, mode: 0, inputs: [], outputs: [], properties: {}, ...node }) }
  const note = (text, pos, size) => add({ type: 'MarkdownNote', pos, size, widgets_values: [text], title: 'Note' })

  note(heading, [0, -230], [NODE_X + NODE_W, 190])
  let y = 0
  for (const [name, type, outputType, height, text, values] of inputs) {
    // A note needs room for its words, so a short node gets a taller row.
    const row = Math.max(height, 160)
    note(`## ${name}\n\n${text}`, [0, y], [NOTE_W, row])
    add({
      type,
      title: name,
      pos: [NODE_X, y],
      size: [NODE_W, height],
      outputs: [{ name: outputType, type: outputType, links: null }],
      properties: { 'Node name for S&R': type },
      // A picture or sound node is left to pick the first file ComfyUI has.
      ...(values ? { widgets_values: values } : {}),
    })
    y += row + GAP
  }

  const middleX = NODE_X + NODE_W + 160
  note(middle, [middleX, 0], [420, 300])

  const saveX = middleX + 420 + 160
  note(`## ${save.name}\n\n${save.text}`, [saveX, 0], [NOTE_W, 150])
  add({
    type: save.type,
    title: save.name,
    pos: [saveX, 150 + GAP],
    size: [NOTE_W, 110],
    inputs: [{ name: save.input, type: save.inputType, link: null }],
    properties: { 'Node name for S&R': save.type },
    widgets_values: save.values,
  })

  return {
    id: `velorn-${save.inputType.toLowerCase()}-starter`,
    revision: 0,
    last_node_id: id,
    last_link_id: 0,
    nodes,
    links: [],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  }
}

const HOW = [
  '1. Put your model in the middle.',
  '2. Connect the nodes on the left to it, and its result to the node on the right.',
  '3. Delete the optional nodes you do not use. Keep the names on the ones you keep.',
  '4. Press **Save workflow** at the top, then pick it in Velorn.',
].join('\n')

export function buildPictureStarter() {
  return build({
    inputs: PICTURE_INPUTS,
    heading: `# Picture starter\n\nVelorn fills in the nodes on the left for each shot, runs the workflow, and takes the picture from the node on the right.\n\n${HOW}`,
    middle: '# Your model goes here\n\nAny model that makes a picture: one on this computer, or a paid one.\n\nIn: the description, and the pictures of the person and the place if it can use them.\n\nOut: one picture, into **VELORN_OUTPUT_IMAGE**.',
    save: { name: 'VELORN_OUTPUT_IMAGE', type: 'SaveImage', input: 'images', inputType: 'IMAGE', values: ['Velorn'], text: 'NEEDED. Connect your model\'s picture here. It goes back into the shot.' },
  })
}

export function buildVideoStarter() {
  return build({
    inputs: VIDEO_INPUTS,
    heading: `# Video starter\n\nVelorn fills in the nodes on the left for each shot, runs the workflow, and takes the video from the node on the right.\n\n${HOW}`,
    middle: '# Your model goes here\n\nAny model that turns a picture into a video: one on this computer, or a paid one.\n\nIn: the keyframe and the description, and the piece of the song if it can use it.\n\nOut: one video, into **VELORN_OUTPUT_VIDEO**.',
    save: { name: 'VELORN_OUTPUT_VIDEO', type: 'SaveVideo', input: 'video', inputType: 'VIDEO', values: ['video/Velorn', 'auto', 'auto'], text: 'NEEDED. Connect your model\'s video here. It goes back into the shot.' },
  })
}
