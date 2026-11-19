'use strict'

const path = require('node:path')

// The installer contains native phone transport only. The separately maintained
// phone UI is served by connect.velorn.ai, never copied into the desktop bundle.
// Credentials are created after native consent in this installation's userData;
// neither a developer's registration nor a shared relay secret is shipped.
function desktopPhoneRuntime({ isPackaged, userData, electronRoot }) {
  if (typeof isPackaged !== 'boolean' || typeof userData !== 'string' || !path.isAbsolute(userData)
    || typeof electronRoot !== 'string' || !path.isAbsolute(electronRoot)) {
    throw new Error('Valid desktop phone runtime paths are required.')
  }
  return {
    apiOnly: isPackaged,
    clientRoot: isPackaged ? null : path.resolve(electronRoot, '../../velorn-mobile-lab/dist'),
    deviceStorePath: path.join(userData, 'mobile-companion-device.json'),
    preferencePath: path.join(userData, 'mobile-companion-preference.json'),
    guided: {
      configPath: isPackaged ? null : path.join(userData, 'remote-companion.json'),
      statePath: path.join(userData, 'phone-account.json'),
      devicesRoot: path.join(userData, 'phone-account-devices'),
    },
  }
}

module.exports = { desktopPhoneRuntime }
