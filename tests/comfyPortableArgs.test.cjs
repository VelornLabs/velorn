const assert = require('node:assert/strict')
const test = require('node:test')
const { buildPortableArgs } = require('../electron/comfyPortableArgs.cjs')

const base = { mainPy: 'C:\\ComfyUI portable\\ComfyUI\\main.py', launcherScript: 'C:\\ComfyUI portable\\run_nvidia_gpu.bat' }
const count = (args, value) => args.filter(token => token === value).length

test('default portable args suppress the browser, allow renderer CORS and use the configured port', () => {
  assert.deepEqual(buildPortableArgs(base), ['-s', base.mainPy, '--windows-standalone-build',
    '--disable-auto-launch', '--enable-cors-header', '*', '--port', '8188'])
  const args = buildPortableArgs({ ...base, port: 8189 })
  assert.deepEqual(args.slice(-2), ['--port', '8189'])
})

test('stock CPU and fast FP16 launchers retain their distinct mode', () => {
  const cpu = buildPortableArgs({ ...base, launcherScript: 'C:\\Portable\\RUN_CPU.BAT' })
  assert.equal(count(cpu, '--cpu'), 1)
  const fast = buildPortableArgs({ ...base, launcherScript: 'C:\\Portable\\run_nvidia_gpu_fast_fp16_accumulation.bat' })
  assert.deepEqual(fast.slice(3, 5), ['--fast', 'fp16_accumulation'])
  assert.equal(count(fast, '--fast'), 1)
  const ordinary = buildPortableArgs(base)
  assert.equal(ordinary.includes('--fast'), false)
  assert.equal(ordinary.includes('--cpu'), false)
})

test('stock script matching is exact and works with either path separator', () => {
  assert.ok(buildPortableArgs({ ...base, launcherScript: '/portable/run_cpu.bat' }).includes('--cpu'))
  assert.equal(buildPortableArgs({ ...base, launcherScript: 'C:\\Portable\\custom_run_cpu.bat' }).includes('--cpu'), false)
})

test('explicit mode options retain the entire original token sequence', () => {
  for (const extraArgTokens of [['--fast', 'fp16_accumulation', 'fp8_matrix_mult'], ['--fast=fp16_accumulation']]) {
    const args = buildPortableArgs({ ...base, launcherScript: 'C:\\Portable\\run_nvidia_gpu_fast_fp16_accumulation.bat', extraArgTokens })
    assert.deepEqual(args.slice(-extraArgTokens.length), extraArgTokens)
    assert.equal(args.slice(0, -extraArgTokens.length).includes('--fast'), false)
  }
  assert.equal(count(buildPortableArgs({ ...base, launcherScript: 'C:\\Portable\\run_cpu.bat', extraArgTokens: ['--cpu'] }), '--cpu'), 1)
})

test('extra tokens, repeated values and caller-owned arrays remain unchanged', () => {
  const extraArgTokens = Object.freeze(['--input-directory', 'same path', '--output-directory', 'same path',
    '--extra-model-paths-config', 'one.yaml', 'one.yaml', '--custom-value', '*', '--custom-empty', ''])
  const args = buildPortableArgs({ ...base, extraArgTokens })
  assert.deepEqual(args.slice(-extraArgTokens.length), [...extraArgTokens])
  assert.equal(count(args, 'same path'), 2)
  assert.equal(count(args, 'one.yaml'), 2)
  assert.equal(count(args, '*'), 2)
})

test('extra CORS flags override the wildcard default, including equals and optional-value form', () => {
  for (const extraArgTokens of [['--enable-cors-header', 'http://localhost:5173'],
    ['--enable-cors-header=http://localhost:5173'], ['--enable-cors-header']]) {
    const args = buildPortableArgs({ ...base, extraArgTokens })
    assert.equal(args.includes('*'), false)
    assert.deepEqual(args.slice(-extraArgTokens.length), extraArgTokens)
  }
})

test('browser suppression follows preference without deleting an explicit extra flag', () => {
  assert.equal(buildPortableArgs({ ...base, disableAutoLaunch: false }).includes('--disable-auto-launch'), false)
  assert.equal(count(buildPortableArgs({ ...base, extraArgTokens: ['--disable-auto-launch'] }), '--disable-auto-launch'), 1)
  assert.equal(count(buildPortableArgs({ ...base, disableAutoLaunch: false, extraArgTokens: ['--disable-auto-launch'] }), '--disable-auto-launch'), 1)
})

test('matching explicit ports use their original tokens instead of appending a second port', () => {
  for (const extraArgTokens of [['--port', '8189'], ['--port=8189'], ['--port', '8189', '--port=8189']]) {
    const args = buildPortableArgs({ ...base, port: '8189', extraArgTokens })
    assert.deepEqual(args.slice(-extraArgTokens.length), extraArgTokens)
    assert.equal(args.slice(0, -extraArgTokens.length).some(token => token.startsWith('--port')), false)
  }
})

test('conflicting explicit ports fail before spawn rather than connecting to a different server', () => {
  for (const extraArgTokens of [['--port', '8000'], ['--port=8000'], ['--port=8188', '--port', '8000']]) {
    assert.throws(() => buildPortableArgs({ ...base, extraArgTokens }), /port 8000.*configured for port 8188/)
  }
})

test('malformed or missing explicit ports and invalid configured ports are rejected', () => {
  for (const extraArgTokens of [['--port'], ['--port='], ['--port', '--cpu'], ['--port=0'], ['--port=65536'],
    ['--port=8e3'], ['--port', '8188.5'], ['--port', 'http://127.0.0.1:8188']]) {
    assert.throws(() => buildPortableArgs({ ...base, extraArgTokens }), /--port extra argument/)
  }
  for (const port of [null, false, true, 0, -1, 65536, Infinity, NaN, '8e3', '8188.5', '']) {
    assert.throws(() => buildPortableArgs({ ...base, port }), /configured ComfyUI port/)
  }
})

test('paths and extra arguments reject invalid token types and embedded NULs', () => {
  for (const mainPy of [undefined, null, '', ' ', 'main\0.py']) assert.throws(() => buildPortableArgs({ ...base, mainPy }), /main.py path/)
  for (const launcherScript of [undefined, null, '', ' ', 'run\0.bat']) assert.throws(() => buildPortableArgs({ ...base, launcherScript }), /launcher script path/)
  for (const extraArgTokens of [null, '--cpu', [123], ['--test\0']]) assert.throws(() => buildPortableArgs({ ...base, extraArgTokens }), /extra arguments/)
})
