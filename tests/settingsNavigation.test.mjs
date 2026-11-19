import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_GROUPS, SETTINGS_PAGES, resolveSettingsTarget, searchSettings } from '../src/config/settingsNavigation.mjs'

test('settings has exactly six groups and every page belongs to one group', () => {
  assert.deepEqual(SETTINGS_GROUPS.map(group => group.title), ['General', 'Editing', 'Media & Storage', 'Playback & Export', 'Connections', 'New Project Defaults'])
  const pages = SETTINGS_GROUPS.flatMap(group => group.pages)
  assert.equal(new Set(pages).size, pages.length)
  assert.deepEqual(new Set(pages), new Set(SETTINGS_PAGES.map(page => page.id)))
  assert.ok(!pages.includes('feedback'))
})

test('all legacy deep links retain their specific destination', () => {
  for (const pageId of ['storage', 'stock', 'agents', 'paths', 'workflow-setup', 'language', 'appearance', 'notifications', 'hotkeys', 'project']) {
    assert.equal(resolveSettingsTarget(pageId).pageId, pageId)
  }
  for (const legacy of ['connection', 'launcher']) assert.deepEqual(resolveSettingsTarget(legacy), { groupId: 'connections', pageId: 'comfy' })
  assert.deepEqual(resolveSettingsTarget('feedback'), { groupId: 'feedback', pageId: 'feedback' })
})

test('group links open their first page and invalid links open General', () => {
  for (const group of SETTINGS_GROUPS) assert.equal(resolveSettingsTarget(group.id).groupId, group.id)
  for (const unknown of [null, undefined, '', 'not-settings']) assert.deepEqual(resolveSettingsTarget(unknown), { groupId: 'general', pageId: 'appearance' })
})

test('search finds creator terms, legacy terms and all-word matches', () => {
  for (const [query, page] of [['hide generate', 'appearance'], ['show generate tab', 'appearance'], ['delete files', 'assets'], ['trash', 'assets'], ['launcher', 'comfy'], ['ffmpeg', 'ffmpeg'], ['keyboard', 'hotkeys'], ['api key', 'stock'], ['fps', 'project'], ['proxy', 'cache']]) {
    assert.ok(searchSettings(query).some(result => result.id === page), query)
  }
  assert.deepEqual(searchSettings('notarealsetting'), [])
  assert.deepEqual(searchSettings('  '), [])
  assert.deepEqual(searchSettings('TRASH'), searchSettings('trash'))
  assert.equal(searchSettings('files ffmpeg').length, 0)
})

test('search accepts translated page and group labels without losing keyword search', () => {
  const pages = SETTINGS_PAGES.map(page => ({ ...page, title: page.id === 'language' ? '言語' : page.title }))
  assert.equal(searchSettings('言語', pages)[0].id, 'language')
  assert.equal(searchSettings('locale', pages)[0].id, 'language')
})

test('optional tool setup is reachable without replacing existing connection pages', () => {
  assert.deepEqual(resolveSettingsTarget('setup'), { groupId: 'connections', pageId: 'setup' })
  assert.deepEqual(resolveSettingsTarget('connections'), { groupId: 'connections', pageId: 'setup' })
  for (const query of ['codex sign in', 'lm studio', 'editor only', 'first run']) {
    assert.ok(searchSettings(query).some(result => result.id === 'setup'), query)
  }
  for (const page of ['agents', 'comfy', 'cloud', 'stock', 'workflow-setup']) {
    assert.equal(resolveSettingsTarget(page).pageId, page)
  }
})

test('hosted account setup is discoverable on the existing cloud page', () => {
  for (const query of ['hosted cloud', 'account access', 'subscription', 'partner api']) {
    assert.ok(searchSettings(query).some(result => result.id === 'cloud'), query)
  }
  assert.deepEqual(resolveSettingsTarget('cloud'), { groupId: 'connections', pageId: 'cloud' })
})
