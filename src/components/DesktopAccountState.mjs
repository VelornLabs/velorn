// Renderer presentation only. Credentials and connection authority stay native.
// Prefer the application account controller; retain the conversation bridge for
// busy guards and older desktop runtimes that do not expose the new account API.
export function createDesktopAccountState() {
  let snapshot = { live: null, independent: null, openRequest: 0, preference: null, checking: true, error: '', hasProject: false }
  const listeners = new Set()
  const update = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    setProject(hasProject) { if (snapshot.hasProject !== hasProject) update({ hasProject }) },
    reading() { update({ preference: null, checking: true, error: '' }) },
    preference(value, error = '') { update({ preference: value, error, checking: false }) },
    publish(owner) { update({ live: owner }) },
    account(owner) { update({ independent: owner }) },
    open() { update({ openRequest: snapshot.openRequest + 1 }) },
    release(owner) { if (snapshot.live === owner) update({ live: null }) },
    current: () => snapshot.independent?.current || (snapshot.hasProject ? snapshot.live?.current || null : null),
  }
}

export function desktopAccountIdentity(connection) {
  const guided = connection?.guided
  const value = guided?.registered === true ? guided.account?.displayName : null
  const displayName = typeof value === 'string' && value.trim() && value.length <= 120 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
    ? value.trim() : ''
  return { displayName, initials: displayName ? displayName.split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase() : '' }
}

export function desktopAccountEmail(connection) {
  const account = connection?.guided?.registered === true ? connection.guided.account : null
  const email = account?.email
  return account?.emailVerified === true && typeof email === 'string' && email.length <= 254
    && /^[^\s<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+@[^\s<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+\.[^\s<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+$/u.test(email) ? email : ''
}

export function desktopVeeStatus(result) {
  if (result?.success !== true || result.provider !== 'luna') return 'Could not check availability'
  if (result.available === true && result.status === 'eligible') return 'Available for this account'
  if (result.available === false && result.status === 'not-eligible') return 'Velo access has not been enabled for this account'
  if (result.available === false && result.status === 'exhausted') return 'Velo allowance used up — no automatic refills'
  return 'Currently unavailable'
}

export function desktopAccountStatus(connection) {
  const guided = connection?.guided
  if (guided?.phase === 'sign-in') return 'Finish signing in in your browser.'
  if (guided?.phase === 'confirm-account') return 'Confirm your Velorn account in the desktop prompt.'
  if (guided?.phase === 'account-unavailable') return 'Reconnect your Velorn account.'
  if (!guided?.registered) return 'Sign in for Velo access and phone connections. Velo availability depends on your account.'
  if (!guided.enabled) return connection?.legacyEnabled === true
    ? 'Account phone sharing is off. Private-link phone sharing is on.'
    : 'Signed in. Phone sharing is off.'
  if (guided.phase === 'reconnecting') return 'Reconnecting to the phone service…'
  return guided.automaticAvailable ? 'Ready for your phone.' : 'Connecting to the phone service…'
}
