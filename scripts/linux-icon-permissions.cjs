const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Public application artwork must remain readable after installation as root.
// Do not change the process umask or permissions on any other build inputs.
function linuxIconFiles(projectRoot) {
  const directory = path.join(projectRoot, 'build', 'icons')
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Linux icons must be a real directory')
  const files = fs.readdirSync(directory).filter(name => /^\d+x\d+\.png$/.test(name)).sort()
  if (!files.length) throw new Error('No Linux PNG icons found')
  for (const name of files) {
    const stat = fs.lstatSync(path.join(directory, name))
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Linux icon must be a regular, unlinked file: ${name}`)
  }
  return { directory, files }
}

function prepareLinuxIcons(projectRoot, platform) {
  if (platform !== 'linux') return []
  const { directory, files } = linuxIconFiles(projectRoot)
  fs.chmodSync(directory, 0o755)
  for (const name of files) fs.chmodSync(path.join(directory, name), 0o644)
  return files
}

function verifyDebIconListing(listing, expectedFiles) {
  const found = []
  let launcher = false
  for (const line of listing.split('\n')) {
    const icon = line.match(/\s\.\/usr\/share\/icons\/hicolor\/(\d+x\d+)\/apps\/velorn\.png$/)
    const desktop = /\s\.\/usr\/share\/applications\/velorn\.desktop$/.test(line)
    if (!icon && !desktop) continue
    const mode = line.split(/\s+/)[0]
    if (mode[0] !== '-' || mode[1] !== 'r' || mode[4] !== 'r' || mode[7] !== 'r') {
      throw new Error(`Linux installer contains an unreadable icon/launcher: ${line.trim()}`)
    }
    if (icon) found.push(`${icon[1]}.png`)
    if (desktop) launcher = true
  }
  if (!launcher) throw new Error('Linux installer is missing the Velorn desktop launcher')
  if (!found.length || JSON.stringify(found.sort()) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error('Linux installer icon inventory does not match the prepared icons')
  }
  return found
}

function verifyDebIcons(file, expectedFiles) {
  const listing = execFileSync('dpkg-deb', ['--contents', file], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  })
  return verifyDebIconListing(listing, expectedFiles)
}

module.exports = { linuxIconFiles, prepareLinuxIcons, verifyDebIconListing, verifyDebIcons }
