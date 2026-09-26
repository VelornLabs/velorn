import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowUrl = new URL('../public/workflows/video_ltx2_3_t2v.json', import.meta.url)

test('LTX 2.3 T2V uses an empty image and never requires a local placeholder', async () => {
  const workflow = JSON.parse(await readFile(workflowUrl, 'utf8'))
  const placeholderNode = workflow['267:276']
  const resizeNode = workflow['267:238']

  assert.deepEqual(placeholderNode, {
    inputs: {
      width: 512,
      height: 512,
      batch_size: 1,
      color: 0,
    },
    class_type: 'EmptyImage',
    _meta: {
      title: 'Empty Image',
    },
  })
  assert.deepEqual(resizeNode.inputs.input, ['267:276', 0])

  const loadImagePlaceholders = Object.values(workflow).filter((node) => {
    if (!node || typeof node !== 'object' || node.class_type !== 'LoadImage') return false
    const image = node.inputs?.image
    return typeof image === 'string' && /(^|\/)(example|placeholder)\.(png|jpe?g|webp)$/i.test(image)
  })

  assert.equal(loadImagePlaceholders.length, 0)
})
