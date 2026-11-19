const { linuxIconFiles, verifyDebIcons } = require('./linux-icon-permissions.cjs')

module.exports = async function artifactBuildCompleted(context) {
  if (!context.file?.endsWith('.deb')) return
  const { files } = linuxIconFiles(context.packager.projectDir)
  verifyDebIcons(context.file, files)
  console.log(`Verified Linux installer: ${files.length} readable Velorn icons and desktop launcher`)
}
