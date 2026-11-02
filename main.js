const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fss = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ================= 中文输入法（IME）支持 =================
// 背景（本机实测）：
//   这台机器是 Wayland 会话（ukui-wayland），装的是 fcitx4 + 搜狗，属于 X11 时代的输入法。
//   fcitx 的 XIM 服务只注册在 X11 通道上（可用 xprop -root XIM_SERVERS 看到 @server=fcitx），
//   它不支持 Wayland 的 text-input 协议，所以服务不了「原生 Wayland 客户端」。
//   Electron/Chromium 默认会跟着会话跑成原生 Wayland 客户端（ozone-platform=wayland），
//   于是输入法连不上 —— 表现就是敲拼音时连候选框都不弹。
// 修法：
//   检测到 Wayland 会话且存在 X11 通道（DISPLAY，通常由 Xwayland 提供）时，
//   强制 Electron 走 X11 平台，让它通过 XIM 接上系统输入法。
//   （别的程序之所以能打中文，正是因为它们走的是 X11/Xwayland 通道）
// 开关：
//   万一某台机器上没有 Xwayland、或有别的兼容性问题，可用环境变量回到 Wayland：
//     FM_OZONE=wayland  → 不强制 X11
//     FM_OZONE=x11      → 强制 X11（不管会话类型）
function applyImePlatform() {
  if (process.platform !== 'linux') {
    // Windows / macOS 上 Electron 原生就能接到系统输入法，不需要切换显示通道
    console.log('[IME] 平台=' + process.platform + '，使用系统输入法（无需额外设置）');
    return;
  }
  try {
    const forced = (process.env.FM_OZONE || '').trim().toLowerCase();
    const isWaylandSession = (process.env.XDG_SESSION_TYPE || '') === 'wayland'
      || (process.env.WAYLAND_DISPLAY || '') !== '';
    let useX11;
    if (forced === 'x11') useX11 = true;
    else if (forced === 'wayland') useX11 = false;
    else useX11 = isWaylandSession && !!process.env.DISPLAY;

    if (useX11) {
      app.commandLine.appendSwitch('ozone-platform', 'x11');
      // XIM 相关环境变量：本机桌面已经设好了，这里兜底，防止从 .desktop 启动时缺少
      process.env.XMODIFIERS = process.env.XMODIFIERS || '@im=fcitx';
      process.env.GTK_IM_MODULE = process.env.GTK_IM_MODULE || 'fcitx';
      process.env.QT_IM_MODULE = process.env.QT_IM_MODULE || 'fcitx';
    }
    console.log('[IME] 会话=' + (isWaylandSession ? 'wayland' : 'x11') +
      '，X11 通道=' + (process.env.DISPLAY ? '有' : '无') +
      '，本次使用=' + (useX11 ? 'x11(接 XIM 输入法)' : 'wayland') +
      (forced ? '（由 FM_OZONE 指定）' : ''));
  } catch (e) {
    console.log('[IME] 平台设置失败：' + e.message);
  }
}
applyImePlatform();

// ---------- 文件分类（用于一键归类） ----------
const CATEGORIES = {
  '图片': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'tiff', 'ico'],
  '文档': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'wps', 'et', 'dps'],
  '视频': ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'],
  '音频': ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'],
  '压缩包': ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  '程序与代码': ['exe', 'deb', 'rpm', 'apk', 'AppImage', 'js', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'html', 'css', 'json', 'xml', 'sh', 'sql']
};
function categorize(ext) {
  const e = (ext || '').toLowerCase().replace(/^\./, '');
  for (const [cat, exts] of Object.entries(CATEGORIES)) {
    if (exts.includes(e)) return cat;
  }
  return '其他';
}

// ---------- 安全限制：允许访问的根目录 ----------
// 注意：原实现硬编码了 Linux 路径（/media、/mnt…），在 Windows 上这些条目全部失效，
// 实际只剩 os.homedir() 生效 —— 结果是整个 D 盘都被判成"无权访问"。
// 这里改成按平台生成根目录。
function buildAllowedRoots() {
  const roots = [os.homedir()];
  if (process.platform === 'win32') {
    // Windows：放行本机实际存在的盘符根目录（从 C 开始，跳过 A/B 软驱）
    for (let code = 67; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      try { if (fss.existsSync(drive)) roots.push(drive); } catch {}
    }
  } else {
    // Linux / macOS：用户目录 + 常见挂载点与数据盘
    roots.push('/media', '/run/media', '/mnt', '/home', '/tmp', '/opt', '/srv', '/data');
  }
  return roots;
}
const ALLOWED_ROOTS = buildAllowedRoots();
console.log('[安全] 允许访问的根目录：' + ALLOWED_ROOTS.join(' , '));

