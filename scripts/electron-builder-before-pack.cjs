const { normalizeArch, normalizePlatform } = require('../electron/rifeRuntime')
const { verifyStagedReleaseInputs } = require('./runtime-package-gate.cjs')
const { prepareLinuxIcons } = require('./linux-icon-permissions.cjs')

module.exports = async function beforePack(context) {
  const platform = normalizePlatform(context.electronPlatformName)
  const arch = normalizeArch(context.arch)
  prepareLinuxIcons(context.packager.projectDir, platform)
  verifyStagedReleaseInputs({
    projectRoot: context.packager.projectDir,
    platform,
    arch,
  })
}
