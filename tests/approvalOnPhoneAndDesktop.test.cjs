const test = require('node:test')
const assert = require('node:assert/strict')
const { approvalOnPhoneAndDesktop } = require('../electron/approvalOnPhoneAndDesktop.cjs')

// A prompt that answers when `answer()` is called, or "no" when it is closed.
function prompt(no) {
  let settle, closed = false
  const promise = new Promise(resolve => { settle = resolve })
  return { ask: signal => { signal.addEventListener('abort', () => { closed = true; settle(no) }, { once: true }); return promise },
    answer: value => settle(value), wasClosed: () => closed }
}

test('with no paired phone only the computer is asked', async () => {
  const desktop = prompt(false)
  const pending = approvalOnPhoneAndDesktop({ askPhone: () => null, askDesktop: desktop.ask })
  desktop.answer(true)
  assert.deepEqual(await pending, { from: 'desktop', answer: true })
})

test('a phone that never answers no longer blocks: the computer can approve', async () => {
  const phone = prompt({ approved: false }), desktop = prompt(false)
  const pending = approvalOnPhoneAndDesktop({ askPhone: phone.ask, askDesktop: desktop.ask })
  desktop.answer(true)
  assert.deepEqual(await pending, { from: 'desktop', answer: true })
  assert.equal(phone.wasClosed(), true)
})

test('an answer on the phone closes the prompt on the computer', async () => {
  const phone = prompt({ approved: false }), desktop = prompt(false)
  const pending = approvalOnPhoneAndDesktop({ askPhone: phone.ask, askDesktop: desktop.ask })
  phone.answer({ approved: true })
  assert.deepEqual(await pending, { from: 'phone', answer: { approved: true } })
  assert.equal(desktop.wasClosed(), true)
})

test('a no from either place is a no, and closes the other', async () => {
  const phone = prompt({ approved: false }), desktop = prompt(false)
  const pending = approvalOnPhoneAndDesktop({ askPhone: phone.ask, askDesktop: desktop.ask })
  desktop.answer(false)
  assert.deepEqual(await pending, { from: 'desktop', answer: false })
  assert.equal(phone.wasClosed(), true)
})

test('cancelling the request closes both prompts', async () => {
  const phone = prompt({ approved: false }), desktop = prompt(false)
  const controller = new AbortController()
  const pending = approvalOnPhoneAndDesktop({ askPhone: phone.ask, askDesktop: desktop.ask, signal: controller.signal })
  controller.abort()
  const result = await pending
  assert.equal(result.answer === false || result.answer?.approved === false, true)
  assert.equal(phone.wasClosed() && desktop.wasClosed(), true)
})
