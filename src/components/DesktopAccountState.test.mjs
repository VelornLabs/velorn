import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopAccountState, desktopAccountIdentity, desktopAccountEmail, desktopAccountStatus, desktopVeeStatus } from './DesktopAccountState.mjs'

test('account presentation subscriptions are stable and stale bridge cleanup cannot erase its replacement', () => {
  const store = createDesktopAccountState(), initial = store.getSnapshot()
  assert.equal(store.getSnapshot(), initial)
  let updates = 0
  const unsubscribe = store.subscribe(() => updates++)
  store.setProject(true); store.setProject(true)
  assert.equal(updates, 1)
  const old = { current: { scopeKey: 'old-project' } }, next = { current: { scopeKey: 'next-project' } }
  store.publish(old); store.publish(next); store.release(old)
  assert.equal(store.current(), next.current)
  assert.equal(updates, 3)
  store.release(next)
  assert.equal(store.current(), null)
  unsubscribe(); store.preference({ available: true })
  assert.equal(updates, 4)
})

test('Welcome only has read-only preference; closing a project invalidates every live action', () => {
  const store = createDesktopAccountState(), preference = { status: { guided: { registered: true } } }
  store.preference(preference)
  assert.equal(store.getSnapshot().preference, preference)
  assert.equal(store.current(), null)
  const live = { current: { scopeKey: 'project', mobile: { connectPhoneAccount() { throw Error('Never call') } } } }
  store.setProject(true); store.publish(live)
  assert.equal(store.current(), live.current)
  store.setProject(false)
  assert.equal(store.current(), null)
  assert.equal(store.getSnapshot().preference, preference)
})

test('profile uses only verified native account identity, never computer or device names', () => {
  assert.deepEqual(desktopAccountIdentity({ guided: { registered: true, account: { displayName: 'Jaime Example' } } }), { displayName: 'Jaime Example', initials: 'JE' })
  for (const guided of [null, { registered: true, computer: { name: 'Studio name' } }, { registered: false, account: { displayName: 'Old account' } },
    { registered: true, account: { displayName: 'Untrusted\nName' } }, { registered: true, account: { displayName: 'x'.repeat(121) } }]) {
    assert.deepEqual(desktopAccountIdentity({ guided }), { displayName: '', initials: '' })
  }
  assert.equal(desktopAccountIdentity({ guided: { registered: true, account: { displayName: '<script>' } } }).displayName, '<script>', 'React renders labels as text, not HTML')
})

test('phone registration is not presented as browser or provider sign-in', () => {
  assert.equal(desktopAccountStatus(null), 'Sign in for Velo access and phone connections. Velo availability depends on your account.')
  assert.equal(desktopAccountStatus({ guided: { phase: 'sign-in' } }), 'Finish signing in in your browser.')
  assert.equal(desktopAccountStatus({ guided: { phase: 'confirm-account' } }), 'Confirm your Velorn account in the desktop prompt.')
  assert.equal(desktopAccountStatus({ guided: { registered: true, enabled: false } }), 'Signed in. Phone sharing is off.')
  assert.equal(desktopAccountStatus({ guided: { registered: true, enabled: true, automaticAvailable: true } }), 'Ready for your phone.')
  assert.equal(desktopAccountStatus({ guided: { registered: true, enabled: true, phase: 'reconnecting' } }), 'Reconnecting to the phone service…')
})

test('email is display-only verified native metadata and disappears on unlink', () => {
  const account = { displayName: 'Creator', email: 'creator@example.test', emailVerified: true }
  const connected = value => ({ guided: { registered: true, account: value } })
  assert.equal(desktopAccountEmail(connected(account)), account.email)
  for (const value of [{ ...account, emailVerified: false }, { ...account, email: 'bad\n@example.test' }, { ...account, email: 'x\u202e@example.test' }, { ...account, email: '<script>@example.test' }, { displayName: 'creator@example.test' }]) assert.equal(desktopAccountEmail(connected(value)), '')
  assert.equal(desktopAccountEmail({ guided: { registered: false, account } }), '')
})

test('a running service is not sharing; actual private-link sharing is identified separately', () => {
  const guided = { registered: true, enabled: false }
  assert.equal(desktopAccountStatus({enabled:true,legacyEnabled:false,guided}), 'Signed in. Phone sharing is off.')
  assert.equal(desktopAccountStatus({enabled:true,legacyEnabled:true,guided}), 'Account phone sharing is off. Private-link phone sharing is on.')
})

test('Velo access distinguishes entitlement from offline/failure without trusting provider text', () => {
  const status = (available, status) => desktopVeeStatus({ success: true, provider: 'luna', available, status })
  assert.equal(status(true, 'eligible'), 'Available for this account')
  assert.equal(status(false, 'not-eligible'), 'Velo access has not been enabled for this account')
  assert.equal(status(false, 'exhausted'), 'Velo allowance used up — no automatic refills')
  assert.equal(status(false, 'unavailable'), 'Currently unavailable')
  assert.equal(desktopVeeStatus({ success: false, error: 'sensitive upstream response', status: 'not-eligible' }), 'Could not check availability')
  assert.equal(desktopVeeStatus({ success: true, provider: 'codex', available: true }), 'Could not check availability')
})
