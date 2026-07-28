const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agentRGB', {
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  onSessionsUpdate: (cb) => {
    ipcRenderer.on('sessions-update', (_, sessions) => cb(sessions))
  },
  focusSession: (sessionId) => ipcRenderer.send('focus-session', sessionId),
  dismissSession: (sessionId) => ipcRenderer.send('dismiss-session', sessionId),
  playSystemSound: (kind) => ipcRenderer.send('play-system-sound', kind),
  resizeWindow: (height) => ipcRenderer.send('resize-window', height),
  reposition: (bounds) => ipcRenderer.send('reposition', bounds),
})
