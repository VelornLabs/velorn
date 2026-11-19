import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildPictureStarter, buildVideoStarter } from '../src/services/customWorkflowStarters.mjs'

const comfy = fs.readFileSync(new URL('../src/services/comfyui.js', import.meta.url), 'utf8')
const named = (graph) => graph.nodes.filter((node) => node.type !== 'MarkdownNote')
const notes = (graph) => graph.nodes.filter((node) => node.type === 'MarkdownNote')

for (const [kind, build, save] of [['picture', buildPictureStarter, 'VELORN_OUTPUT_IMAGE'], ['video', buildVideoStarter, 'VELORN_OUTPUT_VIDEO']]) {
  test(`the ${kind} starter is only named nodes and notes, nothing connected`, () => {
    const graph = build()
    assert.deepEqual(graph.links, [])
    const titles = named(graph).map((node) => node.title)
    assert.equal(new Set(titles).size, titles.length, 'no name twice')
    assert.ok(titles.includes(save))
    assert.ok(titles.includes('VELORN_PROMPT'))
    // Every name is one Velorn really looks for.
    for (const title of titles) assert.ok(comfy.includes(`'${title}'`), title)
    // A note for each node, plus the heading and "your model goes here".
    assert.equal(notes(graph).length, named(graph).length + 2)
    for (const title of titles) assert.ok(notes(graph).some((note) => note.widgets_values[0].startsWith(`## ${title}`)), title)
  })

  test(`the ${kind} starter is laid out: inputs in one column, the result to the right, nothing overlapping`, () => {
    const graph = build()
    const inputs = named(graph).filter((node) => node.title !== save)
    assert.equal(new Set(inputs.map((node) => node.pos[0])).size, 1)
    const out = named(graph).find((node) => node.title === save)
    assert.ok(out.pos[0] > inputs[0].pos[0] + inputs[0].size[0])
    const boxes = graph.nodes.map((node) => [node.pos[0], node.pos[1], node.pos[0] + node.size[0], node.pos[1] + node.size[1]])
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
      assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], 'two boxes overlap')
    }))
    assert.deepEqual(graph.nodes.map((node) => node.id), graph.nodes.map((_, index) => index + 1))
  })
}

test('the description is a plain text box, as the guide says', () => {
  for (const graph of [buildPictureStarter(), buildVideoStarter()]) {
    assert.equal(named(graph).find((node) => node.title === 'VELORN_PROMPT').type, 'PrimitiveStringMultiline')
  }
})
