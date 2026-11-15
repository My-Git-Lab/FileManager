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

// ---------- 敏感目录：读写一律拒绝 ----------
// 文件管理器需要能浏览全盘，但系统目录、浏览器凭据库、SSH 私钥这些地方
// 不该被一个「渲染本地不可信内容」的进程碰到。阻止正常用户操作之外，
// 更重要的是堵住渲染层万一被注入后的横向读取（fs:readText 可读任意文本）。
function buildDenyRoots() {
  const roots = [];
  const add = (p) => { if (p) { try { roots.push(path.resolve(p)); } catch {} } };
  if (process.platform === 'win32') {
    add(process.env.windir || 'C:\\Windows');
    add(process.env.ProgramFiles);
    add(process.env['ProgramFiles(x86)']);
    add(process.env.ProgramData);
    for (let code = 67; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      try {
        if (!fss.existsSync(drive)) continue;
        add(path.join(drive, '$Recycle.Bin'));
        add(path.join(drive, 'System Volume Information'));
      } catch {}
    }
    const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA;
    if (local) for (const p of ['Google/Chrome/User Data',
                                'Microsoft/Edge/User Data',
                                'BraveSoftware/Brave-Browser/User Data'])
      add(path.join(local, ...p.split('/')));
    if (roaming) add(path.join(roaming, 'Mozilla/Firefox/Profiles'));
  } else {
    for (const p of ['/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/run',
                     '/var/lib', '/usr', '/bin', '/sbin', '/lib', '/lib64']) add(p);
    if (process.platform === 'darwin')
      for (const p of ['/System', '/Library', '/private']) add(p);
  }
  for (const p of ['.ssh', '.aws', '.gnupg', '.kube', '.config/gcloud'])
    add(path.join(os.homedir(), ...p.split('/')));
  return roots;
}
const DENY_ROOTS = buildDenyRoots();
console.log('[安全] 允许访问的根目录：' + ALLOWED_ROOTS.join(' , '));
console.log('[安全] 敏感目录已屏蔽：' + DENY_ROOTS.length + ' 个（系统目录 / 浏览器凭据 / 密钥）'
  + (process.env.FM_STRICT_ROOTS === '1' ? '；严格模式已开启' : ''));

// 把路径解析成「真实路径」：逐级向上找到第一个存在的祖先，用 realpath 解析
// 符号链接 / Windows junction，再把尚不存在的尾部拼回去。
// 不用 realpath 的话，一个指向别处的 junction 就能绕过纯词法的前缀判断。
function canonicalPath(p) {
  let target;
  try { target = path.resolve(p); } catch { return null; }
  const tail = [];
  let cur = target;
  for (let i = 0; i < 64; i++) {
    try {
      fss.lstatSync(cur);
      let real = cur;
      try { real = fss.realpathSync.native(cur); }
      catch { try { real = fss.realpathSync(cur); } catch {} }
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return target;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return target;
}
function withinRoot(root, p) {
  const r = path.resolve(root);
  const sep = r.endsWith(path.sep) ? r : r + path.sep;
  if (process.platform === 'win32')
    return p.toLowerCase() === r.toLowerCase() || p.toLowerCase().startsWith(sep.toLowerCase());
  return p === r || p.startsWith(sep);
}
// 可选严格模式：FM_STRICT_ROOTS=1 时，只放行用户主目录、程序自身目录、
// 已登记文库根目录，以及 FM_WRITE_ROOTS 里显式追加的目录（用 path.delimiter 分隔）。
// 默认关闭 —— 全盘浏览是文件管理器的基本功能，敏感区已由 DENY_ROOTS 兜住。
// 不缓存：新建 / 删除文库后必须立刻生效，否则会出现「刚建的文库暂时无权访问」。
// 严格模式是可选功能，每次读一次几 KB 的注册表开销可忽略。
function strictAllowedRoots() {
  const roots = [path.resolve(os.homedir()), path.resolve(app.getAppPath())];
  try { for (const l of (readRegistry().libraries || [])) roots.push(path.resolve(l.path)); } catch {}
  for (const r of String(process.env.FM_WRITE_ROOTS || '').split(path.delimiter).filter(Boolean))
    roots.push(path.resolve(r));
  return roots;
}

function isAllowed(p) {
  const real = canonicalPath(p);
  if (!real) return false;
  // 默认屏蔽敏感目录；确需管理这些位置时可用 FM_ALLOW_SENSITIVE=1 自行放开。
  // 环境变量只能由启动进程设置，渲染层改不了，所以不会变成注入绕过口。
  if (process.env.FM_ALLOW_SENSITIVE !== '1' && DENY_ROOTS.some(r => withinRoot(r, real))) return false;
  const roots = process.env.FM_STRICT_ROOTS === '1' ? strictAllowedRoots() : ALLOWED_ROOTS;
  return roots.some(r => withinRoot(r, real));
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
      else await moveInto(src, dest);
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
// 把一项移动到目标路径：同盘直接 rename（快且原子），跨盘（EXDEV）退回「复制 + 校验 + 删源」。
// 失败时源文件必须仍在原地，且不能留下半份副本。
async function moveInto(src, dest) {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await moveAcrossDevices(src, dest);
  }
}
// 跨盘移动实际是「复制 + 删源」。复制中途失败（磁盘满、文件被占用、权限）时
// 直接删源会丢数据，所以删之前先核对两边的文件数 / 目录数 / 总字节数。
async function copyStats(p) {
  let files = 0, dirs = 0, bytes = 0;
  const walk = async (cur) => {
    const st = await fs.stat(cur);
    if (st.isDirectory()) {
      dirs++;
      for (const n of await fs.readdir(cur)) await walk(path.join(cur, n));
    } else if (st.isFile()) { files++; bytes += st.size; }
  };
  await walk(p);
  return { files, dirs, bytes };
}
async function moveAcrossDevices(src, dest) {
  try {
    await copyDeep(src, dest);
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error('复制副本失败（' + err.message + '）；已清理副本，原文件保持不变');
  }
  let a, b;
  try { a = await copyStats(src); b = await copyStats(dest); }
  catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error('副本校验失败（' + err.message + '），已保留原文件');
  }
  if (a.files !== b.files || a.dirs !== b.dirs || a.bytes !== b.bytes) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error(`副本不完整（源 ${a.files} 文件 / ${a.bytes} 字节，副本 ${b.files} 文件 / ${b.bytes} 字节）；已保留原文件并清理副本`);
  }
  try {
    await fs.rm(src, { recursive: true, force: true });
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error('副本已生成但删除原文件失败（' + err.message + '）；已清理副本，原文件保持不变');
  }
}