function isAllowed(p) {
  let resolved;
  try { resolved = path.resolve(p); } catch { return false; }
  if (!resolved) return false;
  return ALLOWED_ROOTS.some(r => {
    const root = path.resolve(r);
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved === root || resolved.startsWith(withSep);
  });
}

// ---------- 名称合法性校验（Windows 文件名限制比 Linux 严得多） ----------
// Windows 不允许：\ / : * ? " < > | 和控制字符；不能以空格或英文句点结尾；
// 也不能使用保留设备名（CON、PRN、AUX、NUL、COM1~9、LPT1~9）。
// Linux 上这些名字都合法，所以这份代码在 Linux 开发时不会暴露问题。
const ILLEGAL_NAME_RE = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => 'COM' + (i + 1)),
  ...Array.from({ length: 9 }, (_, i) => 'LPT' + (i + 1))
]);
function nameError(name) {
  const n = String(name == null ? '' : name);
  if (!n.trim()) return '名称不能为空';
  if (ILLEGAL_NAME_RE.test(n)) return '名称不能包含 \\ / : * ? " < > | 这些字符';
  if (n.endsWith('.') || n.endsWith(' ')) return '名称不能以空格或英文句点结尾';
  if (RESERVED_NAMES.has(n.split('.')[0].toUpperCase()))
    return `"${n.split('.')[0].toUpperCase()}" 是 Windows 保留名，不能用作文件/文件夹名`;
  return null;
}
// NTFS 不区分大小写：判断是否"同名"时，Windows 上要忽略大小写
function isSamePath(a, b) {
  const x = String(a), y = String(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function statEntry(fullPath, name) {
  try {
    const st = await fs.stat(fullPath);
    return {
      name,
      path: fullPath,
      isDir: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
      ext: st.isDirectory() ? '' : path.extname(name),
      category: st.isDirectory() ? '文件夹' : categorize(path.extname(name))
    };
  } catch {
    return null;
  }
}

// ---------- IPC: 浏览目录 ----------
ipcMain.handle('fs:list', async (e, dirPath) => {
  if (!isAllowed(dirPath)) return { error: '无权访问该目录' };
  try {
    const names = await fs.readdir(dirPath);
    const entries = await Promise.all(
      names.filter(n => !n.startsWith('.')).map(n => statEntry(path.join(dirPath, n), n))
    );
    const list = entries.filter(Boolean);
    // 文件夹在前，各自按名称排序
    list.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
    return { entries: list };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- IPC: 递归搜索 ----------
async function walkSearch(dir, opts, results, depth, maxDepth) {
  if (results.length >= opts.maxResults) return;
  if (depth > maxDepth) return;
  let names;
  try { names = await fs.readdir(dir); } catch { return; }
  for (const name of names) {
    if (results.length >= opts.maxResults) return;
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const entry = await statEntry(full, name);
    if (!entry) continue;
    if (opts.type === 'file' && entry.isDir) { /* 继续深入 */ }
    else if (matchEntry(entry, opts)) results.push(entry);
    if (entry.isDir) await walkSearch(full, opts, results, depth + 1, maxDepth);
  }
}
function matchEntry(entry, opts) {
  if (opts.type === 'file' && entry.isDir) return false;
  if (opts.type === 'dir' && !entry.isDir) return false;
  if (opts.type === 'image' && entry.isDir) return false;
  if (opts.type === 'image' && entry.category !== '图片') return false;
  if (opts.type === 'doc' && entry.isDir) return false;
  if (opts.type === 'doc' && entry.category !== '文档') return false;
  if (opts.type === 'video' && entry.isDir) return false;
  if (opts.type === 'video' && entry.category !== '视频') return false;
  if (opts.type === 'audio' && (entry.isDir || entry.category !== '音频')) return false;
  if (opts.type === 'archive' && (entry.isDir || entry.category !== '压缩包')) return false;
  if (opts.minSize != null && entry.size < opts.minSize) return false;
  if (opts.maxSize != null && entry.size > opts.maxSize) return false;
  if (opts.modifiedAfter != null && entry.mtime < opts.modifiedAfter) return false;
  if (opts.modifiedBefore != null && entry.mtime > opts.modifiedBefore) return false;
  if (opts.keyword) {
    if (!entry.name.toLowerCase().includes(opts.keyword.toLowerCase())) return false;
  }
  return true;
}
ipcMain.handle('fs:search', async (e, { dirPath, opts }) => {
  if (!isAllowed(dirPath)) return { error: '无权访问该目录' };
  const results = [];
  try {
    await walkSearch(dirPath, { maxResults: 1000, ...opts }, results, 0, opts.maxDepth || 6);
    return { entries: results };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- IPC: 新建文件夹 ----------
ipcMain.handle('fs:mkdir', async (e, { parent, name }) => {
  if (!isAllowed(parent)) return { error: '无权访问该目录' };
  const bad = nameError(name);
  if (bad) return { error: bad };
  try {
    const target = path.join(parent, name);
    if (fss.existsSync(target)) return { error: '同名文件夹已存在' };
    await fs.mkdir(target);
    return { ok: true, path: target };
  } catch (err) { return { error: err.message }; }
});

// ---------- IPC: 重命名 ----------
ipcMain.handle('fs:rename', async (e, { oldPath, newName }) => {
  if (!isAllowed(oldPath)) return { error: '无权访问该路径' };
  const bad = nameError(newName);
  if (bad) return { error: bad };
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    // 只改大小写（a.txt -> A.txt）在 Windows 上是允许的，不能拦
    if (fss.existsSync(newPath) && !isSamePath(newPath, oldPath)) return { error: '目标名称已存在' };
    await fs.rename(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (err) { return { error: err.message }; }
});

// ---------- IPC: 复制 / 移动 ----------
ipcMain.handle('fs:transfer', async (e, { mode, sources, destDir }) => {
  const results = { done: [], failed: [] };
  if (!isAllowed(destDir)) return { error: '无权访问目标目录' };
  for (const src of sources) {
    const dest = path.join(destDir, path.basename(src));
    try {
      if (!isAllowed(src)) { results.failed.push({ src, reason: '无权访问该路径' }); continue; }
      if (isSamePath(path.dirname(src), destDir) && mode === 'move') { results.failed.push({ src, reason: '已在目标目录' }); continue; }
      if (mode === 'copy') await copyDeep(src, dest);
      else {
        try {
          await fs.rename(src, dest);
        } catch (err) {
          // 跨磁盘/跨分区移动（Windows 上 D: <-> C: 很常见）rename 会报 EXDEV
          if (err.code !== 'EXDEV') throw err;
          await copyDeep(src, dest);
          await fs.rm(src, { recursive: true, force: true });
        }
      }
      results.done.push(src);
    } catch (err) {
      results.failed.push({ src, reason: err.message });
    }
  }
  return results;
});
async function copyDeep(src, dest) {
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const n of await fs.readdir(src)) await copyDeep(path.join(src, n), path.join(dest, n));
  } else {
    await fs.copyFile(src, dest);
  }
}

// ---------- IPC: 删除（移入系统回收站，不直接销毁） ----------
ipcMain.handle('fs:trash', async (e, { paths }) => {
  const failed = [];
  for (const p of paths) {
    try {
      if (!isAllowed(p)) { failed.push({ path: p, reason: '无权访问该路径' }); continue; }
      await trashPath(p);
    } catch (err) {
      failed.push({ path: p, reason: err.message });
    }
  }
  return { failed };
});
// 最后兜底：移动到用户目录下的备份区，保证删除不会静默失败
function moveToBackup(p) {
  const backup = path.join(os.homedir(), '.Trash-filemanager');
  fss.mkdirSync(backup, { recursive: true });
  const dest = path.join(backup, `${Date.now()}_${path.basename(p)}`);
  fss.renameSync(p, dest);
}
function trashPath(p) {
  // 跨平台：优先用 Electron 自带的回收站接口（Windows 进回收站，Linux 走 gio）
  if (typeof shell.trashItem === 'function') {
    return shell.trashItem(p).catch(() => {
      try { moveToBackup(p); } catch (e) { throw new Error('移入回收站失败：' + e.message); }
    });
  }
  // 老版本 Electron 没有该接口时，Linux 上退回 gio
  return new Promise((resolve, reject) => {
    execFile('gio', ['trash', p], (err) => {
      if (!err) return resolve();
      try { moveToBackup(p); } catch (e) { return reject(new Error('移入回收站失败：' + e.message)); }
      resolve();
    });
  });
}

// ---------- IPC: 一键归类 ----------
ipcMain.handle('fs:organize', async (e, { dirPath }) => {
  if (!isAllowed(dirPath)) return { error: '无权访问该目录' };
  const summary = {};
  let names;
  try { names = await fs.readdir(dirPath); } catch (err) { return { error: err.message }; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dirPath, name);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (st.isDirectory()) continue; // 只归类文件，不动文件夹
    const cat = categorize(path.extname(name));
    // 未识别类型的文件不自动建"其他"目录，保持原地不动
    if (!CATEGORIESHas(cat)) continue;
    const catDir = path.join(dirPath, cat);
    await fs.mkdir(catDir, { recursive: true });
    let dest = path.join(catDir, name);
    let i = 1;
    while (fss.existsSync(dest)) {
      const ext = path.extname(name);
      dest = path.join(catDir, `${path.basename(name, ext)}_${i}${ext}`);
      i++;
    }
    try {
      await fs.rename(full, dest);
      summary[cat] = (summary[cat] || 0) + 1;
    } catch { /* 跳过失败项 */ }
  }
  return { summary };
});
function CATEGORIESHas(cat) { return Object.keys(CATEGORIES).includes(cat); }

// ---------- IPC: 批量重命名 ----------
ipcMain.handle('fs:batchRename', async (e, { dirPath, names, pattern, startNum, padding }) => {
  const results = { done: 0, failed: [] };
  if (!isAllowed(dirPath)) return { error: '无权访问该目录' };
  let n = startNum || 1;
  for (const name of names) {
    const ext = path.extname(name);
    const newName = `${pattern}${String(n).padStart(padding || 3, '0')}${ext}`;
    try {
      const bad = nameError(newName);
      if (bad) throw new Error(bad);
      const oldPath = path.join(dirPath, name);
      const newPath = path.join(dirPath, newName);
      if (fss.existsSync(newPath) && !isSamePath(newPath, oldPath)) throw new Error('目标名已存在');
      await fs.rename(oldPath, newPath);
      results.done++;
      n++;
    } catch (err) {
      results.failed.push({ name, reason: err.message });
    }
  }
  return results;
});

// ---------- IPC: 打开文件 / 在文件管理器中显示 ----------
ipcMain.handle('fs:open', async (e, p) => {
  if (!isAllowed(p)) return { error: '无权访问该路径' };
  const r = await shell.openPath(p);
  return r ? { error: r } : { ok: true };
});
ipcMain.handle('fs:showInFolder', (e, p) => {
  if (!isAllowed(p)) return { error: '无权访问该路径' };
  shell.showItemInFolder(p); return { ok: true };
});

// ---------- IPC: 系统目录 ----------
// 用 app.getPath() 而不是 homedir 拼英文目录名：
// Windows 上这些目录可能被重定向（如 OneDrive 接管"文档"），拼出来的路径会不存在。
ipcMain.handle('sys:homeDirs', () => {
  const gp = (n) => { try { return app.getPath(n); } catch { return null; } };
  return {
    home: os.homedir(),
    appDir: app.getAppPath(),
    desktop: gp('desktop'),
    documents: gp('documents'),
    downloads: gp('downloads'),
    pictures: gp('pictures'),
    music: gp('music'),
    videos: gp('videos')
  };
});

// ---------- IPC: 选择目录 / 多选文件 ----------
// 绑定父窗口保证模态正确；异常时返回 null/[]，由渲染进程的内置选择器兜底
ipcMain.handle('dialog:pickFolder', async (e) => {
  try {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: '选择文件夹',
      properties: ['openDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  } catch { return null; }
});

ipcMain.handle('dialog:pickFiles', async (e) => {
  try {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: '选择文件（可多选）',
      properties: ['openFile', 'multiSelections']
    });
    return r.canceled ? [] : r.filePaths;
  } catch { return []; }
});

// ---------- IPC: 应用版本 ----------
ipcMain.handle('app:version', () => app.getVersion());

// ---------- IPC: 读取文本文件（预览用，限 2MB，二进制拒绝） ----------
ipcMain.handle('fs:readText', async (e, filePath) => {
  if (!isAllowed(filePath)) return { error: '无权访问该文件' };
  try {
    const st = await fs.stat(filePath);
    if (st.size > 2 * 1024 * 1024) return { tooLarge: true, size: st.size };
    const buf = await fs.readFile(filePath);
    if (buf.includes(0)) return { binary: true };
    return { content: buf.toString('utf-8') };
  } catch (err) { return { error: err.message }; }
});

// ---------- IPC: 文件详情（所有者/组/权限/三种时间） ----------
function parsePasswd() {
  try {
    const lines = fss.readFileSync('/etc/passwd', 'utf-8').split('\n');
    const map = {};
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) map[parseInt(parts[2])] = parts[0];
    }
    return map;
  } catch { return {}; }
}
function parseGroup() {
  try {
    const lines = fss.readFileSync('/etc/group', 'utf-8').split('\n');
    const map = {};
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) map[parseInt(parts[2])] = parts[0];
    }
    return map;
  } catch { return {}; }
}
ipcMain.handle('fs:detail', async (e, p) => {
  if (!isAllowed(p)) return { error: '无权访问' };
  try {
    const st = await fs.stat(p);
    const isDir = st.isDirectory();
    return {
      isDir,
      size: st.size,
      birthtime: st.birthtimeMs,
      mtime: st.mtimeMs,
      atime: st.atimeMs,
      owner: parsePasswd()[st.uid] || String(st.uid),
      group: parseGroup()[st.gid] || String(st.gid),
      mode: (st.mode & parseInt('777', 8)).toString(8),
      ext: isDir ? '' : path.extname(p),
      category: isDir ? '文件夹' : categorize(path.extname(p)),
      name: path.basename(p),
      path: p
    };
  } catch (err) { return { error: err.message }; }
});

// ---------- IPC: 多选文件对话框（添加文件用） ----------
// （已合并到上方 dialog:pickFolder / dialog:pickFiles）

// ---------- 文件文库（多文库管理：文库 → 大类 → 组 → 文件） ----------
const DEFAULT_CATS = ['漫画', '小说'];
// 文库注册表：记录所有文库的位置（文库本体在用户指定路径，注册表在应用数据目录）
const REGISTRY_FILE = path.join(app.getPath('userData'), 'libraries.json');
const TAG_COLORS = ['#e74c3c', '#e67e22', '#d4a017', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63'];

function tagColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

function readRegistry() {
  try { return JSON.parse(fss.readFileSync(REGISTRY_FILE, 'utf8')); } catch { return { libraries: [] }; }
}
function writeRegistry(reg) {
  fss.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fss.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

// 递归收集目录内所有文件
async function collectFiles(dir, depth = 0) {
  let fileCount = 0, totalSize = 0;
  const files = [];
  if (depth > 8) return { fileCount, totalSize, files };
  let names = [];
  try { names = await fs.readdir(dir); } catch { return { fileCount, totalSize, files }; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const fp = path.join(dir, n);
    let st;
    try { st = await fs.stat(fp); } catch { continue; }
    if (st.isDirectory()) {
      const r = await collectFiles(fp, depth + 1);
      fileCount += r.fileCount; totalSize += r.totalSize; files.push(...r.files);
    } else {
      fileCount++; totalSize += st.size;
      files.push({ name: n, path: fp, size: st.size, category: categorize(path.extname(n)) });
    }
  }
  return { fileCount, totalSize, files };
}

// 解析组文件夹名：当前格式 "20261027_0001_组名"；兼容 v1.2 "2026年10月27日11时_000001_组名" 与 v1.1 "001_组名"
function parseGroupName(name) {
  let m = name.match(/^(\d{8})_(\d{4})_(.+)$/);
  if (m) return { date: m[1], seq: parseInt(m[2]), displayName: m[3] };
  m = name.match(/^\d{4}年\d{2}月\d{2}日\d{2}时_(\d{6})_(.+)$/);
  if (m) return { date: null, seq: parseInt(m[1]), displayName: m[2] };
  m = name.match(/^(\d+)[_\-\s](.+)$/);
  if (m) return { date: null, seq: parseInt(m[1]), displayName: m[2] };
  return { date: null, seq: null, displayName: name };
}

// 相对路径 key：统一成 "/"，这样 Linux 上记的账本搬到 Windows 后仍能对上
// （Windows 的 path.relative 返回 "漫画\组名"，Linux 记的是 "漫画/组名"）
function relKey(root, p) { return path.relative(root, p).replace(/\\/g, '/'); }

// 扫描文库：统计各大类/组，合并保留账本中的标签与预览图元数据，写回账本
// 抽成函数，供「打开文库」与「重新定位文库」共用
async function scanLibrary(root) {
  try {
    await fs.mkdir(root, { recursive: true });
    // 读取旧账本，按"相对路径"保留每个组的标签和预览图（迁移后相对路径不变，元数据不丢）
    const oldMeta = {};
    let libName = null;
    const ledgerPath = path.join(root, '.library-index.json');
    try {
      const old = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
      if (old.name) libName = old.name;
      for (const c of (old.categories || [])) {
        for (const g of (c.groups || [])) {
          const rel = relKey(old.root || root, g.path);
          if (g.tags?.length || g.cover) oldMeta[rel] = { tags: g.tags || [], cover: g.cover || null };
        }
      }
    } catch {}
    const catNames = [];
    for (const n of await fs.readdir(root)) {
      if (n.startsWith('.')) continue;
      try { if ((await fs.stat(path.join(root, n))).isDirectory()) catNames.push(n); } catch {}
    }
    const categories = [];
    for (const cn of catNames) {
      const catPath = path.join(root, cn);
      const groups = [];
      let gNames = [];
      try { gNames = await fs.readdir(catPath); } catch {}
      for (const g of gNames.sort()) {
        if (g.startsWith('.')) continue;
        const gp = path.join(catPath, g);
        let st;
        try { st = await fs.stat(gp); } catch { continue; }
        if (!st.isDirectory()) continue;
        const { fileCount, totalSize, files } = await collectFiles(gp);
        const parsed = parseGroupName(g);
        const rel = relKey(root, gp);
        const meta = oldMeta[rel] || { tags: [], cover: null };
        // 预览图：优先用账本里记录的；不存在时自动取组内第一张图片
        let cover = meta.cover;
        if (!cover || !fss.existsSync(cover)) {
          const img = files.find(f => f.category === '图片');
          cover = img ? img.path : null;
        }
        groups.push({
          seq: parsed.seq,
          date: parsed.date,
          name: g,
          displayName: parsed.displayName,
          path: gp,
          fileCount, totalSize, files,
          mtime: st.mtimeMs,
          tags: meta.tags || [],
          cover
        });
      }
      groups.sort((a, b) => ((a.seq ?? 1e9) - (b.seq ?? 1e9)) || a.name.localeCompare(b.name, 'zh'));
      categories.push({
        name: cn, path: catPath,
        groupCount: groups.length,
        totalSize: groups.reduce((s, g) => s + g.totalSize, 0),
        groups
      });
    }
    const indexData = { name: libName || path.basename(root), updatedAt: Date.now(), root, categories };
    // 账本随文库走（隐藏文件，不会被当作大类）
    try {
      await fs.writeFile(path.join(root, '.library-index.json'), JSON.stringify(indexData, null, 2));
    } catch {}
    return indexData;
  } catch (err) { return { error: err.message }; }
}

ipcMain.handle('lib:scan', async (e, root) => {
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  return scanLibrary(root);
});

// 重新定位文库：换电脑 / 文库被搬走后，原路径失效时把它指到新位置
// 只改登记表里的路径，不移动也不删除任何文件
ipcMain.handle('lib:relocate', async (e, { oldPath, newPath }) => {
  try {
    const target = String(newPath || '').replace(/[\\/]+$/, '');
    if (!target) return { error: '还没有选择新位置' };
    if (!isAllowed(target)) return { error: '无权访问该目录' };
    let st;
    try { st = await fs.stat(target); } catch { return { error: '这个位置不存在：' + target }; }
    if (!st.isDirectory()) return { error: '请选择文件夹，不是单个文件' };

    const reg = readRegistry();
    const entry = reg.libraries.find(l => l.path === oldPath);
    if (!entry) return { error: '这个文库已经不在列表里了' };
    if (reg.libraries.some(l => l.path !== oldPath && l.path === target))
      return { error: '这个位置已经登记为另一个文库了' };

    // 以新位置为准重建账本，账本里记录的各组/文件路径会全部更新为新位置
    const scanned = await scanLibrary(target);
    if (scanned.error) return { error: scanned.error };
    const hasLedger = fss.existsSync(path.join(target, '.library-index.json'));
    if (!hasLedger && !(scanned.categories || []).length)
      return { error: '这个文件夹里既没有文库账本，也没有任何大类文件夹 —— 可能选错位置了' };

    entry.path = target;
    writeRegistry(reg);
    return { ok: true, name: entry.name, path: target };
  } catch (err) { return { error: err.message }; }
});

// 文库列表（注册表内容 + 是否仍存在于磁盘）
ipcMain.handle('lib:list', async () => {
  const reg = readRegistry();
  // 首次升级到多文库模式：自动把项目内既有的「文件库」登记进列表
  // 只做一次：以前这里只判断"列表为空"，导致用户把「文件库」移除后，
  // 下次刷新又被自动加回来 —— 表现为永远删不掉。用 legacyImported 标记解决。
  if (!reg.legacyImported) {
    if (!reg.libraries.length) {
      const legacy = path.join(app.getAppPath(), '文件库');
      if (fss.existsSync(path.join(legacy, '.library-index.json'))) {
        reg.libraries.push({ name: '文件库', path: legacy, createdAt: Date.now() });
      }
    }
    // 不管有没有真的导入，都打上标记：已经处理过一次，以后不再回灌
    reg.legacyImported = true;
    writeRegistry(reg);
  }
  const libs = [];
  for (const lib of reg.libraries) {
    let exists = false, mtime = null;
    try { const st = await fs.stat(lib.path); exists = st.isDirectory(); mtime = st.mtimeMs; } catch {}
    // 概览所需的统计从各文库自带的账本读取（比逐个重新扫描快得多）
    let catCount = 0, groupCount = 0, totalSize = 0, fileCount = 0, updatedAt = null, cover = null;
    if (exists) {
      try {
        const d = JSON.parse(await fs.readFile(path.join(lib.path, '.library-index.json'), 'utf8'));
        const cats = d.categories || [];
        catCount = cats.length;
        updatedAt = d.updatedAt || null;
        for (const c of cats) {
          for (const g of (c.groups || [])) {
            groupCount++;
            totalSize += g.totalSize || 0;
            fileCount += g.fileCount || 0;
            if (!cover && g.cover && fss.existsSync(g.cover)) cover = g.cover;
          }
        }
      } catch { /* 账本缺失或损坏时按空文库展示 */ }
    }
    libs.push({ name: lib.name, path: lib.path, exists, mtime,
      catCount, groupCount, fileCount, totalSize, updatedAt, cover });
  }
  return libs;
});

// 移除文库登记（只从注册表里删掉，不删磁盘上的任何文件）
ipcMain.handle('lib:remove', async (e, libPath) => {
  try {
    const reg = readRegistry();
    const before = reg.libraries.length;
    reg.libraries = reg.libraries.filter(l => l.path !== libPath);
    writeRegistry(reg);
    return { ok: true, removed: before - reg.libraries.length };
  } catch (err) { return { error: err.message }; }
});

// 新建文库：在指定路径下创建同名文件夹 + 默认大类
ipcMain.handle('lib:create', async (e, { parentPath, name }) => {
  const safeName = String(name || '').trim().replace(/[/\\:*?"<>|]/g, '');
  if (!safeName) return { error: '文库不能为空' };
  const bad = nameError(safeName);
  if (bad) return { error: bad };
  const libPath = path.join(parentPath, safeName);
  if (!isAllowed(libPath)) return { error: '无权访问该目录' };
  try {
    if (fss.existsSync(libPath)) return { error: '目标文件夹已存在：' + libPath };
    await fs.mkdir(libPath, { recursive: true });
    for (const c of DEFAULT_CATS) await fs.mkdir(path.join(libPath, c), { recursive: true });
    const reg = readRegistry();
    if (reg.libraries.some(l => l.path === libPath)) return { error: '该文库已在列表中' };
    reg.libraries.push({ name: safeName, path: libPath, createdAt: Date.now() });
    writeRegistry(reg);
    return { ok: true, name: safeName, path: libPath };
  } catch (err) { return { error: err.message }; }
});

// 迁移文库：整个文库（文件+账本）移动到新路径，并更新注册表与账本
ipcMain.handle('lib:migrate', async (e, { oldPath, newParent }) => {
  if (!isAllowed(oldPath) || !isAllowed(newParent)) return { error: '无权访问该目录' };
  try {
    const libName = path.basename(oldPath);
    const target = path.join(newParent, libName);
    if (fss.existsSync(target)) return { error: '目标位置已存在同名文件夹：' + target };
    await fs.mkdir(newParent, { recursive: true });
    try {
      await fs.rename(oldPath, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // 跨磁盘：复制后删除原位置
      await copyDeep(oldPath, target);
      await fs.rm(oldPath, { recursive: true, force: true });
    }
    // 更新账本里的 root
    try {
      const ledger = JSON.parse(await fs.readFile(path.join(target, '.library-index.json'), 'utf8'));
      ledger.root = target;
      await fs.writeFile(path.join(target, '.library-index.json'), JSON.stringify(ledger, null, 2));
    } catch {}
    // 更新注册表
    const reg = readRegistry();
    const lib = reg.libraries.find(l => l.path === oldPath);
    if (lib) lib.path = target;
    writeRegistry(reg);
    return { ok: true, path: target };
  } catch (err) { return { error: err.message }; }
});

// 新建组：命名 "YYYYMMDD_4位序号_组名"，序号按"同日"接续（换一天重新从 1 开始）
ipcMain.handle('lib:createGroup', async (e, { root, categoryName, groupName }) => {
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  const safeName = String(groupName || '').trim().replace(/[/\\:*?"<>|]/g, '');
  if (!safeName) return { error: '组名不能为空' };
  const bad = nameError(safeName);
  if (bad) return { error: bad };
  try {
    const catPath = path.join(root, categoryName);
    await fs.mkdir(catPath, { recursive: true });
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    let maxSeq = 0;
    for (const n of await fs.readdir(catPath)) {
      const p = parseGroupName(n);
      if (p.date === dateStr && p.seq) maxSeq = Math.max(maxSeq, p.seq);
    }
    const seq = maxSeq + 1;
    const folderName = `${dateStr}_${String(seq).padStart(4, '0')}_${safeName}`;
    const groupPath = path.join(catPath, folderName);
    if (fss.existsSync(groupPath)) return { error: '同名文件夹已存在' };
    await fs.mkdir(groupPath);
    return { ok: true, seq, name: folderName, path: groupPath };
  } catch (err) { return { error: err.message }; }
});

// 向组内添加文件（复制）
ipcMain.handle('lib:addFiles', async (e, { groupPath, files }) => {
  if (!isAllowed(groupPath)) return { error: '无权访问该目录' };
  const results = { done: [], failed: [] };
  for (const src of files) {
    let dest = path.join(groupPath, path.basename(src));
    try {
      let i = 1;
      const ext = path.extname(src);
      while (fss.existsSync(dest)) {
        dest = path.join(groupPath, `${path.basename(src, ext)}_${i++}${ext}`);
      }
      await copyDeep(src, dest);
      results.done.push(dest);
    } catch (err) {
      results.failed.push({ src, reason: err.message });
    }
  }
  return results;
});

// 更新账本中某个组的字段（标签/预览图共用）
async function updateGroupMeta(root, groupPath, patch) {
  const ledgerPath = path.join(root, '.library-index.json');
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    for (const c of (ledger.categories || [])) {
      const g = (c.groups || []).find(x => x.path === groupPath || path.basename(x.path) === path.basename(groupPath));
      if (g) {
        Object.assign(g, patch);
        await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
        return { ok: true, group: g };
      }
    }
    return { error: '账本中未找到该组，请先重新扫描' };
  } catch (err) { return { error: err.message }; }
}

// 设置组标签（整组替换；颜色按标签名自动分配）
ipcMain.handle('lib:setTags', async (e, { root, groupPath, tags }) => {
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  const names = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];
  return updateGroupMeta(root, groupPath, {
    tags: names.map(n => ({ name: n, color: tagColor(n) }))
  });
});

// 设置组预览图
ipcMain.handle('lib:setCover', async (e, { root, groupPath, cover }) => {
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  return updateGroupMeta(root, groupPath, { cover: cover || null });
});

// ---------- 重命名（文库 / 大类 / 组 / 文件） ----------
// 组名只改"名字"部分，保留 日期_序号_ 前缀；文件保留扩展名
ipcMain.handle('lib:rename', async (e, { kind, target, newName }) => {
  if (!isAllowed(target)) return { error: '无权访问该路径' };
  const safe = String(newName || '').trim().replace(/[/\\:*?"<>|]/g, '');
  if (!safe) return { error: '名称不能为空' };
  const dir = path.dirname(target);
  const base = path.basename(target);
  let newBase;
  if (kind === 'file') {
    const ext = path.extname(base);
    newBase = safe.toLowerCase().endsWith(ext.toLowerCase()) ? safe : safe + ext;
  } else if (kind === 'group') {
    const m = base.match(/^(\d{8}_\d{4}_)(.+)$/) || base.match(/^(\d+)[_\-\s](.+)$/);
    newBase = m ? m[1] + safe : safe;
  } else {
    newBase = safe;
  }
  const newPath = path.join(dir, newBase);
  if (newPath === target) return { ok: true, path: newPath, name: safe };
  if (fss.existsSync(newPath)) return { error: '目标位置已存在同名：' + newBase };
  try {
    await fs.rename(target, newPath);
  } catch (err) { return { error: err.message }; }
  // 文库改名：同步更新注册表与账本里的名称/路径
  if (kind === 'library') {
    const reg = readRegistry();
    const lib = reg.libraries.find(l => l.path === target);
    if (lib) { lib.path = newPath; lib.name = safe; writeRegistry(reg); }
    try {
      const lp = path.join(newPath, '.library-index.json');
      const led = JSON.parse(await fs.readFile(lp, 'utf8'));
      led.root = newPath; led.name = safe;
      await fs.writeFile(lp, JSON.stringify(led, null, 2));
    } catch {}
  }
  const displayName = kind === 'group' ? parseGroupName(newBase).displayName : safe;
  return { ok: true, path: newPath, name: displayName };
});

// ---------- 迁移（把大类 / 组 / 文件整体移动到别处） ----------
ipcMain.handle('lib:move', async (e, { target, destDir }) => {
  if (!isAllowed(target)) return { error: '无权访问该路径' };
  if (!isAllowed(destDir)) return { error: '无权访问目标目录' };
  const dest = path.join(destDir, path.basename(target));
  if (dest === target) return { error: '目标位置与当前位置相同' };
  if (fss.existsSync(dest)) return { error: '目标位置已存在同名：' + dest };
  if (dest.startsWith(target + path.sep) || target.startsWith(dest + path.sep)) {
    return { error: '不能移动到自身或其子目录中' };
  }
  try {
    await fs.mkdir(destDir, { recursive: true });
    try {
      await fs.rename(target, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await copyDeep(target, dest);            // 跨磁盘：复制后删除原位置
      await fs.rm(target, { recursive: true, force: true });
    }
    return { ok: true, path: dest };
  } catch (err) { return { error: err.message }; }
});

// ---------- 窗口 ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: `本地文件管理器 v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 程序名与版本号显示在系统窗口标题栏，禁止页面标题覆盖
  win.on('page-title-updated', (e) => e.preventDefault());
  // 不显示窗口顶部菜单（文件/编辑/查看/窗口）
  win.removeMenu();
  if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});
app.on('window-all-closed', () => app.quit());
