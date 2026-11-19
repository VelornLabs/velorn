const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('gpuReadbackFixture', {
  report: result => ipcRenderer.send('gpu-readback-result', result),
  sandboxed: process.sandboxed === true,
})
