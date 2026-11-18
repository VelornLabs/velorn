'use strict'

const { VELO_CONSENT } = require('./connectedAgentAccessPreference.cjs')

const SUMMARY = 'The agent can run commands and change files. Mistakes can cause data loss or unexpected costs.'
const BUNDLE = 'Includes image sharing and the current Velorn view. Generation spending settings stay separate.'
const LOCAL_SUMMARY = 'The agent can change your project and use Velorn tools automatically. Mistakes can cause data loss.'
const VELO_SUMMARY = 'Velo can run commands, change files and use network services without asking each time. Mistakes may cause data loss or costs.\n\nShared context, images, file content and command output go through Velorn to OpenAI.'
const DETAILS = [
  'Full computer access uses Codex to run commands, read, change or delete accessible files, install software and use network services. It uses your current operating-system permissions, not administrator/root privileges.',
  'Velorn tools run automatically without mandatory previews, checkpoints or repeated approvals. Editor validation and Undo remain where supported; direct file changes are not guaranteed to be undoable. Stop interrupts the response but does not reverse completed actions or necessarily cancel external jobs.',
  'Velorn-managed generation still follows your separate spending settings. Direct commands, ComfyUI requests and network services can bypass those gates and may spend money. Full access is not a global spending cap or a guarantee of local-only processing.',
  'Share images and Include current view are included. Selected project images and supported view snapshots can be sent to Codex on Send, and inspection tools can return review stills. This is not continuous screen streaming. Advanced permissions can turn automatic images off, but full access can still read files independently. Phone sharing and pairing remain separate.',
  'Remember on this desktop is optional. It lets Velorn restore access for your chats and projects on this installation after restarting, without repeating this prompt. Turning Full access off clears the remembered choice. A changed permission scope requires confirmation again. Each live grant is still checked against the current window, project and chat.',
  'LM Studio uses model-supported Velorn tools; this setting does not give it Codex computer-command access. Browser control, external accounts and plugins are not automatically included.',
].join('\n\n')
const LOCAL_DETAILS = [
  'LM Studio can use all available Velorn tools automatically, without mandatory previews, checkpoints or repeated approvals. Normal editor Undo remains available. File deletion and external operations may not be undoable. Stop interrupts the response but does not reverse completed work.',
  'This grants Velorn tool access, not arbitrary computer commands. Generation spending settings and phone pairing remain separate. Review images are shared with the app; only a vision-enabled model receives image attachments.',
  'Remember on this desktop restores this choice for LM Studio after restarting. Turning Full access off clears this saved choice. Choosing Codex or Velo computer access requires its own confirmation.',
].join('\n\n')
const VELO_DETAILS = [
  'Velo can run local shell commands, read, change or delete accessible files, install software and use network services. It runs with your normal operating-system user permissions, not administrator/root privileges. No Codex installation or Codex sign-in is required.',
  'Velorn tools and computer commands run automatically, without mandatory previews, checkpoints or repeated approvals. Normal editor Undo remains available where supported; direct file changes and external operations may not be undoable. Stop interrupts the response but does not reverse completed work or necessarily cancel external jobs.',
  'Shared project context, selected images, supported current-view snapshots, file content and command output go through the Velorn service to OpenAI. Enabling full access includes Share images and Include current view. This is not continuous screen streaming. Image-sharing controls affect automatic attachments and Velorn tool images; full computer access can still read files independently. Avoid storing secrets in files the agent can access.',
  'Your Velo inference allowance still applies. Enabling full access does not add or refill an allowance. Velorn-managed image, video and audio generation follows your separate generation spending settings. Direct commands and third-party network services can bypass those gates and may spend money outside that allowance. Full access is not a global spending cap.',
  'Remember on this desktop restores this Velo computer-access choice after restarting. Choosing Chat only or Work in Velorn, or turning Full access off, clears this saved choice. The earlier Velorn-tools-only approval is not sufficient: this larger scope requires fresh confirmation. Each live grant is still checked against the current window, project and chat. Phone sharing and pairing remain separate.',
].join('\n\n')
const denied = () => ({ approved: false, shareImagesAndView: false, remember: false })

async function confirmDesktopFullAccess({ window, dialog, isCurrent = () => true, remembered = false, provider = 'codex' }) {
  const current = () => {
    try { return isCurrent() === true && window && !window.isDestroyed() && !window.webContents.isDestroyed() }
    catch { return false }
  }
  let remember = true
  while (current()) {
    const result = await dialog.showMessageBox(window, {
      type: 'question', title: 'Full access', message: provider === 'codex' || provider === 'luna' ? 'Allow full computer access?' : 'Allow full access to Velorn tools?',
      detail: provider === 'luna' ? VELO_SUMMARY : `${provider !== 'codex' ? LOCAL_SUMMARY : SUMMARY}\n\n${BUNDLE}`,
      buttons: ['Cancel', 'Enable full access', 'Learn more'], defaultId: 0, cancelId: 0, noLink: true,
      checkboxLabel: 'Remember on this desktop', checkboxChecked: remember,
    })
    if (!current()) return denied()
    remember = result?.checkboxChecked === true
    if (result?.response === 1) return { approved: true, shareImagesAndView: true, remember,
      ...(provider === 'luna' ? { scope: VELO_CONSENT.scope, version: VELO_CONSENT.version } : {}) }
    if (result?.response !== 2) return denied()
    await dialog.showMessageBox(window, { type: 'info', title: 'Full access',
      message: 'About full access', detail: provider === 'luna' ? VELO_DETAILS : provider !== 'codex' ? LOCAL_DETAILS : DETAILS, buttons: ['Back'], defaultId: 0, cancelId: 0, noLink: true })
  }
  return denied()
}

module.exports = { confirmDesktopFullAccess, SUMMARY, LOCAL_SUMMARY, VELO_SUMMARY, BUNDLE, DETAILS, LOCAL_DETAILS, VELO_DETAILS }