// ---------- IPC: 删除（移入系统回收站，不直接销毁） ----------
ipcMain.handle('fs:trash', async (e, { paths }) => {
  const failed = [], backups = [];
  for (const p of paths) {
    try {
      if (!isAllowed(p)) { failed.push({ path: p, reason: '无权访问该路径' }); continue; }
      const backup = await trashPath(p);
      if (backup) backups.push({ path: p, backup });
    } catch (err) {
      failed.push({ path: p, reason: err.message });
    }
  }
  return { failed, backups };
});
// 最后兜底：系统回收站接口失败时，把文件移到用户目录下的备份区。
// 旧实现静默这么做、界面却仍提示「已移入回收站」，用户根本不知道东西去哪了。
// 现在返回实际落点，由界面明确告知；跨盘 rename 会报 EXDEV，同样先验证副本。
async function moveToBackup(p) {
  const backup = path.join(os.homedir(), '.Trash-filemanager');
  await fs.mkdir(backup, { recursive: true });
  let dest = path.join(backup, `${Date.now()}_${path.basename(p)}`);
  let i = 1;
  while (fss.existsSync(dest)) dest = path.join(backup, `${Date.now()}_${i++}_${path.basename(p)}`);
  try { await fs.rename(p, dest); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await moveAcrossDevices(p, dest);
  }
  return dest;
}
// 返回 null = 真的进了系统回收站；返回字符串 = 退到了备份区，该字符串是实际落点
async function trashPath(p) {
  if (typeof shell.trashItem === 'function') {
    try { await shell.trashItem(p); return null; }
    catch (primaryErr) {
      try { return await moveToBackup(p); }
      catch (e) {
        throw new Error('移入回收站失败，备份也失败（' + primaryErr.message + ' / ' + e.message + '）');
      }
    }
  }
  // 老版本 Electron 没有该接口时，Linux 上退回 gio
  return new Promise((resolve, reject) => {
    execFile('gio', ['trash', p], async (err) => {
      if (!err) return resolve(null);
      try { resolve(await moveToBackup(p)); }
      catch (e) { reject(new Error('移入回收站失败，备份也失败：' + e.message)); }
    });
  });
}

// ---------- IPC: 一键归类 ----------
ipcMain.handle('fs:organize', async (e, dirPath) => {
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
// openPath 对可执行文件等于「在本机运行这段代码」，来自外部文库/下载目录的
// 文件必须先让用户明确确认一次，避免渲染层被注入后静默拉起任意程序。
const EXECUTABLE_EXTS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.scr', '.com', '.pif', '.jar', '.hta', '.reg', '.lnk',
  '.app', '.appimage', '.sh', '.desktop'
]);
ipcMain.handle('fs:open', async (e, p) => {
  if (!isAllowed(p)) return { error: '无权访问该路径' };
  if (EXECUTABLE_EXTS.has(path.extname(p).toLowerCase())) {
    try {
      const ans = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
        type: 'warning',
        buttons: ['取消', '仍要打开'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '即将运行可执行文件',
        message: `「${path.basename(p)}」是可执行文件，打开它等于在本机运行这段代码。`,
        detail: '如果这个文件来自别人或网络，请先确认来源可信。'
      });
      if (ans.response !== 1) return { canceled: true };
    } catch (err) { return { error: '无法弹出确认框：' + err.message }; }
  }
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
// 编码识别：UTF-16 必须按 BOM 先识别（它天然含大量 0x00，否则会被误判成二进制）；
// 无 BOM 时先按 UTF-8 严格校验，失败退回 GB18030（GBK 超集）——
// 中文 Windows 上大量 .txt 是 GBK，写死 UTF-8 会得到满屏  替换符。
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
    return { content: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16 LE' };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
    return { content: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16 BE' };
  if (buf.includes(0)) return { binary: true };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return { content: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'UTF-8' };
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    return { content: new TextDecoder('gb18030').decode(buf), encoding: 'GBK' };
  }
}

ipcMain.handle('fs:readText', async (e, filePath) => {
  if (!isAllowed(filePath)) return { error: '无权访问该文件' };
  try {
    const st = await fs.stat(filePath);
    if (st.size > 2 * 1024 * 1024) return { tooLarge: true, size: st.size };
    const buf = await fs.readFile(filePath);
    const r = decodeText(buf);
    if (r.binary) return { binary: true };
    return { content: r.content, encoding: r.encoding };
  } catch (err) { return { error: err.message }; }
});

// ---------- IPC: 文件详情（所有者/组/权限/三种时间） ----------
let _passwdMap = null, _groupMap = null;
function parsePasswd() {
  if (process.platform === 'win32') return {};   // Windows 没有 /etc/passwd，也没有 POSIX uid/gid
  if (_passwdMap) return _passwdMap;
  try {
    const lines = fss.readFileSync('/etc/passwd', 'utf-8').split('\n');
    const map = {};
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) map[parseInt(parts[2])] = parts[0];
    }
    _passwdMap = map;
    return map;
  } catch { return (_passwdMap = {}); }
}
function parseGroup() {
  if (process.platform === 'win32') return {};
  if (_groupMap) return _groupMap;
  try {
    const lines = fss.readFileSync('/etc/group', 'utf-8').split('\n');
    const map = {};
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) map[parseInt(parts[2])] = parts[0];
    }
    _groupMap = map;
    return map;
  } catch { return (_groupMap = {}); }
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
      // Windows 的 stat 没有 POSIX 的 uid/gid/mode，显示 undefined / 666 没有意义
      owner: st.uid != null ? (parsePasswd()[st.uid] || String(st.uid)) : null,
      group: st.gid != null ? (parseGroup()[st.gid] || String(st.gid)) : null,
      mode: st.uid != null ? (st.mode & parseInt('777', 8)).toString(8) : null,
      ext: isDir ? '' : path.extname(p),
      category: isDir ? '文件夹' : categorize(path.extname(p)),
      name: path.basename(p),
      path: p
    };
  } catch (err) { return { error: err.message }; }
});

