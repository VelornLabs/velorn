import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MobileCompanionSettings, MobileCompanionRequest } from '../../src/components/MobileCompanion'
import '../../src/components/ConnectedAgentPanel.css'

const calls = []
let control
window.guidedDesktopFixture = { calls, state: value => control(value) }
const devices = [{ id: 'phone-one', name: 'Fixture Android', connected: true }, { id: 'phone-two', name: 'Fixture iPhone', connected: false }]
function Fixture() {
  const [state, setState] = useState('new')
  const [name, setName] = useState('My computer')
  const [remaining, setRemaining] = useState(devices)
  const [sharePreview, setSharePreview] = useState(false)
  control = setState
  const registered = ['linked', 'disabled', 'waiting', 'manual', 'request', 'request-disabled', 'approval', 'paid-approval', 'request-error'].includes(state)
  const legacy = ['legacy-new', 'legacy-active', 'legacy-compat'].includes(state)
  const enabled = registered || state === 'legacy-active'
  const mobile = {
    available: state !== 'unavailable', guidedAvailable: state !== 'unavailable', enabled,
    ...(state !== 'legacy-compat' ? { legacyAvailable: legacy } : {}),
    computerName: name, setComputerName: setName, changing: state === 'pending', checkingAccount: false,
    nativeApprovals: state === 'approval' ? [{ approvalId: 'native-one', reviewToken: 'fixture-token', title: 'Allow phone full access?', detail: 'Synthetic full access request. Nothing is granted until you approve.', requiresRiskAcknowledgement: true }]
      : state === 'paid-approval' ? [{ approvalId: 'native-paid', reviewToken: 'fixture-paid-token', title: 'Approve generation spending?', detail: 'Synthetic paid generation. No charge occurs in this fixture.', allowLocalTrust: true }] : [],
    pending: ['request', 'request-disabled'].includes(state) ? { text: 'Synthetic phone message awaiting your decision.' } : null,
    notice: state === 'failure' ? 'Phone setup could not start.' : '',
    requestError: state === 'request-error' ? 'The phone approval expired. No action was approved.' : '',
    dismissRequestError() { calls.push({ method: 'dismiss-request-error' }); setState('linked') },
    connection: { enabled, legacyEnabled: legacy, paired: registered && state !== 'waiting',
      urls: legacy ? ['http://192.0.2.1:5212'] : [], pairingCode: legacy ? '123456' : null,
      guided: { registered, enabled: registered, automaticAccountAccess: registered && state !== 'manual', automaticAvailable: registered,
        available: state !== 'unavailable', computer: registered ? { id: 'computer', name } : null,
        devices: registered && state !== 'waiting' ? remaining : [], message: state === 'pending' ? 'Finish signing in in your browser.' : '' } },
    connectPhoneAccount() { calls.push({ method: 'connect', name }); setState('pending') },
    disconnectPhoneDevice(id) { calls.push({ method: 'disconnect', id }); setRemaining(items => items.filter(item => item.id !== id)) },
    disconnectPhoneAccount() { calls.push({ method: 'unregister' }); setState('new') },
    enable() { calls.push({ method: 'legacy-enable' }) }, disable() { calls.push({ method: 'stop' }) },
    forget() { calls.push({ method: 'forget-legacy' }) }, checkAccountRequests() { calls.push({ method: 'legacy-check' }) },
    refreshPreview() { calls.push({ method: 'refresh-preview' }); return Promise.resolve({ success: true }) },
    decide(approved) { calls.push({ method: 'decide', approved }); setState('linked') },
    decideNative(approval, approved, riskAcknowledged, trustLocal) {
      calls.push({ method: 'decide-native', id: approval.approvalId, approved, riskAcknowledged, trustLocal }); setState('linked')
      return Promise.resolve({ success: true })
    },
    sharePreview, setSharePreview(value) { calls.push({ method: 'preview', value }); setSharePreview(value) }, fullAccess: false,
  }
  return <main style={{ maxWidth: 620, margin: '16px auto', padding: 16, background: '#111722', color: '#dfe4ee', fontFamily: 'sans-serif' }}>
    <div data-testid="phone-settings"><MobileCompanionSettings mobile={mobile} disabled={state === 'disabled'} /></div>
    <div data-testid="phone-chat"><MobileCompanionRequest mobile={mobile} disabled={['disabled', 'request-disabled'].includes(state)} /></div>
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
