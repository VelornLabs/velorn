const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('exportSchedulerFixture', {
  ping: () => ipcRenderer.invoke('export-scheduler-ping'),
  report: result => ipcRenderer.send('export-scheduler-result', result),
  sandboxed: process.sandboxed === true,
  nativeEncode: process.argv.includes('--velorn-test-native-encode'),
  nativePipe: {
    startFramePipe: options => ipcRenderer.invoke('export-scheduler-native-start', options),
    writeFrameToPipe: (id, buffer) => ipcRenderer.invoke('export-scheduler-native-write', id, buffer),
    finishFramePipe: id => ipcRenderer.invoke('export-scheduler-native-finish', id),
    abortFramePipe: id => ipcRenderer.invoke('export-scheduler-native-abort', id),
  },
})
