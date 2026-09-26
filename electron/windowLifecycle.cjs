'use strict'

function clearTrackedWindowIfCurrent(currentWindow, closedWindow) {
  return currentWindow === closedWindow ? null : currentWindow
}

module.exports = {
  clearTrackedWindowIfCurrent,
}