// ---------- 文件文库（多文库管理：文库 → 大类 → 组 → 文件） ----------
// 新建文库时附带的两个默认大类。只影响「之后新建」的文库，已有文库的目录不会被改动。
const DEFAULT_CATS = ['大类1', '大类2'];
// 文库注册表：记录所有文库的位置（文库本体在用户指定路径，注册表在应用数据目录）
const REGISTRY_FILE = path.join(app.getPath('userData'), 'libraries.json');
const TAG_COLORS = ['#e74c3c', '#e67e22', '#d4a017', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63'];

function tagColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

// 标签统一按名称排序（中文拼音 + 数字按数值），与添加标签的先后顺序无关。
// 末尾用码点比较兜底，保证只差大小写 / 全半角的标签也有确定的顺序。
function tagCompare(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  return x.localeCompare(y, 'zh', { numeric: true }) || (x < y ? -1 : x > y ? 1 : 0);
}

// ---------- 层级元数据：文库 / 大类 / 组 / 文件共用的「作者 / 标签 / 来源」 ----------
// 键是相对文库根目录的路径：''=文库本身，'大类'=大类，'大类/组'=组，'大类/组/文件'=文件。
// 作者与来源用字符串数组（可多值），标签用 {name,color} 数组；文件层级只保留标签。
// 上级的非空信息由渲染层在显示时向下合并，账本里只存每一级「自己填的值」。
function emptyMeta() { return { author: [], tags: [], source: [] }; }
function levelOfRel(rel) {
  const n = rel ? String(rel).split('/').filter(Boolean).length : 0;
  return n === 0 ? 'lib' : n === 1 ? 'cat' : n === 2 ? 'group' : 'file';
}
function metaList(v) {
  const arr = Array.isArray(v) ? v : [v];
  return [...new Set(arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
}
function mergeTags(a, b) {
  const out = [], seen = new Set();
  for (const t of [...(a || []), ...(b || [])]) {
    const name = String(typeof t === 'string' ? t : ((t && t.name) || '')).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, color: safeTagColor(t && t.color, name) });
  }
  return out.sort((a, b) => tagCompare(a.name, b.name));
}
// 颜色会被渲染层插进 HTML 的 style 属性，而账本可能来自「别人给你的文库文件夹」。
// 只接受合法的 #RGB / #RGBA / #RRGGBB / #RRGGBBAA，其它一律按标签名重新分配，
// 避免账本里埋 `red" onmouseover=...` 之类的注入载荷。
function safeTagColor(c, name) {
  const s = String(c == null ? '' : c).trim();
  const hex = s.startsWith('#') ? s.slice(1) : '';
  return /^[0-9a-fA-F]+$/.test(hex) && [3, 4, 6, 8].includes(hex.length) ? s : tagColor(name);
}
function normMeta(raw, rel) {
  const m = emptyMeta();
  if (!raw || typeof raw !== 'object') return m;
  if (levelOfRel(rel) !== 'file') {
    m.author = metaList(raw.author);
    m.source = metaList(raw.source);
  }
  m.tags = mergeTags([], raw.tags);
  return m;
}
function normMetaMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [rel, v] of Object.entries(raw)) {
    const m = normMeta(v, rel);
    if (m.author.length || m.source.length || m.tags.length) out[rel] = m;
  }
  return out;
}
// 从账本读取 meta：新版直接读 meta；旧版（组标签 + fileMeta）一次性迁移，文件级作者/来源上提到所属组
function metaFromLedger(led, root) {
  if (led && led.meta && typeof led.meta === 'object' && !Array.isArray(led.meta))
    return normMetaMap(led.meta);
  const out = {};
  for (const c of ((led && led.categories) || [])) {
    for (const g of (c.groups || [])) {
      if (!(g.tags || []).length) continue;
      const rel = relKey(led.root || root, g.path);
      const cur = out[rel] || emptyMeta();
      cur.tags = mergeTags(cur.tags, g.tags);
      out[rel] = cur;
    }
  }
  const fm = (led && led.fileMeta && typeof led.fileMeta === 'object' && !Array.isArray(led.fileMeta))
    ? led.fileMeta : {};
  for (const [rel, v] of Object.entries(fm)) {
    const parts = String(rel).split('/').filter(Boolean);
    if (parts.length < 3) continue;                 // 文件级信息一律上提到所属组
    const gr = parts.slice(0, 2).join('/');
    const src = normMeta(v, gr);
    const cur = out[gr] || emptyMeta();
    cur.author = [...new Set([...cur.author, ...src.author])];
    cur.source = [...new Set([...cur.source, ...src.source])];
    cur.tags = mergeTags(cur.tags, src.tags);
    out[gr] = cur;
  }
  return out;
}
function persistMeta(led, mm) {
  led.meta = mm;
  led.metaVersion = 2;
  delete led.fileMeta;                            // 旧格式不再保留
  return led;
}

