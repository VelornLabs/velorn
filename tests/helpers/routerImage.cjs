'use strict'

const { deflateSync } = require('node:zlib')
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
function chunk(type, bytes) {
  const label = Buffer.from(type, 'ascii'), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  let crc = 0xffffffff
  for (const value of Buffer.concat([label, bytes])) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, label, bytes, checksum])
}

// A complete synthetic PNG that Electron's actual nativeImage decoder can
// verify. Never load user media or use a signature-only stub for packaged tests.
function createRouterTestPng({ width = 1024, height = 1024 } = {}) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 2048)) throw new Error('Test image dimensions are out of bounds')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 6 // eight-bit RGBA, standard compression/filtering
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 4 + 1) + 1
    for (let x = 0; x < width; x++) { pixels[offset + x * 4] = 40; pixels[offset + x * 4 + 1] = 90; pixels[offset + x * 4 + 2] = 140; pixels[offset + x * 4 + 3] = 255 }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

module.exports = { createRouterTestPng }
