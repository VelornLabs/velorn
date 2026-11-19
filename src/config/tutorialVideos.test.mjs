import assert from 'node:assert/strict'
import test from 'node:test'

import { TUTORIAL_GROUPS } from './tutorialVideos.mjs'
import { getYouTubeWatchUrl, isValidYouTubeVideoId } from '../services/discoverCatalog.mjs'

test('every tutorial has a title and a valid YouTube id that is listed only once', () => {
  const seen = new Set()
  const groupIds = new Set()
  assert.ok(TUTORIAL_GROUPS.length > 0)
  for (const group of TUTORIAL_GROUPS) {
    assert.ok(group.id && group.title, 'a group needs an id and a title')
    assert.ok(!groupIds.has(group.id), `group listed twice: ${group.id}`)
    groupIds.add(group.id)
    assert.ok(group.videos.length > 0, `group has no videos: ${group.id}`)
    for (const video of group.videos) {
      assert.ok(video.title?.trim(), `a video in ${group.id} has no title`)
      assert.ok(isValidYouTubeVideoId(video.youtubeId), `bad YouTube id for ${video.title}`)
      assert.ok(!seen.has(video.youtubeId), `video listed twice: ${video.title}`)
      seen.add(video.youtubeId)
      assert.match(getYouTubeWatchUrl(video.youtubeId), /^https:\/\/www\.youtube\.com\/watch\?v=/)
    }
  }
})
