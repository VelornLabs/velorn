/**
 * Thumbnail Sprite Service
 * 
 * Generates filmstrip-style thumbnail sprites for video assets.
 * Sprites are saved to the project's thumbnails/ folder.
 * 
 * Sprite format:
 * - Single image containing multiple frames in a grid
 * - Default: 10 frames per row, ~180px height per frame
 * - Stored as JPEG for small file size
 * 
 * Usage:
 * 1. When video is imported, generate sprite in background
 * 2. During scrubbing, show sprite frame instead of seeking video
 * 3. When scrubbing stops, show actual video frame
 */

import { isElectron } from './fileSystem'

// Sprite configuration
const SPRITE_CONFIG = {
  frameHeight: 180,       // Height of each thumbnail frame (2x for clarity)
  framesPerRow: 10,       // Frames per row in sprite sheet
  maxFrames: 60,          // Maximum frames to extract (covers most short clips)
  jpegQuality: 0.8,       // JPEG quality (0-1)
  minDuration: 0.5,       // Don't generate sprites for clips shorter than this
}

const SPRITE_INDEX_FILE = 'sprite_index.json'

async function getThumbnailDirectory(projectPath) {
  const api = window.electronAPI
  return await api.pathJoin(projectPath, 'thumbnails')
}

export async function loadSpriteIndex(projectPath) {
  if (!isElectron()) return {}
  const api = window.electronAPI
  try {
    const thumbDir = await getThumbnailDirectory(projectPath)
    const indexPath = await api.pathJoin(thumbDir, SPRITE_INDEX_FILE)
    if (!await api.exists(indexPath)) return {}
    const result = await api.readFile(indexPath, { encoding: 'utf8' })
    if (!result.success) return {}
    const parsed = JSON.parse(result.data)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

async function saveSpriteIndex(projectPath, index) {
  if (!isElectron()) return
  const api = window.electronAPI
  const thumbDir = await getThumbnailDirectory(projectPath)
  await api.createDirectory(thumbDir)
  const indexPath = await api.pathJoin(thumbDir, SPRITE_INDEX_FILE)
  await api.writeFile(indexPath, JSON.stringify(index || {}, null, 2))
}

/**
 * Generate a thumbnail sprite for a video file
 * Uses canvas-based frame extraction (works in both Electron and web)
 * 
 * @param {string} videoUrl - URL or file path to the video
 * @param {number} duration - Video duration in seconds
 * @param {object} options - Optional overrides for SPRITE_CONFIG
 * @returns {Promise<{spriteUrl: string, spriteData: object}>}
 */
export async function generateThumbnailSprite(videoUrl, duration, options = {}) {
  const config = { ...SPRITE_CONFIG, ...options }
  
  if (duration < config.minDuration) {
    return null
  }
  
  // Calculate frame count based on duration
  // Aim for ~2 frames per second for good scrubbing resolution
  const frameCount = Math.min(
    config.maxFrames,
    Math.max(10, Math.ceil(duration * 2))
  )
  
  // Calculate sprite dimensions
  const rows = Math.ceil(frameCount / config.framesPerRow)
  
  // Create video element to extract frames
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = async () => {
      try {
        const aspectRatio = video.videoWidth / video.videoHeight
        const frameWidth = Math.round(config.frameHeight * aspectRatio)
        
        // Create canvas for sprite sheet
        const canvas = document.createElement('canvas')
        canvas.width = frameWidth * config.framesPerRow
        canvas.height = config.frameHeight * rows
        const ctx = canvas.getContext('2d')
        
        // Fill with black background
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        
        // Extract frames
        const frameInterval = duration / frameCount
        const frames = []
        
        for (let i = 0; i < frameCount; i++) {
          const time = i * frameInterval
          await seekToTime(video, time)
          
          // Calculate position in sprite
          const col = i % config.framesPerRow
          const row = Math.floor(i / config.framesPerRow)
          const x = col * frameWidth
          const y = row * config.frameHeight
          
          // Draw frame to canvas
          ctx.drawImage(video, x, y, frameWidth, config.frameHeight)
          
          frames.push({
            index: i,
            time,
            x,
            y,
            width: frameWidth,
            height: config.frameHeight,
          })
        }
        
        // Convert canvas to blob
        const blob = await new Promise(res => 
          canvas.toBlob(res, 'image/jpeg', config.jpegQuality)
        )
        
        // Create URL for the sprite
        const spriteUrl = URL.createObjectURL(blob)
        
        // Sprite metadata
        const spriteData = {
          url: spriteUrl,
          blob,
          width: canvas.width,
          height: canvas.height,
          frameWidth,
          frameHeight: config.frameHeight,
          frameCount,
          framesPerRow: config.framesPerRow,
          duration,
          frameInterval,
          frames,
        }
        
        // Clean up video element
        video.src = ''
        video.load()
        
        resolve({ spriteUrl, spriteData, blob })
      } catch (err) {
        reject(err)
      }
    }
    
    video.onerror = () => {
      reject(new Error('Failed to load video for sprite generation'))
    }
    
    video.src = videoUrl
  })
}