function readRegistry() {
  try { return JSON.parse(fss.readFileSync(REGISTRY_FILE, 'utf8')); } catch { return { libraries: [] }; }
}
function writeRegistry(reg) {
  fss.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fss.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

// ---------- 账本路径脱敏：磁盘只存相对路径 ----------
// .library-index.json 随文库文件夹一起存放。旧版本把每个文件的绝对路径都写了进去，
// 一旦文库被打包发人、放进网盘或误提交，泄露的是本机用户名、完整目录结构和文件命名。
// 现在落盘只写相对路径（统一 /）；读进来后按「当前文库根目录」还原成绝对路径，
// 所以渲染层与所有 IPC 仍按原来的绝对路径工作，无需改动。
function ledgerToRel(root, p) {
  if (!p || typeof p !== 'string') return p;
  if (!path.isAbsolute(p)) return p;                    // 已经相对化
  return path.relative(root, p).replace(/\\/g, '/');
}
function ledgerToAbs(root, p) {
  if (!p || typeof p !== 'string') return p;
  if (path.isAbsolute(p)) return p;                    // 旧账本由 hydrateLedger 重定位
  const base = path.resolve(root);
  const joined = path.resolve(base, p.replace(/\\/g, '/'));
  // 账本可能来自外部，禁止 ../ 逃出文库范围去指向别处
  if (joined !== base && !joined.startsWith(base + path.sep)) return null;
  return joined;
}
function ledgerWalk(led, fn) {
  for (const c of (led.categories || [])) {
    fn(c);
    for (const g of (c.groups || [])) {
      fn(g);
      for (const f of (g.files || [])) fn(f);
    }
  }
}
function dehydrateLedger(led, root) {
  const out = JSON.parse(JSON.stringify(led));
  delete out.root;                    // 根目录由「当前文库所在位置」决定，不再落盘
  out.pathVersion = 2;
  ledgerWalk(out, (o) => {
    if (o.path !== undefined) o.path = ledgerToRel(root, o.path);
    if (o.cover !== undefined) o.cover = ledgerToRel(root, o.cover);
  });
  return out;
}
function hydrateLedger(led, root) {
  const out = JSON.parse(JSON.stringify(led));
  const oldRoot = led.root || root;
  out.root = root;
  ledgerWalk(out, (o) => {
    for (const k of ['path', 'cover']) {
      const v = o[k];
      if (!v || typeof v !== 'string') continue;
      if (path.isAbsolute(v) && !led.pathVersion) {
        // 旧格式：先按账本自己记的旧根目录算出相对位置，再映射到当前位置。
        // 从 Linux 搬来的账本在 Windows 上也能对上号，且不会去访问旧机器路径。
        o[k] = ledgerToAbs(root, path.relative(oldRoot, v).replace(/\\/g, '/'));
      } else {
        o[k] = ledgerToAbs(root, v);
      }
    }
  });
  return out;
}
async function readLedger(lp, root) {
  return hydrateLedger(JSON.parse(await fs.readFile(lp, 'utf8')), root);
}
async function writeLedger(lp, led, root) {
  await fs.writeFile(lp, JSON.stringify(dehydrateLedger(led, root), null, 2));
}

// ---------- 文库标签库：每个文库一份，随文库文件夹一起存放 ----------
// .library-tags.json 与 .library-index.json 同级，记录该文库里四个层级「当前仍在使用」的
// 标签并集（不是历史累计）。它不在程序本体、也不在应用数据目录：文库被整体搬走 / 复制到
// 别的机器 / 删除时，标签库跟着一起走，不会凭空留下或丢失。
// 真源是账本里的标签；这里只是随文库存放的副本，统一按名称排序，不含绝对路径等隐私信息。
const TAG_BANK_FILE = '.library-tags.json';
function tagBankPath(root) { return path.join(root, TAG_BANK_FILE); }
function cleanTagNames(list) {
  const out = [], seen = new Set();
  for (const t of (list || [])) {
    const name = String(typeof t === 'string' ? t : ((t && t.name) || '')).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort(tagCompare);
}
function readTagBank(root) {
  try {
    const raw = JSON.parse(fss.readFileSync(tagBankPath(root), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tags) ? raw.tags : []);
    return cleanTagNames(arr);
  } catch { return []; }            // 不存在 / 损坏 / 旧格式：一律按空库处理
}
// 先写临时文件再改名，避免程序被强关时留下半个 JSON；个别环境不允许覆盖时退回直接写。
async function writeTagBank(root, names) {
  const clean = cleanTagNames(names);       // 统一按名称排序，与添加顺序无关
  const dest = tagBankPath(root), tmp = dest + '.tmp';
  const payload = JSON.stringify({ version: 1, tags: clean }, null, 2);
  // 内容没变就不写：刷新标签库时避免无谓的磁盘写入
  try { if (fss.readFileSync(dest, 'utf8') === payload) return clean; } catch {}
  await fs.writeFile(tmp, payload);
  try {
    try { await fs.rename(tmp, dest); }
    catch (err) { await fs.writeFile(dest, payload); }   // 个别环境不允许覆盖
  } finally {
    await fs.unlink(tmp).catch(() => {});                // 无论成败都不留 .tmp
  }
  return clean;
}
// 从账本收集四个层级（文库 / 大类 / 组 / 文件）自己填过的所有标签
async function ledgerTagNames(root, strict) {
  let led;
  try { led = await readLedger(path.join(root, '.library-index.json'), root); }
  catch { return strict ? null : []; }    // 账本不可读：严格模式交给调用方回退到标签库
  const names = [];
  for (const m of Object.values(metaFromLedger(led, root)))
    for (const t of (m.tags || [])) names.push(typeof t === 'string' ? t : t.name);
  return cleanTagNames(names);
}
// 标签库 = 账本里「当前仍然存在」的标签快照：从某一层级删掉标签后，
// 只要全库再没有别的层级用它，这个词就会从标签库消失，不再留作历史候选。
async function syncTagBank(root) {
  const names = await ledgerTagNames(root);
  return writeTagBank(root, names);
}
// 标签库只是辅助功能：写失败只记日志，绝不影响标签本身已经保存成功的主流程。
async function bestEffortSyncTagBank(root) {
  try { await syncTagBank(root); }
  catch (err) { console.log('[标签库] 同步失败（不影响标签保存）：' + err.message); }
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

// 解析组文件夹名：当前格式 "YYYYMMDD_0001_组名"；兼容早期版本的中文日期格式与纯序号格式
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

// 扫描文库：统计各大类/组，合并保留账本中的层级元数据与预览图，写回账本
// 抽成函数，供「打开文库」与「重新定位文库」共用
async function scanLibrary(root) {
  try {
    await fs.mkdir(root, { recursive: true });
    const ledgerPath = path.join(root, '.library-index.json');
    let old = null;
    try { old = await readLedger(ledgerPath, root); } catch {}
    const libName = old && old.name ? old.name : null;
    // 预览图按相对路径保留（文库整体迁移后相对路径不变，不会丢）
    const oldCover = {};
    if (old) for (const c of (old.categories || []))
      for (const g of (c.groups || [])) {
        if (g.cover) oldCover[relKey(old.root || root, g.path)] = g.cover;
      }
    // 作者 / 标签 / 来源：新版读 meta，旧版自动迁移
    const metaMap = metaFromLedger(old, root);
    const catNames = [];
    for (const n of await fs.readdir(root)) {
      if (n.startsWith('.')) continue;
      try { if ((await fs.stat(path.join(root, n))).isDirectory()) catNames.push(n); } catch {}
    }
    const categories = [];
    for (const cn of catNames) {
      const catPath = path.join(root, cn);
      const catRel = relKey(root, catPath);
      const catOwn = metaMap[catRel] || emptyMeta();
      const groups = [];
      let gNames = [];
      try { gNames = await fs.readdir(catPath); } catch {}
      for (const g of gNames.sort()) {
        if (g.startsWith('.')) continue;
        const gp = path.join(catPath, g);
        let st;
        try { st = await fs.stat(gp); } catch { continue; }
        if (!st.isDirectory()) continue;
        const collected = await collectFiles(gp);
        const { fileCount, totalSize } = collected;
        // 每个对象都带上相对路径 rel，渲染层据此计算继承链；tags 是「本级自有标签」
        const files = collected.files.map(f => {
          const rel = relKey(root, f.path);
          const own = metaMap[rel] || emptyMeta();
          return { ...f, rel, tags: own.tags };
        });
        const parsed = parseGroupName(g);
        const rel = relKey(root, gp);
        const meta = metaMap[rel] || emptyMeta();
        let cover = oldCover[rel];
        if (!cover || !fss.existsSync(cover)) {
          const img = files.find(f => f.category === '图片');
          cover = img ? img.path : null;
        }
        groups.push({
          seq: parsed.seq,
          date: parsed.date,
          name: g,
          displayName: parsed.displayName,
          path: gp, rel,
          fileCount, totalSize, files,
          mtime: st.mtimeMs,
          tags: meta.tags,
          cover
        });
      }
      groups.sort((a, b) => ((a.seq ?? 1e9) - (b.seq ?? 1e9)) || a.name.localeCompare(b.name, 'zh'));
      categories.push({
        name: cn, path: catPath, rel: catRel,
        groupCount: groups.length,
        totalSize: groups.reduce((s, g) => s + g.totalSize, 0),
        tags: catOwn.tags,
        groups
      });
    }
    const indexData = {
      name: libName || path.basename(root), updatedAt: Date.now(), root, rel: '',
      metaVersion: 2, meta: metaMap,
      tags: (metaMap[''] || emptyMeta()).tags,
      categories
    };
    // 账本随文库走（隐藏文件，不会被当作大类）
    try {
      await writeLedger(ledgerPath, indexData, root);
    } catch {}
    // 按账本重建本文库标签库：老文库升级、账本被外部改动、已删除的标签都在这里同步
    await bestEffortSyncTagBank(root);
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

// 所有文库「当前仍在使用」的标签并集：供「添加已有标签」跨文库选取。
// 真源是各文库账本里四个层级现存的标签；标签库文件只是随文库存放的副本，
// 每次读取时顺手刷新成当前值（早期累计词库里的历史词会自动清掉）。
// 账本不可读时才回退到标签库快照，避免账本损坏时把候选标签误清空。
ipcMain.handle('lib:tagBanks', async () => {
  const map = new Map();                    // 标签名 -> 来源文库名集合
  let libs = [];
  try { libs = readRegistry().libraries || []; } catch {}
  for (const lib of libs) {
    const root = lib.path;
    if (!root || !fss.existsSync(root) || !isAllowed(root)) continue;
    let names;
    try {
      const current = await ledgerTagNames(root, true);
      if (current === null) names = readTagBank(root);
      else {
        names = current;
        await bestEffortSyncTagBank(root);  // 让标签库文件与账本保持一致
      }
    } catch { continue; }
    const label = lib.name || path.basename(root);
    for (const n of cleanTagNames(names)) {
      if (!map.has(n)) map.set(n, new Set());
      map.get(n).add(label);
    }
  }
  const tags = [...map.entries()]
    .sort((a, b) => tagCompare(a[0], b[0]))
    .map(([name, ls]) => ({ name, libs: [...ls].sort(tagCompare) }));
  return { tags };
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
    let catCount = 0, groupCount = 0, totalSize = 0, fileCount = 0, updatedAt = null, cover = null, libMeta = null;
    if (exists) {
      try {
        const d = await readLedger(path.join(lib.path, '.library-index.json'), lib.path);
        const cats = d.categories || [];
        catCount = cats.length;
        updatedAt = d.updatedAt || null;
        if (d.meta && typeof d.meta === 'object') libMeta = d.meta[''] || null;
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
      catCount, groupCount, fileCount, totalSize, updatedAt, cover, meta: libMeta });
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
    await bestEffortSyncTagBank(libPath);   // 新建文库即带一份空标签库（与文库一起存在）
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
      await moveAcrossDevices(oldPath, target);   // 跨盘：校验副本后才删源
    }
    // 更新账本里的 root
    try {
      const lp = path.join(target, '.library-index.json');
      const ledger = await readLedger(lp, target);
      await writeLedger(lp, ledger, target);
    } catch {}
    // 更新注册表
    const reg = readRegistry();
    const lib = reg.libraries.find(l => l.path === oldPath);
    if (lib) lib.path = target;
    writeRegistry(reg);
    return { ok: true, path: target };
  } catch (err) { return { error: err.message }; }
});

// 新建大类：在文库根目录下创建一个空的大类文件夹（下次扫描即成为该文库的大类）
// 此前大类只能由「新建组」或「批量添加」顺带创建，界面上没有独立入口。
ipcMain.handle('lib:createCategory', async (e, { root, name }) => {
  const safeName = String(name || '').trim();
  const bad = nameError(safeName);
  if (bad) return { error: bad };
  // 扫描时以点开头的目录会被当作隐藏项跳过，建出来也看不见
  if (safeName.startsWith('.')) return { error: '大类名称不能以点开头（会被视为隐藏项）' };
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  const catPath = path.join(root, safeName);
  if (!isAllowed(catPath)) return { error: '无权访问该目录' };
  const realRoot = canonicalPath(root), realCat = canonicalPath(catPath);
  if (!realRoot || !realCat || !withinRoot(realRoot, realCat))
    return { error: '目标路径不在该文库内' };
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return { error: '文库路径不是文件夹' };
    // NTFS 不区分大小写：大小写不同也算同名，避免建出两个看起来一样的大类
    const hit = (await fs.readdir(root)).find(n => isSamePath(n, safeName));
    if (hit) return { error: '已存在同名大类：' + hit };
    await fs.mkdir(catPath);   // 不用 recursive：文库根目录必须已存在
    return { ok: true, name: safeName, path: catPath };
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
      return { error: '新建失败：目录正被其他程序占用，关闭后重试即可' };
    if (err.code === 'ENOENT') return { error: '新建失败：文库目录已不存在，请刷新后重试' };
    return { error: '新建失败：' + err.message };
  }
});

// 新建组：命名 "YYYYMMDD_4位序号_组名"，序号按"同日"接续（换一天重新从 1 开始）
// 抽成函数：界面「新建组」与「批量添加」共用同一套命名与校验规则
async function createGroupFolder(root, categoryName, groupName) {
  const safeName = String(groupName || '').trim().replace(/[/\\:*?"<>|]/g, '');
  const safeCat = String(categoryName || '').trim();
  if (!safeName) return { error: '组名不能为空' };
  if (!safeCat) return { error: '大类名称不能为空' };
  const bad = nameError(safeName) || nameError(safeCat);
  if (bad) return { error: bad };
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  try {
    const catPath = path.join(root, safeCat);
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
}
ipcMain.handle('lib:createGroup', async (e, { root, categoryName, groupName }) => {
  return createGroupFolder(root, categoryName, groupName);
});

// 向组内添加文件（移动：成功后原位置不再保留）
ipcMain.handle('lib:addFiles', async (e, { groupPath, files }) => {
  if (!isAllowed(groupPath)) return { error: '无权访问该目录' };
  const results = { done: [], failed: [] };
  for (const src of files) {
    try {
      if (!isAllowed(src)) { results.failed.push({ src, reason: '无权访问该路径' }); continue; }
      if (isSamePath(path.resolve(path.dirname(src)), path.resolve(groupPath))) {
        results.failed.push({ src, reason: '已在目标组内' }); continue;
      }
      let dest = path.join(groupPath, path.basename(src));
      let i = 1;
      const ext = path.extname(src);
      while (fss.existsSync(dest)) {
        dest = path.join(groupPath, `${path.basename(src, ext)}_${i++}${ext}`);
      }
      await moveInto(src, dest);
      // 源文件若来自某个已登记文库，把它的文件级标签一并迁到新位置
      if (libraryRootFor(src)) await rewriteMeta(src, dest, false).catch(() => {});
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
    const ledger = await readLedger(ledgerPath, root);
    for (const c of (ledger.categories || [])) {
      const g = (c.groups || []).find(x => x.path === groupPath || path.basename(x.path) === path.basename(groupPath));
      if (g) {
        Object.assign(g, patch);
        await writeLedger(ledgerPath, ledger, root);
        return { ok: true, group: g };
      }
    }
    return { error: '账本中未找到该组，请先重新扫描' };
  } catch (err) { return { error: err.message }; }
}

// 写入某一层级的自有信息（整级替换）。文件层级只允许 tags。
async function writeMeta(root, rel, patch, level) {
  const lp = path.join(root, '.library-index.json');
  let led = {};
  try { led = await readLedger(lp, root); } catch {}
  const mm = metaFromLedger(led, root);
  const cur = mm[rel] || emptyMeta();
  const next = emptyMeta();
  if ((level || levelOfRel(rel)) !== 'file') {
    next.author = patch.author !== undefined ? metaList(patch.author) : cur.author;
    next.source = patch.source !== undefined ? metaList(patch.source) : cur.source;
  }
  next.tags = patch.tags !== undefined ? mergeTags([], patch.tags) : cur.tags;
  if (next.author.length || next.source.length || next.tags.length) mm[rel] = next;
  else delete mm[rel];
  await writeLedger(lp, persistMeta(led, mm), root);
  await bestEffortSyncTagBank(root);
  return { ok: true, meta: next };
}
// 批量添加用：保留该组已有的作者 / 来源 / 标签，把新一批的值合并进去（去重）
async function mergeMeta(root, rel, patch, level) {
  const lp = path.join(root, '.library-index.json');
  let led = {};
  try { led = await readLedger(lp, root); } catch {}
  const mm = metaFromLedger(led, root);
  const cur = mm[rel] || emptyMeta();
  const next = {
    author: [...new Set([...cur.author, ...metaList(patch.author)])],
    source: [...new Set([...cur.source, ...metaList(patch.source)])],
    tags: mergeTags(cur.tags, patch.tags)
  };
  if ((level || levelOfRel(rel)) === 'file') { next.author = []; next.source = []; }
  if (next.author.length || next.source.length || next.tags.length) mm[rel] = next;
  else delete mm[rel];
  await writeLedger(lp, persistMeta(led, mm), root);
  await bestEffortSyncTagBank(root);
  return next;
}
ipcMain.handle('lib:setMeta', async (e, { root, rel, level, patch }) => {
  if (!isAllowed(root)) return { error: '无权访问该文库' };
  try { return await writeMeta(root, String(rel || ''), patch || {}, level); }
  catch (err) { return { error: err.message }; }
});

// 设置组标签（整组替换；颜色按标签名自动分配）
ipcMain.handle('lib:setTags', async (e, { root, groupPath, tags }) => {
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  return writeMeta(root, relKey(root, groupPath), { tags: tags || [] }, 'group');
});

// 设置组预览图
ipcMain.handle('lib:setCover', async (e, { root, groupPath, cover }) => {
  if (!isAllowed(root)) return { error: '无权访问该目录' };
  return updateGroupMeta(root, groupPath, { cover: cover || null });
});

// ---------- 批量添加：一次导入一批文件，并把作者 / 标签 / 来源记到目标组 ----------
// 文件层级不记录作者与来源，统一由组向下继承；账本用相对路径做键，
// 文库整体迁移 / 换电脑重新定位后仍能对上号。
const BATCH_MAX_FILES = 5000;

// 找出某个路径属于哪个已登记文库（有多个时取最长匹配）
function libraryRootFor(p) {
  const reg = readRegistry();
  let best = null;
  const abs = path.resolve(p);
  for (const lib of reg.libraries) {
    const r = path.resolve(lib.path);
    if ((abs === r || abs.startsWith(r + path.sep)) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

// 重命名 / 迁移后同步 meta 的键：文件改名改键，目录改名改前缀；跨文库时搬到目标账本
async function rewriteMeta(oldPath, newPath, isDir) {
  const oldRoot = libraryRootFor(oldPath);
  const newRoot = libraryRootFor(newPath);
  const root = oldRoot || newRoot;
  if (!root) return;
  const srcLedger = path.join(root, '.library-index.json');
  let ledger = {};
  try { ledger = await readLedger(srcLedger, root); } catch { return; }
  const mm = metaFromLedger(ledger, root);
  const oldRel = relKey(root, oldPath);
  const newRel = relKey(newRoot || root, newPath);
  const rest = {}, moved = {};
  for (const [k, v] of Object.entries(mm)) {
    const hit = isDir ? (k === oldRel || k.startsWith(oldRel + '/')) : k === oldRel;
    if (hit) moved[newRel + k.slice(oldRel.length)] = v;
    else rest[k] = v;
  }
  if (!Object.keys(moved).length) return;
  try {
    if (newRoot && newRoot !== oldRoot) {
      await writeLedger(srcLedger, persistMeta(ledger, rest), root);
      const dstLedger = path.join(newRoot, '.library-index.json');
      let other = {};
      try { other = await readLedger(dstLedger, newRoot); } catch {}
      const dstMap = metaFromLedger(other, newRoot);
      for (const [k, v] of Object.entries(moved)) dstMap[k] = v;
      await writeLedger(dstLedger, persistMeta(other, dstMap), newRoot);
    } else {
      await writeLedger(srcLedger, persistMeta(ledger, { ...rest, ...moved }), root);
    }
  } catch (err) { console.log('[批次] 元数据键同步失败：' + err.message); }
}

// 可选的目标位置：只读注册表与各文库账本，不扫描文件内容，速度快
ipcMain.handle('lib:locations', async () => {
  const reg = readRegistry();
  const out = [];
  for (const lib of reg.libraries) {
    let exists = false;
    try { exists = (await fs.stat(lib.path)).isDirectory(); } catch {}
    if (!exists || !isAllowed(lib.path)) continue;
    const categories = [];
    let ledger = null;
    try { ledger = await readLedger(path.join(lib.path, '.library-index.json'), lib.path); } catch {}
    if (ledger && Array.isArray(ledger.categories)) {
      for (const c of ledger.categories) {
        const catName = c.name || path.basename(c.path);
        const catPath = path.join(lib.path, catName);
        categories.push({
          name: catName, path: catPath,
          groups: (c.groups || []).map(g => {
            const gn = g.name || path.basename(g.path);
            return { name: gn, displayName: g.displayName || parseGroupName(gn).displayName, path: path.join(catPath, gn) };
          })
        });
      }
    } else {
      // 账本还没生成时，直接按磁盘目录读一遍（大类 → 组）
      try {
        for (const n of await fs.readdir(lib.path)) {
          if (n.startsWith('.')) continue;
          const cp = path.join(lib.path, n);
          try { if (!(await fs.stat(cp)).isDirectory()) continue; } catch { continue; }
          const groups = [];
          try {
            for (const gn of await fs.readdir(cp)) {
              if (gn.startsWith('.')) continue;
              const gp = path.join(cp, gn);
              try { if ((await fs.stat(gp)).isDirectory()) groups.push({ name: gn, displayName: parseGroupName(gn).displayName, path: gp }); } catch {}
            }
          } catch {}
          categories.push({ name: n, path: cp, groups });
        }
      } catch {}
    }
    out.push({ name: lib.name || path.basename(lib.path), path: lib.path, categories });
  }
  return out;
});

// 展开待添加项：文件直接收，文件夹递归展开；跳过隐藏项与目标文库内部的文件
async function expandBatchSources(sources, root) {
  const files = [], seen = new Set(), failed = [];
  const rootAbs = path.resolve(root);
  let overflow = false, skipped = 0;
  const inRoot = (p) => {
    const a = path.resolve(p);
    return a === rootAbs || a.startsWith(rootAbs + path.sep);
  };
  const walk = async (dir, depth) => {
    if (depth > 8 || overflow) return;
    let names;
    try { names = await fs.readdir(dir); } catch (err) { failed.push({ src: dir, reason: err.message }); return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      let st;
      try { st = await fs.stat(full); } catch { continue; }
      if (st.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (inRoot(full)) { skipped++; continue; }
      const abs = path.resolve(full);
      if (seen.has(abs)) continue;
      if (files.length >= BATCH_MAX_FILES) { overflow = true; return; }
      seen.add(abs);
      files.push(full);
    }
  };
  for (const src of (sources || [])) {
    if (!isAllowed(src)) { failed.push({ src, reason: '无权访问该路径' }); continue; }
    let st;
    try { st = await fs.stat(src); } catch (err) { failed.push({ src, reason: err.message }); continue; }
    if (st.isDirectory()) {
      if (inRoot(src)) { skipped++; continue; }
      await walk(src, 0);
      continue;
    }
    if (!st.isFile()) continue;
    if (inRoot(src)) { skipped++; continue; }
    const abs = path.resolve(src);
    if (!seen.has(abs)) { seen.add(abs); files.push(src); }
  }
  return { files, failed, overflow, skipped };
}

ipcMain.handle('lib:batchAdd', async (e, payload) => {
  const { root, target, sources, author, tags, source } = payload || {};
  if (!root || !isAllowed(root)) return { error: '无权访问该文库' };
  let rootStat;
  try { rootStat = await fs.stat(root); } catch { return { error: '文库目录不存在' }; }
  if (!rootStat.isDirectory()) return { error: '文库路径不是文件夹' };
  const rootAbs = path.resolve(root);
  const inside = (p) => {
    const a = path.resolve(p);
    return a === rootAbs || a.startsWith(rootAbs + path.sep);
  };

  // 1. 先展开待添加项：没有可添加文件时不新建空组
  const expanded = await expandBatchSources(sources, root);
  if (expanded.overflow) return { error: `一次最多添加 ${BATCH_MAX_FILES} 个文件，请分批操作` };
  if (!expanded.files.length) return { error: '没有可添加的文件（所选内容为空，或都在目标文库内部）' };

  // 2. 解析目标：选「组」直接加入；选「文件库 / 大类」自动新建一个组
  let groupPath;
  if (target && target.level === 'group') {
    groupPath = target.path;
    if (!groupPath || !isAllowed(groupPath) || !inside(groupPath)) return { error: '所选组不在该文库内' };
    let gs;
    try { gs = await fs.stat(groupPath); } catch { return { error: '所选组已不存在，请重新扫描后再试' }; }
    if (!gs.isDirectory()) return { error: '所选组不是文件夹' };
  } else {
    let categoryName;
    if (target && target.level === 'category') {
      if (!inside(target.path)) return { error: '所选大类不在该文库内' };
      categoryName = path.basename(target.path);
    } else {
      categoryName = String((target && (target.newCategoryName || target.categoryName)) || '').trim();
    }
    const groupName = String((target && target.groupName) || '').trim();
    if (!categoryName) return { error: '请指定归入哪个大类' };
    if (!groupName) return { error: '请填写新组名称' };
    const created = await createGroupFolder(root, categoryName, groupName);
    if (created.error) return { error: created.error };
    groupPath = created.path;
  }

  // 3. 移动文件：同名自动加序号；Windows 不区分大小写，重名判断也要忽略大小写
  const norm = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
  // 源文件来自已登记文库时才需要迁移元数据键；先缓存文库根，避免逐个文件重复读注册表
  let regRoots = [];
  try { regRoots = readRegistry().libraries.map(l => path.resolve(l.path)); } catch {}
  const inAnyLibrary = (p) => {
    const abs = path.resolve(p);
    return regRoots.some(r => abs === r || abs.startsWith(r + path.sep));
  };
  const reserved = new Set();
  try { for (const n of await fs.readdir(groupPath)) reserved.add(norm(n)); } catch {}
  const cleanTags = mergeTags([], (tags || []).map(t => String(t).trim()));
  const cleanAuthor = String(author || '').trim();
  const cleanSource = String(source || '').trim();
  let done = 0;
  const failed = [...expanded.failed];
  for (const src of expanded.files) {
    const base = path.basename(src);
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    let name = base, i = 1;
    while (reserved.has(norm(name))) name = `${stem}_${i++}${ext}`;
    const dest = path.join(groupPath, name);
    try {
      await moveInto(src, dest);
      // 源文件若来自别的已登记文库，同步它的文件级标签，避免留下孤立键
      if (inAnyLibrary(src)) await rewriteMeta(src, dest, false).catch(() => {});
      reserved.add(norm(name));
      done++;
    } catch (err) {
      failed.push({ src, reason: err.message });
    }
  }

  // 4. 作者 / 标签 / 来源统一记到「组」上；文件层级不记录作者与来源，靠继承显示。
  //     已有信息保留，新一批的值合并进去（去重），重复往同一组添加不会互相覆盖。
  try {
    await mergeMeta(root, relKey(root, groupPath), {
      author: cleanAuthor ? [cleanAuthor] : [],
      tags: cleanTags,
      source: cleanSource ? [cleanSource] : []
    }, 'group');
  } catch (err) { console.log('[批次] 组信息写入失败：' + err.message); }

  return { ok: true, root, groupPath, done, failed, skipped: expanded.skipped };
});

// Windows 的 NTFS 不区分大小写：仅改大小写时 existsSync(新名) 也会返回 true，
// 若直接当成"同名冲突"拦下，「小说test → 小说Test」会被误报成"目标位置已存在同名"。
// 比较路径时统一 resolve（顺带兼容正反斜杠的写法差异）。
function sameFsPath(a, b) {
  try { return isSamePath(path.resolve(a), path.resolve(b)); } catch { return false; }
}
function renameErrorMessage(err) {
  const code = err && err.code;
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
    return '无法改名：目录或文件正被其他程序占用（常见于资源管理器窗口、杀毒软件或正在预览的文件），关闭后重试即可';
  if (code === 'ENOENT') return '无法改名：原路径已不存在，请刷新后重试';
  return '改名失败：' + (err && err.message ? err.message : String(err));
}
// 部分 Windows 环境不接受"只改大小写"的一次 rename，需要经一个临时名中转。
// 非大小写改动 / 非 Windows 一律不中转，失败原样抛出。
async function renamePath(oldP, newP) {
  try { await fs.rename(oldP, newP); return; }
  catch (err) {
    if (oldP === newP || !sameFsPath(oldP, newP) || process.platform !== 'win32') throw err;
    const staging = path.join(path.dirname(oldP),
      '.fm_case_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    await fs.rename(oldP, staging);
    try { await fs.rename(staging, newP); }
    catch (err2) {
      await fs.rename(staging, oldP).catch(() => {});
      throw err2;
    }
  }
}

// ---------- 重命名（文库 / 大类 / 组 / 文件） ----------
// 组名只改"名字"部分，保留 日期_序号_ 前缀；文件保留扩展名
ipcMain.handle('lib:rename', async (e, { kind, target, newName }) => {
  if (!isAllowed(target)) return { error: '无权访问该路径' };
  const safe = String(newName || '').trim().replace(/[/\\:*?"<>|]/g, '');
  if (!safe) return { error: '名称不能为空' };
  const badName = nameError(safe);
  if (badName) return { error: badName };
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
  // 只改大小写时，新路径"看起来已存在"其实就是它自己，不算冲突
  if (!sameFsPath(newPath, target) && fss.existsSync(newPath))
    return { error: '目标位置已存在同名：' + newBase };
  try {
    await renamePath(target, newPath);
  } catch (err) { return { error: renameErrorMessage(err) }; }
  // 改名后同步账本里的层级元数据键（相对路径变了）。元数据同步失败不该让改名变成"失败"
  if (kind !== 'lib' && kind !== 'library') {
    try { await rewriteMeta(target, newPath, kind !== 'file'); }
    catch (err) { console.log('[重命名] 元数据同步失败：' + err.message); }
  }
  // 文库改名：同步更新注册表与账本里的名称/路径
  if (kind === 'lib' || kind === 'library') {
    const reg = readRegistry();
    const lib = reg.libraries.find(l => sameFsPath(l.path, target));
    if (!lib) {
      // 登记里找不到这条，继续下去会让文库变成"已丢失"；把目录改回去更安全
      await renamePath(newPath, target).catch(() => {});
      return { error: '未找到该文库的登记信息，已撤销改名（可先「重新定位」该文库再试）' };
    }
    try {
      lib.path = newPath; lib.name = safe; writeRegistry(reg);
    } catch (err) {
      await renamePath(newPath, target).catch(() => {});
      return { error: '文库登记信息写入失败，已撤销改名：' + err.message };
    }
    try {
      const lp = path.join(newPath, '.library-index.json');
      const led = await readLedger(lp, newPath);
      led.name = safe;
      await writeLedger(lp, led, newPath);
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
      await moveAcrossDevices(target, dest);    // 跨盘：校验副本后才删源
    }
    // 迁移后同步账本里的层级元数据键（跨文库时一并搬到目标账本）
    let movedIsDir = false;
    try { movedIsDir = (await fs.stat(dest)).isDirectory(); } catch {}
    await rewriteMeta(target, dest, movedIsDir);
    return { ok: true, path: dest };
  } catch (err) { return { error: err.message }; }
});

// ---------- 窗口 ----------
const APP_PAGE = path.resolve(__dirname, 'index.html');
// 本程序全部内容都在本地 index.html 一个页面里，不需要任何站外导航。
// 这条判断只放行「当前这个页面自己」，外部 http(s)、其它 file: 页面一律拒绝。
function isAppPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);   // Windows: /D:/... → D:/...
    return path.resolve(p) === APP_PAGE;
  } catch { return false; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    fullscreenable: true,
    title: `本地文件管理器 v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,                 // 显式开启渲染进程沙箱（Electron 20+ 默认开启）
      webSecurity: true
    }
  });
  // 程序名与版本号显示在系统窗口标题栏，禁止页面标题覆盖
  win.on('page-title-updated', (e) => e.preventDefault());
  // 不显示窗口顶部菜单（文件/编辑/查看/窗口）
  win.removeMenu();
  if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);

  // 渲染层可能因不可信输入（外部账本、恶意文件名）被注入 <a href> 或
  // window.open，这里是最后一道闸：导航只留本地页面，新窗口一律不开。
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppPage(url)) {
      e.preventDefault();
      console.log('[安全] 已拦截页面导航：' + url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[安全] 已拦截新窗口请求：' + url);
    return { action: 'deny' };
  });
  // 本地文件管理器不需要摄像头、麦克风、定位、通知、剪贴板读取等权限。
  // 但 v0.2.1 把权限一刀切 cb(false)，连 fullscreen 也拒了 —— <video> 的原生
  // 全屏按钮正是通过 Fullscreen API 请求 fullscreen 权限，结果视频能播放却不能全屏。
  // 这里只放行 fullscreen 这一项，其余仍全部拒绝；最坏情况下渲染层被注入也只是
  // 多了「让窗口全屏」的能力，拿不到摄像头 / 文件 / 外链等任何敏感权限。
  const ses = win.webContents.session;
  const allowPermission = (permission) => permission === 'fullscreen';
  if (typeof ses.setPermissionRequestHandler === 'function')
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowPermission(permission)));
  if (typeof ses.setPermissionCheckHandler === 'function')
    ses.setPermissionCheckHandler((wc, permission) => allowPermission(permission));
  // HTML 全屏时让窗口一起进入系统级全屏，视频才会真正占满屏幕；
  // 按 ESC 退出全屏时同步恢复窗口（桌面端 Electron 不会自动做这一步）。
  win.on('enter-html-full-screen', () => { if (!win.isFullScreen()) win.setFullScreen(true); });
  win.on('leave-html-full-screen', () => { if (win.isFullScreen()) win.setFullScreen(false); });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});
app.on('window-all-closed', () => app.quit());
