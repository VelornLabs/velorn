#!/usr/bin/env node

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import archiver from 'archiver'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const sourceDir = path.join(repoRoot, 'docs', 'workflow-starter-pack')
const releaseDir = path.join(repoRoot, 'release')

async function main() {
  const packageJson = JSON.parse(await fsPromises.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const artifactName = `velorn-workflow-starter-pack-v${packageJson.version}.zip`
  const artifactPath = path.join(releaseDir, artifactName)

  await fsPromises.mkdir(releaseDir, { recursive: true })
  await fsPromises.rm(artifactPath, { force: true })

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(artifactPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)

    archive.pipe(output)
    archive.directory(sourceDir, false)
    archive.finalize()
  })

  console.log(`Packaged starter pack: ${artifactPath}`)
}

main().catch((error) => {
  console.error('Failed to package workflow starter pack:', error)
  process.exitCode = 1
})
