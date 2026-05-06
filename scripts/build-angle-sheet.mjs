#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    cols: 4,
    rows: 2,
    cellWidth: 1024,
    cellHeight: 576,
    maxImages: 8,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') options.input = argv[++i]
    else if (arg === '--output') options.output = argv[++i]
    else if (arg === '--cols') options.cols = Number(argv[++i])
    else if (arg === '--rows') options.rows = Number(argv[++i])
    else if (arg === '--cell-width') options.cellWidth = Number(argv[++i])
    else if (arg === '--cell-height') options.cellHeight = Number(argv[++i])
    else if (arg === '--max-images') options.maxImages = Number(argv[++i])
  }

  return options
}

function printUsage() {
  console.log(
    'Usage: node scripts/build-angle-sheet.mjs --input <folder> [--output <png>] [--cols 4] [--rows 2] [--cell-width 1024] [--cell-height 576] [--max-images 8]'
  )
}

async function getImageFiles(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

function buildFilterGraph(totalImages, cols, cellWidth, cellHeight) {
  const chains = []
  for (let i = 0; i < totalImages; i += 1) {
    // Fit each image inside its cell with padding so aspect ratio stays intact.
    chains.push(
      `[${i}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black[v${i}]`
    )
  }

  const inputs = Array.from({ length: totalImages }, (_, i) => `[v${i}]`).join('')
  const layout = Array.from({ length: totalImages }, (_, i) => {
    const x = (i % cols) * cellWidth
    const y = Math.floor(i / cols) * cellHeight
    return `${x}_${y}`
  }).join('|')

  chains.push(`${inputs}xstack=inputs=${totalImages}:layout=${layout}[outv]`)
  return chains.join(';')
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    ffmpeg.on('error', (err) => reject(err))
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `ffmpeg exited with code ${code}`))
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input) {
    printUsage()
    process.exitCode = 1
    return
  }

  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available. Run npm install first.')
  }

  const inputDir = path.resolve(args.input)
  const cols = Number.isFinite(args.cols) && args.cols > 0 ? Math.floor(args.cols) : 4
  const rows = Number.isFinite(args.rows) && args.rows > 0 ? Math.floor(args.rows) : 2
  const maxSlots = cols * rows
  const maxImages = Math.min(maxSlots, Number.isFinite(args.maxImages) ? Math.max(1, Math.floor(args.maxImages)) : 8)
  const cellWidth = Number.isFinite(args.cellWidth) && args.cellWidth > 0 ? Math.floor(args.cellWidth) : 1024
  const cellHeight = Number.isFinite(args.cellHeight) && args.cellHeight > 0 ? Math.floor(args.cellHeight) : 576

  const files = await getImageFiles(inputDir)
  if (files.length === 0) {
    throw new Error(`No images found in: ${inputDir}`)
  }

  const selected = files.slice(0, maxImages)
  const outputPath = args.output
    ? path.resolve(args.output)
    : path.join(inputDir, 'angle_sheet.png')

  const outputDir = path.dirname(outputPath)
  await fs.mkdir(outputDir, { recursive: true })

  const ffmpegArgs = ['-y']
  for (const file of selected) {
    ffmpegArgs.push('-i', path.join(inputDir, file))
  }
  ffmpegArgs.push(
    '-filter_complex',
    buildFilterGraph(selected.length, cols, cellWidth, cellHeight),
    '-map',
    '[outv]',
    '-frames:v',
    '1',
    outputPath
  )

  await runFfmpeg(ffmpegArgs)
  console.log(`Built angle sheet: ${outputPath}`)
  console.log(`Used ${selected.length} image(s): ${selected.join(', ')}`)
}

main().catch((err) => {
  console.error(`[angle-sheet] ${err.message}`)
  process.exitCode = 1
})

