'use strict';
// Bridge for the hidden face-recognition worker window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('faceBridge', {
  onJob: (cb) => ipcRenderer.on('face:job', (_e, job) => cb(job)),
  onCancel: (cb) => ipcRenderer.on('face:cancel', (_e, jobId) => cb(jobId)),
  send: (msg) => ipcRenderer.send('face:worker-msg', msg),
});
