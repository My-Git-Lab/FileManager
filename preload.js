const { contextBridge, ipcRenderer } = require('electron');

// 只暴露当前界面实际使用的接口，缩小渲染进程可调用面。
// 主进程保留的 v0.1 底层文件操作接口（如搜索、整理、批量重命名）暂未接入界面，
// 后续需要时在下方补回对应桥接即可，无需改动主进程。
contextBridge.exposeInMainWorld('api', {
  list: (dir) => ipcRenderer.invoke('fs:list', dir),
  trash: (paths) => ipcRenderer.invoke('fs:trash', { paths }),
  open: (p) => ipcRenderer.invoke('fs:open', p),
  showInFolder: (p) => ipcRenderer.invoke('fs:showInFolder', p),
  homeDirs: () => ipcRenderer.invoke('sys:homeDirs'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  detail: (p) => ipcRenderer.invoke('fs:detail', p),
  libScan: (root) => ipcRenderer.invoke('lib:scan', root),
  libList: () => ipcRenderer.invoke('lib:list'),
  libCreate: (parentPath, name) => ipcRenderer.invoke('lib:create', { parentPath, name }),
  libMigrate: (oldPath, newParent) => ipcRenderer.invoke('lib:migrate', { oldPath, newParent }),
  libRemove: (libPath) => ipcRenderer.invoke('lib:remove', libPath),
  libRelocate: (oldPath, newPath) => ipcRenderer.invoke('lib:relocate', { oldPath, newPath }),
  libRename: (kind, target, newName) => ipcRenderer.invoke('lib:rename', { kind, target, newName }),
  libMove: (target, destDir) => ipcRenderer.invoke('lib:move', { target, destDir }),
  libCreateCategory: (root, name) => ipcRenderer.invoke('lib:createCategory', { root, name }),
  libCreateGroup: (root, categoryName, groupName) =>
    ipcRenderer.invoke('lib:createGroup', { root, categoryName, groupName }),
  libAddFiles: (groupPath, files) => ipcRenderer.invoke('lib:addFiles', { groupPath, files }),
  libSetMeta: (root, rel, level, patch) =>
    ipcRenderer.invoke('lib:setMeta', { root, rel, level, patch }),
  libSetCover: (root, groupPath, cover) =>
    ipcRenderer.invoke('lib:setCover', { root, groupPath, cover }),
  libLocations: () => ipcRenderer.invoke('lib:locations'),
  libBatchAdd: (payload) => ipcRenderer.invoke('lib:batchAdd', payload)
});
