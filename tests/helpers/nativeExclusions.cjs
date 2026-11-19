// The packaged-app tests refuse any electron/ file being left out of the package,
// so that a new exclusion is always reviewed. Three owner-test harness files are
// left out on purpose and have been reviewed: packaged code never imports them
// (only veloEngineCandidate.cjs requires the other two), and
// scripts/check-native-linux-preview.cjs asserts they are absent.
const REVIEWED = Object.freeze([
  '!electron/veloEngineCandidate.cjs',
  '!electron/veloCandidateGatewayClient.cjs',
  '!electron/veloOwnerTestGateway.cjs',
])
// true when every "!electron/..." pattern in build.files is one of the reviewed three
const onlyReviewedNativeExclusions = files => files.filter(pattern => pattern.startsWith('!electron/')).every(pattern => REVIEWED.includes(pattern))
module.exports = { REVIEWED, onlyReviewedNativeExclusions }
