const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: (dir) => ipcRenderer.invoke('fs:list', dir),
  search: (dirPath, opts) => ipcRenderer.invoke('fs:search', { dirPath, opts }),
  mkdir: (parent, name) => ipcRenderer.invoke('fs:mkdir', { parent, name }),
  rename: (oldPath, newName) => ipcRenderer.invoke('fs:rename', { oldPath, newName }),
  transfer: (mode, sources, destDir) => ipcRenderer.invoke('fs:transfer', { mode, sources, destDir }),
  trash: (paths) => ipcRenderer.invoke('fs:trash', { paths }),
  organize: (dirPath) => ipcRenderer.invoke('fs:organize', dirPath),
  batchRename: (dirPath, names, pattern, startNum, padding) =>
    ipcRenderer.invoke('fs:batchRename', { dirPath, names, pattern, startNum, padding }),
  open: (p) => ipcRenderer.invoke('fs:open', p),
  showInFolder: (p) => ipcRenderer.invoke('fs:showInFolder', p),
  homeDirs: () => ipcRenderer.invoke('sys:homeDirs'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  detail: (p) => ipcRenderer.invoke('fs:detail', p),
  appVersion: () => ipcRenderer.invoke('app:version'),
  libScan: (root) => ipcRenderer.invoke('lib:scan', root),
  libList: () => ipcRenderer.invoke('lib:list'),
  libCreate: (parentPath, name) => ipcRenderer.invoke('lib:create', { parentPath, name }),
  libMigrate: (oldPath, newParent) => ipcRenderer.invoke('lib:migrate', { oldPath, newParent }),
  libRemove: (libPath) => ipcRenderer.invoke('lib:remove', libPath),
  libRelocate: (oldPath, newPath) => ipcRenderer.invoke('lib:relocate', { oldPath, newPath }),
  libRename: (kind, target, newName) => ipcRenderer.invoke('lib:rename', { kind, target, newName }),
  libMove: (target, destDir) => ipcRenderer.invoke('lib:move', { target, destDir }),
  libCreateGroup: (root, categoryName, groupName) =>
    ipcRenderer.invoke('lib:createGroup', { root, categoryName, groupName }),
  libAddFiles: (groupPath, files) => ipcRenderer.invoke('lib:addFiles', { groupPath, files }),
  libSetTags: (root, groupPath, tags) =>
    ipcRenderer.invoke('lib:setTags', { root, groupPath, tags }),
  libSetCover: (root, groupPath, cover) =>
    ipcRenderer.invoke('lib:setCover', { root, groupPath, cover })
});