/**
 * Seek video to specific time and wait for frame to be ready
 */
function seekToTime(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      // Small delay to ensure frame is rendered
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve)
      })
    }
    
    video.addEventListener('seeked', onSeeked)
    video.currentTime = time
  })
}

/**
 * Save sprite to project's thumbnails folder
 * 
 * @param {string} projectPath - Project directory path
 * @param {string} assetId - Asset ID for naming
 * @param {Blob} spriteBlob - Sprite image blob
 * @param {object} spriteData - Sprite metadata
 * @returns {Promise<{spritePath: string, metaPath: string}>}
 */
export async function saveSpriteToProject(projectPath, assetId, spriteBlob, spriteData) {
  if (!isElectron()) {
    // In web mode, just return the blob URL (can't save to disk)
    return { spritePath: null, spriteData }
  }
  
  const api = window.electronAPI
  
  // Create thumbnails directory
  const thumbDir = await getThumbnailDirectory(projectPath)
  await api.createDirectory(thumbDir)
  
  // Save sprite image
  const spritePath = await api.pathJoin(thumbDir, `${assetId}_sprite.jpg`)
  const arrayBuffer = await spriteBlob.arrayBuffer()
  await api.writeFileFromArrayBuffer(spritePath, arrayBuffer)
  
  // Save metadata (without blob URL)
  const metaPath = await api.pathJoin(thumbDir, `${assetId}_sprite.json`)
  const metaToSave = {
    ...spriteData,
    url: undefined, // Don't save blob URL
    blob: undefined,
    assetId,
    createdAt: new Date().toISOString(),
  }
  await api.writeFile(metaPath, JSON.stringify(metaToSave, null, 2))

  try {
    const index = await loadSpriteIndex(projectPath)
    index[assetId] = {
      ...metaToSave,
      spritePath,
      metaPath,
    }
    await saveSpriteIndex(projectPath, index)
  } catch (err) {
    console.warn('Failed to update sprite index:', err)
  }
  
  return { spritePath, metaPath, spriteData: metaToSave }
}

/**
 * Load sprite from project's thumbnails folder
 * 
 * @param {string} projectPath - Project directory path
 * @param {string} assetId - Asset ID
 * @returns {Promise<{spriteUrl: string, spriteData: object}|null>}
 */
