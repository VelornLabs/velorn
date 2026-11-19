// Run every Node regression test under the two source roots.
// Match only *.test.js/mjs/cjs: browser/Electron fixture entry points and other
// scripts are not launched by this inventory. Never follow directory symlinks.
// Invoke Node directly: recent Node releases no longer accept the historical
// --experimental-default-type flag present in some older npm test aliases.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const files = []
function collectTests(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Regression source root must be a real directory: ${directory}`)
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules') continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectTests(entryPath)
    else if (entry.isFile() && /\.test\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push('./' + path.relative(root, entryPath).split(path.sep).join('/'))
    }
  }
}
for (const directory of ['src', 'tests']) collectTests(path.join(root, directory))
files.sort()
if (!files.length) throw new Error('No regression tests were found under src or tests.')
console.log(`Running ${files.length} distinct regression files from src and tests (four processes maximum).`)
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=tap', ...files],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (result.status !== 0) {
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) console.error(`Unable to complete regression tests: ${result.error.message}`)
  else if (result.signal) console.error(`Regression tests terminated by ${result.signal}.`)
  else console.error(`Regression tests failed with exit code ${result.status}.`)
}
else console.log((result.stdout || '').split('\n').filter(line => /^# (tests|pass|fail|cancelled|skipped|duration_ms) /.test(line)).join('\n'))
process.exitCode = result.status === 0 ? 0 : 1
