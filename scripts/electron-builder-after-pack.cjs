const { normalizeArch, normalizePlatform } = require('../electron/rifeRuntime')
const {
  packagedResourcesPath,
  verifyPackagedResources,
} = require('./runtime-package-gate.cjs')
const { findVcRuntimeSource, stageVcRuntime, verifyVcRuntime } = require('./windows-vc-runtime.cjs')

module.exports = async function afterPack(context) {
  const platform = normalizePlatform(context.electronPlatformName)
  const arch = normalizeArch(context.arch)
  // The song engine needs Microsoft's Visual C++ runtime, which a fresh Windows
  // PC does not have. Carry it beside the engine, and refuse to build without it.
  if (platform === 'win32' && arch === 'x64') {
    const resourcesPath = packagedResourcesPath(context)
    stageVcRuntime({ resourcesPath, sourceDir: findVcRuntimeSource() })
    verifyVcRuntime({ resourcesPath })
  }
  verifyPackagedResources({
    resourcesPath: packagedResourcesPath(context),
    platform,
    arch,
    // Windows signs extra-resource executables while copying them, before this
    // hook, but signs Velorn.exe afterward. macOS signs the completed app after
    // this hook. Retry changed native helpers only under valid Authenticode;
    // the final release gate later requires the helpers to match Velorn's signer.
    allowSignedPackageFallback: platform === 'win32',
  })
}