export async function loadSpriteFromProject(projectPath, assetId, spriteIndex = null) {
  if (!isElectron()) {
    return null
  }
  
  const api = window.electronAPI
  
  try {
    const thumbDir = await getThumbnailDirectory(projectPath)
    const indexedSprite = spriteIndex?.[assetId] || (spriteIndex ? null : (await loadSpriteIndex(projectPath))[assetId])
    const spritePath = indexedSprite?.spritePath || await api.pathJoin(thumbDir, `${assetId}_sprite.jpg`)
    const metaPath = indexedSprite?.metaPath || await api.pathJoin(thumbDir, `${assetId}_sprite.json`)
    
    // Check if files exist
    if (!await api.exists(spritePath)) {
      return null
    }

    let spriteData = indexedSprite || null
    if (!spriteData) {
      if (!await api.exists(metaPath)) return null
      const metaResult = await api.readFile(metaPath, { encoding: 'utf8' })
      if (!metaResult.success) return null
      spriteData = JSON.parse(metaResult.data)
    }
    
    // Get URL for sprite image
    const spriteUrl = await api.getFileUrlDirect(spritePath)
    
    return { spriteUrl, spriteData: { ...spriteData, url: spriteUrl } }
  } catch (err) {
    console.warn('Failed to load sprite:', err)
    return null
  }
}

/**
 * Delete sprite files for an asset
 * 
 * @param {string} projectPath - Project directory path
 * @param {string} assetId - Asset ID
 */
export async function deleteSpriteFromProject(projectPath, assetId) {
  if (!isElectron()) return
  
  const api = window.electronAPI
  
  try {
    const thumbDir = await getThumbnailDirectory(projectPath)
    const spritePath = await api.pathJoin(thumbDir, `${assetId}_sprite.jpg`)
    const metaPath = await api.pathJoin(thumbDir, `${assetId}_sprite.json`)
    
    await api.deleteFile(spritePath)
    await api.deleteFile(metaPath)

    try {
      const index = await loadSpriteIndex(projectPath)
      if (index && Object.prototype.hasOwnProperty.call(index, assetId)) {
        delete index[assetId]
        await saveSpriteIndex(projectPath, index)
      }
    } catch (_) {
      // Ignore index cleanup failures.
    }
  } catch (err) {
    // Ignore errors (files may not exist)
  }
}

/**
 * Get the frame position in a sprite for a given time
 * 
 * @param {object} spriteData - Sprite metadata
 * @param {number} time - Time in seconds
 * @returns {{x: number, y: number, width: number, height: number, frameIndex: number}}
 */
export function getSpriteFramePosition(spriteData, time) {
  if (!spriteData || !spriteData.frames) return null
  
  // Clamp time to valid range
  const clampedTime = Math.max(0, Math.min(time, spriteData.duration))
  
  // Find the closest frame
  const frameIndex = Math.min(
    Math.floor(clampedTime / spriteData.frameInterval),
    spriteData.frameCount - 1
  )
  
  const frame = spriteData.frames[frameIndex]
  if (!frame) return null
  
  return {
    ...frame,
    frameIndex,
    // CSS background-position values (negative because we're offsetting)
    backgroundPositionX: -frame.x,
    backgroundPositionY: -frame.y,
  }
}

/**
 * Generate CSS style for showing a sprite frame
 * 
 * @param {string} spriteUrl - URL of the sprite image
 * @param {object} spriteData - Sprite metadata
 * @param {number} time - Time in seconds
 * @returns {object} CSS style object
 */
export function getSpriteFrameStyle(spriteUrl, spriteData, time) {
  const framePos = getSpriteFramePosition(spriteData, time)
  if (!framePos || !spriteUrl) return null
  
  return {
    backgroundImage: `url(${spriteUrl})`,
    backgroundPosition: `${framePos.backgroundPositionX}px ${framePos.backgroundPositionY}px`,
    backgroundSize: `${spriteData.width}px ${spriteData.height}px`,
    backgroundRepeat: 'no-repeat',
    width: framePos.width,
    height: framePos.height,
  }
}

export default {
  generateThumbnailSprite,
  saveSpriteToProject,
  loadSpriteFromProject,
  deleteSpriteFromProject,
  loadSpriteIndex,
  getSpriteFramePosition,
  getSpriteFrameStyle,
  SPRITE_CONFIG,
}
