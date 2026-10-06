'use strict';
// Exposes a small, explicit API to the renderer (contextIsolation + sandbox).

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const CHANNELS = [
  'settings:getAll', 'settings:set', 'settings:reset',
  'app:initialPaths', 'app:info', 'app:quit',
  'dialog:openFiles', 'dialog:openFile', 'dialog:openFolder', 'dialog:openPlaylist',
  'dialog:save', 'dialog:message',
  'fs:listFolder', 'fs:siblings', 'fs:expand', 'fs:exists', 'fs:isFile', 'fs:rename',
  'fs:trash', 'fs:copy', 'fs:writeBuffer', 'fs:readText', 'fs:writeText', 'fs:clearCache',
  'fs:uniquePath', 'path:info', 'image:info',
  'shell:showInFolder', 'shell:openPath',
  'clipboard:writeImage', 'clipboard:writeText', 'clipboard:read',
  'win:toggleFullscreen', 'win:setFullscreen', 'win:isFullscreen', 'win:setOnTop',
  'win:isOnTop', 'win:capture', 'win:setBackground', 'win:setOpacity', 'win:devtools', 'win:focus',
  'menu:popup',
  'faces:status', 'faces:download', 'faces:scan', 'faces:cancel', 'faces:groups', 'faces:saveGroups',
  'fs:mkdir', 'fs:subfolders', 'folders:load', 'folders:save',
  'library:dir', 'library:reveal', 'library:import', 'library:delete',
  'library:discard', 'library:restore', 'library:purge',
];

const api = {};
for (const ch of CHANNELS) {
  const [group, name] = ch.split(':');
  api[group] = api[group] || {};
  api[group][name] = invoke(ch);
}

api.on = (event, cb) => {
  const allowed = ['app:open-paths', 'app:close-requested', 'win:fullscreen', 'faces:progress', 'library:progress'];
  if (!allowed.includes(event)) throw new Error(`event not allowed: ${event}`);
  ipcRenderer.on(event, (_e, ...args) => cb(...args));
};
api.pathForFile = (file) => webUtils.getPathForFile(file);

contextBridge.exposeInMainWorld('gp', api);
