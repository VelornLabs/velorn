const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  setViewerPresentation: request => ipcRenderer.invoke('viewer:setPresentation', request),
  getViewerPresentation: () => ipcRenderer.invoke('viewer:getPresentation'),
  onViewerPresentationChanged: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('viewer:presentationChanged', listener)
    return () => ipcRenderer.removeListener('viewer:presentationChanged', listener)
  },
})
contextBridge.exposeInMainWorld('viewerPresentationNative', {
  command: request => ipcRenderer.invoke('viewer-fixture:command', request),
  sandboxed: process.sandboxed === true,
})
