import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useVeloAllowance, VeloAllowance } from '../../src/components/VeloAllowance'
import '../../src/index.css'
let state, calls = 0, hold = false, waiting = [], response = { success: true, provider: 'luna', available: true, status: 'eligible', allowance: { remainingPercent: 97.3, pending: false, poolLimited: false } }
window.electronAPI = { connectedAgent: { veeAvailability: async () => {
  calls++; const value = structuredClone(response)
  if (hold) await new Promise(resolve => waiting.push(resolve))
  return value
} } }
window.allowanceFixture = { configure: options => state(previous => ({ ...previous, ...options })),
  result: value => { response = value }, calls: () => calls,
  hold: () => { hold = true }, release: () => { hold = false; waiting.splice(0).forEach(resolve => resolve()) } }
function Fixture() {
  const [options, setOptions] = useState({ accountKey: 'one', enabled: true, revision: 0 }); state = setOptions
  const allowance = useVeloAllowance(options)
  return <main style={{ width: 320, padding: 15, background: '#10171e' }}><VeloAllowance {...allowance} /></main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
