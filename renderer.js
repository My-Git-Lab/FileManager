/* 渲染进程逻辑 —— v1.5.0（三栏布局；启动时中间区显示所有文库） */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'log', 'json', 'js', 'py', 'c', 'cpp', 'h',
  'java', 'html', 'css', 'xml', 'sh', 'sql', 'ini', 'conf', 'yaml', 'yml', 'ts', 'go', 'rs']);

const ICONS = {
  '文件夹': '📁', '图片': '🖼️', '文档': '📄', '视频': '🎬',
  '音频': '🎵', '压缩包': '🗜️', '程序与代码': '⚙️', '其他': '📃'
};
const CAT_CHIPS = ['全部', '图片', '视频', '文档', '音频', '压缩包', '其他'];

// ---------- 全局状态 ----------
const state = {
  homeDirs: {},
  openHistory: JSON.parse(localStorage.getItem('fm_open_history') || '[]'),
  // 中间阅览区当前视图：libs 全部文库 | lib 单个文库首页 | cat 大类 | group 组 | search 检索结果
  view: 'libs',
  // 检索方式：cat 按分类 | tag 按标签
  searchMode: localStorage.getItem('fm_search_mode') === 'tag' ? 'tag' : 'cat',
  historyHidden: localStorage.getItem('fm_history_hidden') === '1',
  // 阅览区导航历史（前进 / 后退）
  nav: { stack: [], index: -1 },
  navLock: false,
  // 中间阅览区当前"选中"的卡片（单击选中，双击才进入）{kind, path}
  cardSel: null,
  // 是否正在用输入法打字（拼音选字中）
  composing: false,
  // 文库
  libRoot: localStorage.getItem('fm_lib_root') || null,
  libData: null,
  libLibraries: [],             // 注册表中的所有文库（含统计信息）
  libSel: null,                 // { type: 'category'|'group', data }
  libExpanded: new Set(),       // 展开的大类名
  libTagFilter: null,           // 标签筛选（标签名）
  libSearch: '',                // 文库内搜索关键词
  libCatFilter: '全部',         // 文库内类型筛选
  libPageNum: 1,                // 大类组网格当前页
  libPreviewFile: null,         // 正在预览的文件（组内或搜索结果）
};

// ---------- 工具函数 ----------
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ---------- 跨平台路径工具（Linux 用 "/"，Windows 用 "\"，两边都要认） ----------
const SEP_RE = /[\\/]/;
function pathSegs(p) { return String(p == null ? '' : p).split(SEP_RE).filter(Boolean); }
function baseName(p) { const a = pathSegs(p); return a.length ? a[a.length - 1] : ''; }
function parentName(p) { const a = pathSegs(p); return a.length > 1 ? a[a.length - 2] : ''; }
// 本地文件 URL：Windows 的 C:\xxx 必须转成 file:///C:/xxx 才能被页面正确加载
function fileUrl(p) {
  const s = String(p == null ? '' : p);
  const segs = s.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!segs.length) return '';
  if (/^[a-zA-Z]:$/.test(segs[0])) {
    return 'file:///' + segs[0] + '/' + segs.slice(1).map(encodeURIComponent).join('/');
  }
  return 'file:///' + segs.map(encodeURIComponent).join('/');
}
function isTextFile(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return TEXT_EXTS.has(ext);
}
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function parentOf(p) {
  const s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return s;
  if (i === 0) return s[0];
  const parent = s.slice(0, i);
  return /^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent;
}

// ---------- 通用对话框 ----------
function showModal(title, bodyHTML, onOK, okText = '确定', onCancel = null) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-ok').textContent = okText;
  $('#modal-mask').classList.remove('hidden');
  const first = $('#modal-body input, #modal-body select');
  if (first) setTimeout(() => first.focus(), 30);
  $('#modal-ok').onclick = async () => {
    const keepOpen = await onOK();
    if (!keepOpen) hideModal();
  };
  $('#modal-cancel').onclick = () => { hideModal(); if (onCancel) onCancel(); };
  // 输入框内按 Enter 直接触发确定（输入法选字过程中不触发，避免把候选词选择当成确定）
  $('#modal-body').querySelectorAll('input').forEach(inp => {
    bindEnter(inp, () => $('#modal-ok').click());
  });
}
function hideModal() { $('#modal-mask').classList.add('hidden'); }
$('#modal-mask').addEventListener('mousedown', (e) => { if (e.target.id === 'modal-mask') hideModal(); });

// ---------- 内置选择器（系统文件对话框不可用/被取消时的回退） ----------
function inlinePickFolder() {
  return new Promise((resolve) => {
    let cur = state.homeDirs.home || '/';
    showModal('选择文件夹', `
      <div class="ip-path-row">
        <button id="ip-up" type="button">上一级</button>
        <span id="ip-cur" class="ip-cur"></span>
      </div>
      <div id="ip-list" class="ip-list"></div>
      <div class="hint">点击文件夹名进入子目录；点下方「确定选择」将选中当前所在文件夹</div>`,
      async () => { resolve(cur); }, '确定选择',
      () => resolve(null));
    const render = async () => {
      $('#ip-cur').textContent = cur;
      const list = $('#ip-list');
      const res = await window.api.list(cur);
      if (res.error) { list.innerHTML = `<div class="hint">${escapeHtml(res.error)}</div>`; return; }
      const dirs = res.entries.filter(x => x.isDir);
      list.innerHTML = dirs.length
        ? dirs.map(d => `<div class="ip-item" data-p="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</div>`).join('')
        : '<div class="hint" style="padding:8px">没有子文件夹</div>';
      list.querySelectorAll('.ip-item').forEach(item => {
        item.onclick = () => { cur = item.dataset.p; render(); };
      });
    };
    $('#ip-up').onclick = () => { if (cur !== '/') { cur = parentOf(cur); render(); } };
    render();
  });
}

function inlinePickFiles() {
  return new Promise((resolve) => {
    let cur = state.homeDirs.home || '/';
    const picked = new Set();
    showModal('选择文件', `
      <div class="ip-path-row">
        <button id="ip-up" type="button">上一级</button>
        <span id="ip-cur" class="ip-cur"></span>
      </div>
      <div id="ip-list" class="ip-list"></div>
      <div id="ip-count" class="hint">已选 0 个文件（单击文件选中/取消，可多选；点击文件夹名进入）</div>`,
      async () => { resolve([...picked]); }, '添加所选',
      () => resolve(null));
    const render = async () => {
      $('#ip-cur').textContent = cur;
      $('#ip-count').textContent = `已选 ${picked.size} 个文件（单击文件选中/取消，可多选；点击文件夹名进入）`;
      const list = $('#ip-list');
      const res = await window.api.list(cur);
      if (res.error) { list.innerHTML = `<div class="hint">${escapeHtml(res.error)}</div>`; return; }
      list.innerHTML = res.entries.length
        ? res.entries.map(x =>
            `<div class="ip-item${!x.isDir && picked.has(x.path) ? ' picked' : ''}" data-p="${escapeHtml(x.path)}" data-dir="${x.isDir ? 1 : 0}">${x.isDir ? '📁' : (ICONS[x.category] || '📃')} ${escapeHtml(x.name)}</div>`).join('')
        : '<div class="hint" style="padding:8px">空目录</div>';
      list.querySelectorAll('.ip-item').forEach(item => {
        if (item.dataset.dir === '1') {
          item.onclick = () => { cur = item.dataset.p; picked.clear(); render(); };
        } else {
          item.onclick = () => {
            if (picked.has(item.dataset.p)) picked.delete(item.dataset.p);
            else picked.add(item.dataset.p);
            item.classList.toggle('picked');
            $('#ip-count').textContent = `已选 ${picked.size} 个文件（单击文件选中/取消，可多选；点击文件夹名进入）`;
          };
        }
      });
    };
    $('#ip-up').onclick = () => { if (cur !== '/') { cur = parentOf(cur); picked.clear(); render(); } };
    render();
  });
}

// 统一入口：先尝试系统对话框，失败或未选择时启用内置选择器
async function pickFolderSafe() {
  try {
    const p = await window.api.pickFolder();
    if (p) return p;
  } catch {}
  return inlinePickFolder();
}
async function pickFilesSafe() {
  try {
    const files = await window.api.pickFiles();
    if (files && files.length) return files;
  } catch {}
  return inlinePickFiles();
}

// ---------- 打开文件（系统默认程序） ----------
async function openEntry(e) {
  if (e.isDir) { toast('请在文库树中浏览文件夹'); return; }
  const r = await window.api.open(e.path);
  if (r && r.error) { toast(r.error, true); return; }
  addOpenHistory(e);
}

// ---------- 历史记录 ----------
function addOpenHistory(e) {
  state.openHistory = state.openHistory.filter(x => x.path !== e.path);
  state.openHistory.unshift({ path: e.path, name: e.name, category: e.category });
  if (state.openHistory.length > 50) state.openHistory.length = 50;
  localStorage.setItem('fm_open_history', JSON.stringify(state.openHistory));
  renderHistory();
}
function renderHistory() {
  const box = $('#history-list');
  box.innerHTML = '';
  if (!state.openHistory.length) {
    box.innerHTML = '<div class="list-empty" style="padding:10px">暂无记录</div>';
    return;
  }
  for (const h of state.openHistory.slice(0, 30)) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `<span>${ICONS[h.category] || '📃'}</span><span class="h-name" title="${escapeHtml(h.path)}">${escapeHtml(h.name)}</span>`;
    div.onclick = async () => {
      const d = await window.api.detail(h.path);
      if (d.error) { toast('文件不存在或无法访问：' + h.name, true); removeOpenHistory(h.path); return; }
      const entry = {
        path: d.path, name: d.name, isDir: d.isDir, size: d.size,
        mtime: d.mtime, category: d.category
      };
      state.libPreviewFile = entry;
      showPreview(entry);
      showDetails(entry);
    };
    box.appendChild(div);
  }
}
function removeOpenHistory(p) {
  state.openHistory = state.openHistory.filter(x => x.path !== p);
  localStorage.setItem('fm_open_history', JSON.stringify(state.openHistory));
  renderHistory();
}
$('#btn-clear-history').onclick = () => {
  if (!state.openHistory.length) { toast('历史记录已经是空的'); return; }
  showModal('清空历史记录', `<div class="hint">确定清空全部 ${state.openHistory.length} 条历史记录？此操作不可恢复。</div>`, async () => {
    state.openHistory = [];
    localStorage.setItem('fm_open_history', '[]');
    renderHistory();
    toast('历史记录已清空');
  }, '清空');
};

// ---------- 分类筛选 chips（文库内文件类型） ----------
function buildCatChips() {
  const box = $('#cat-chips');
  box.classList.toggle('hidden', state.searchMode !== 'cat');
  box.innerHTML = '';
  for (const c of CAT_CHIPS) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (state.libCatFilter === c ? ' active' : '');
    chip.textContent = c;
    chip.onclick = () => {
      state.libCatFilter = c;
      applyFilterView();
      buildCatChips();
      renderCurrentView();
    };
    box.appendChild(chip);
  }
}

// ---------- 文库搜索（文库内文件名） ----------
$('#btn-search').onclick = runLibSearch;
bindEnter($('#search-input'), runLibSearch);              // 回车搜索
bindLiveInput($('#search-input'), runLibSearch);         // 边打字边搜（等中文上屏后再搜）
function runLibSearch() {
  state.libSearch = $('#search-input').value.trim();
  applyFilterView();
  renderCurrentView();
}

// 清空搜索与类型筛选（点击具体大类/组时调用，保持界面直觉）
function clearLibFilters() {
  state.libSearch = '';
  state.libCatFilter = '全部';
  $('#search-input').value = '';
  buildCatChips();
}

// 当前中间阅览区应渲染什么（由 state.view 决定）
function renderCurrentView() {
  switch (state.view) {
    case 'libs': showLibrariesView(); break;
    case 'lib': showLibraryHome(); break;
    case 'cat':
      if (state.libSel?.type === 'category') showCategoryView(state.libSel.data);
      else { state.view = 'lib'; showLibraryHome(); }
      break;
    case 'group':
      if (state.libSel?.type === 'group') showGroupPreview(state.libSel.data);
      else { state.view = 'lib'; showLibraryHome(); }
      break;
    case 'search': showLibFilterView(); break;
    default: showLibrariesView();
  }
}
function libFilterActive() {
  return state.libSearch !== '' || state.libCatFilter !== '全部' || !!state.libTagFilter;
}
// 根据当前选中的文库对象推断应该回到哪个视图
function selView() {
  if (!state.libRoot) return 'libs';
  if (state.libSel?.type === 'category') return 'cat';
  if (state.libSel?.type === 'group') return 'group';
  return 'lib';
}
// 筛选条件变化后：有筛选就进检索视图，否则回到原来的浏览位置
function applyFilterView() {
  state.view = libFilterActive() ? 'search' : selView();
  state.libPageNum = 1;
}

// ---------- 统一的跳转入口（中间卡片与左侧目录树共用，避免两边逻辑不一致） ----------
function gotoLibraryHome() {
  state.libSel = null;
  state.libPreviewFile = null;
  state.libPageNum = 1;
  clearLibFilters();
  state.view = state.libData ? 'lib' : 'libs';
  renderCurrentView();
  renderLibTree();
  renderBreadcrumb();
}
function gotoCategory(cat) {
  state.cardSel = null;
  state.libSel = { type: 'category', data: cat };
  state.libPreviewFile = null;
  state.libPageNum = 1;
  clearLibFilters();
  state.view = 'cat';
  renderCurrentView();
  renderLibTree();
  renderBreadcrumb();
}
function gotoGroup(g) {
  state.cardSel = null;
  state.libSel = { type: 'group', data: g };
  state.libPreviewFile = null;
  clearLibFilters();
  state.view = 'group';
  renderCurrentView();          // 由它统一调用 showGroupPreview（内含 showGroupDetails）
  renderLibTree();
  renderBreadcrumb();
}
function gotoFile(f) {
  state.cardSel = null;
  state.libPreviewFile = f;
  showPreview(f);
  showDetails(f);
}

// ---------- 阅览区预览 ----------
function clearPreview() {
  $('#preview-name').textContent = '未选择文库内容';
  $('#btn-open-external').classList.add('hidden');
  $('#btn-new-lib-inline').classList.add('hidden');
  $('#preview-body').innerHTML = `
    <div id="preview-empty">
      <div class="empty-icon">📚</div>
      <div>在左侧选择大类或文件组即可浏览</div>
      <div class="empty-sub">单击卡片看信息，双击进入下一层</div>
    </div>`;
  $('#detail-body').innerHTML = '<div class="hint">未选择文件</div>';
}
function showPreview(e) {
  $('#preview-name').textContent = e.name;
  const body = $('#preview-body');
  const openBtn = $('#btn-open-external');

  const renderOpenBtn = () => { openBtn.classList.remove('hidden'); };
  const setPlaceholder = (icon, text, withBtn = true) => {
    body.innerHTML = `<div class="preview-placeholder">
      <div class="big">${icon}</div><div>${text}</div>
      ${withBtn ? '<button id="pv-open">用系统程序打开</button>' : ''}</div>`;
    const b = $('#pv-open');
    if (b) b.onclick = () => openEntry(e);
    if (withBtn) renderOpenBtn();
  };

  if (e.isDir) {
    setPlaceholder('📁', `文件夹：${e.name}<br><span style="font-size:12px">请在文库树中浏览</span>`, false);
    navCommit();
    return;
  }

  const cat = e.category;
  if (cat === '图片') {
    body.innerHTML = `<img class="preview-img" src="${fileUrl(e.path)}" alt="${escapeHtml(e.name)}">`;
    openBtn.classList.add('hidden');
  } else if (cat === '视频') {
    body.innerHTML = `<video class="preview-video" src="${fileUrl(e.path)}" controls></video>`;
    openBtn.classList.add('hidden');
  } else if (cat === '音频') {
    body.innerHTML = `<div style="text-align:center;width:100%">
      <div style="font-size:52px;margin-bottom:14px">🎵</div>
      <audio class="preview-audio" src="${fileUrl(e.path)}" controls></audio></div>`;
    openBtn.classList.add('hidden');
  } else if (isTextFile(e.name)) {
    body.innerHTML = '<div class="preview-text">加载中…</div>';
    openBtn.classList.add('hidden');
    window.api.readText(e.path).then(r => {
      const box = $('.preview-text');
      if (!box) return;
      if (r.error) { box.textContent = '读取失败：' + r.error; return; }
      if (r.tooLarge) { box.textContent = `文件过大（${fmtSize(r.size)}），文本预览仅支持 2MB 以内。`; renderOpenBtn(); return; }
      if (r.binary) { box.textContent = '该文件是二进制格式，无法以文本预览。'; renderOpenBtn(); return; }
      box.textContent = r.content;
    });
  } else if (cat === '文档') {
    setPlaceholder('📄', `${e.name}<br><span style="font-size:12px">Office / PDF 文档暂不支持内嵌预览</span>`);
  } else {
    setPlaceholder(ICONS[cat] || '📃', `${e.name}<br><span style="font-size:12px">该类型暂不支持预览</span>`);
  }
  navCommit();
}

// ---------- 详情区 ----------
function detailRow(label, value) {
  return `<div class="detail-row"><span class="d-label">${label}</span><span class="d-value">${value}</span></div>`;
}
async function showDetails(e) {
  const body = $('#detail-body');
  body.innerHTML = '<div class="hint">加载中…</div>';
  const d = await window.api.detail(e.path);
  if (d.error) { body.innerHTML = `<div class="hint">读取详情失败：${escapeHtml(d.error)}</div>`; return; }

  const rows = `
    <div class="detail-rows">
      ${detailRow('名称', escapeHtml(d.name))}
      ${detailRow('类型', ICONS[d.category] + ' ' + (d.isDir ? '文件夹' : d.category))}
      ${detailRow('大小', d.isDir ? '—' : fmtSize(d.size))}
      ${detailRow('扩展名', d.ext || '—')}
      ${detailRow('创建时间', fmtDate(d.birthtime))}
      ${detailRow('修改时间', fmtDate(d.mtime))}
      ${detailRow('访问时间', fmtDate(d.atime))}
      <div class="detail-row" id="res-row" style="display:none">
        <span class="d-label">分辨率</span><span class="d-value" id="res-value"></span></div>
      ${detailRow('所有者', escapeHtml(d.owner) + ' / ' + escapeHtml(d.group))}
      ${detailRow('权限', d.mode)}
      ${detailRow('位置', escapeHtml(d.path))}
    </div>
    <button id="btn-show-file" class="ghost-btn" style="margin-top:8px">在文件夹中显示</button>`;
  body.innerHTML = rows;
  $('#btn-show-file').onclick = () => window.api.showInFolder(e.path);

  // 图片 / 视频补充分辨率
  if (!d.isDir && d.category === '图片') {
    const img = new Image();
    img.onload = () => {
      const row = $('#res-row');
      if (row) { row.style.display = 'flex'; $('#res-value').textContent = `${img.naturalWidth} × ${img.naturalHeight} 像素`; }
    };
    img.src = fileUrl(e.path);
  } else if (!d.isDir && d.category === '视频') {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const row = $('#res-row');
      if (row && v.videoWidth) {
        row.style.display = 'flex';
        $('#res-value').textContent = `${v.videoWidth} × ${v.videoHeight} 像素`;
      }
    };
    v.src = fileUrl(e.path);
  }
}

// ---------- 面包屑（替代原顶部工具栏，位于阅览区顶部） ----------
function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  const mk = (label, clickable, onclick) => {
    const span = document.createElement('span');
    span.className = 'crumb' + (clickable ? '' : ' current');
    span.textContent = label;
    if (clickable) span.onclick = onclick;
    bc.appendChild(span);
  };
  mk('全部文库', state.view !== 'libs', () => { state.view = 'libs'; renderCurrentView(); });

  // 「全部文库」视图或未进入文库时，只显示根级（数量由旁边的统计文字展示）
  if (state.view === 'libs' || !state.libRoot || !state.libData) return;
  const libName = state.libData.name || '文库';
  mkSep(bc);
  mk(libName, state.view !== 'lib', () => {
    state.libSel = null;
    state.view = 'lib';
    renderCurrentView();
    renderLibTree();
    renderBreadcrumb();
  });

  if (state.libSel?.type === 'category') {
    mkSep(bc);
    mk(state.libSel.data.name, false);
  } else if (state.libSel?.type === 'group') {
    const g = state.libSel.data;
    const cat = state.libData.categories.find(c => c.groups.some(x => x.path === g.path));
    if (cat) {
      mkSep(bc);
      mk(cat.name, true, () => {
        state.libSel = { type: 'category', data: cat };
        state.view = 'cat';
        renderCurrentView();
        renderLibTree();
        renderBreadcrumb();
      });
    }
    mkSep(bc);
    mk(g.displayName, false);
  }
}
function mkSep(bc) {
  const sep = document.createElement('span');
  sep.className = 'crumb-sep';
  sep.textContent = '/';
  bc.appendChild(sep);
}

// ========== 中文输入法（IME）支持：所有输入框共用 ==========
// 全局记录"是否正在用输入法打字"，弥补部分输入法下 keydown.isComposing 不可靠的问题
document.addEventListener('compositionstart', () => { state.composing = true; }, true);
document.addEventListener('compositionend', () => { state.composing = false; }, true);
function isComposing(e) { return !!(e && (e.isComposing || e.keyCode === 229)) || state.composing; }
// 回车：拼音还没上屏（组合态）时不触发动作，避免把候选词选择当成"确定"
function bindEnter(el, fn) {
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); fn(); }
  });
}
// 边输入边响应：组合态中不动，字上屏后再延迟执行（用于搜索框等即时反馈）
function bindLiveInput(el, fn, delay = 260) {
  if (!el) return;
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(() => { if (!state.composing) fn(); }, delay); };
  el.addEventListener('input', fire);
  el.addEventListener('compositionend', () => setTimeout(fire, 0));
}

// ========== 中间阅览区：单击选中 / 双击进入 ==========
function selClass(path) { return state.cardSel && state.cardSel.path === path ? ' sel' : ''; }
function findCatByPath(p) {
  return state.libData ? (state.libData.categories.find(c => c.path === p) || null) : null;
}
function findGroupByPath(p) { return state.libData ? findGroup(state.libData, p) : null; }

// 单击：只选中并在右侧显示详情，不进入下一层
function selectCard(kind, path) {
  state.cardSel = { kind, path };
  document.querySelectorAll('#preview-body .tile').forEach(el => {
    el.classList.toggle('sel', el.dataset.path === path);
  });
  refreshDetails();
}
// 单击空白处：取消选中
function clearCardSel() {
  if (!state.cardSel) return;
  state.cardSel = null;
  document.querySelectorAll('#preview-body .tile.sel').forEach(el => el.classList.remove('sel'));
  refreshDetails();
}
// 右侧详情：有选中项就显示选中项，否则显示"当前所在这一层"的信息
function refreshDetails() {
  const s = state.cardSel;
  if (s) {
    if (s.kind === 'lib') { const l = state.libLibraries.find(x => x.path === s.path); if (l) { showLibCardDetails(l); return; } }
    if (s.kind === 'cat') { const c = findCatByPath(s.path); if (c) { showCategoryDetails(c); return; } }
    if (s.kind === 'group') { const g = findGroupByPath(s.path); if (g) { showGroupDetails(g); return; } }
    if (s.kind === 'file') { const f = findLibFile(s.path); if (f) { showDetails(f); return; } }
  }
  switch (state.view) {
    case 'libs': showLibrariesInfo(); break;
    case 'lib': if (state.libData) showLibraryDetails(state.libData); break;
    case 'cat': if (state.libSel?.data) showCategoryDetails(state.libSel.data); break;
    case 'group': if (state.libSel?.data) showGroupDetails(state.libSel.data); break;
    case 'search': showFilterDetails(); break;
  }
}
function showLibCardDetails(l) {
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('名称', escapeHtml(l.name))}
    ${detailRow('类型', '📚 文库')}
    ${detailRow('状态', l.exists ? '正常' : '路径失效')}
    ${detailRow('大类数量', (l.catCount ?? 0) + ' 个')}
    ${detailRow('文件组', (l.groupCount ?? 0) + ' 个')}
    ${detailRow('总大小', fmtSize(l.totalSize || 0))}
    ${detailRow('路径', escapeHtml(l.path))}
  </div>
  <div class="hint" style="margin-top:8px">双击卡片进入该文库</div>`;
}
// 双击卡片：进入下一层
function enterCard(kind, path) {
  state.cardSel = null;
  if (kind === 'lib') {
    const l = state.libLibraries.find(x => x.path === path);
    if (!l) return;
    if (!l.exists) { showLibMissingModal(l); return; }
    selectLibrary(path); return;
  }
  if (kind === 'cat') { const c = findCatByPath(path); if (c) gotoCategory(c); return; }
  if (kind === 'group') { const g = findGroupByPath(path); if (g) gotoGroup(g); return; }
  if (kind === 'file') { const f = findLibFile(path); if (f) gotoFile(f); }
}
function showLibMissingModal(l) {
  showModal('文库已丢失', `
    <div class="hint">文库「<b>${escapeHtml(l.name)}</b>」原来的位置找不到了：<br><code style="word-break:break-all">${escapeHtml(l.path)}</code><br>
    换电脑、或把文库文件夹搬到别处后会出现这种情况。<br>请选择它现在的位置，重新挂上即可（不会移动或删除任何文件）。</div>
    <label class="field-label">它现在的位置</label>
    <div class="search-row"><input id="m-lib-path" placeholder="点击右侧「选择…」指定新位置" readonly><button id="m-lib-pick" type="button">选择…</button></div>
    <div class="modal-extra-actions">
      <button id="m-lib-drop" type="button" class="btn-text-danger">不再保留（仅移出列表）</button>
    </div>`, async () => {
    const newPath = $('#m-lib-path') ? $('#m-lib-path').value.trim() : '';
    if (!newPath) { toast('请先选择它现在的位置', true); return true; }
    const r = await window.api.libRelocate(l.path, newPath);
    if (r.error) { toast(r.error, true); return true; }
    toast(`已重新定位到：${r.path}`);
    await loadLibList();
    showLibrariesView();
  }, '重新定位');

  $('#m-lib-pick').onclick = async () => {
    const p = await pickFolderSafe();
    if (p && $('#m-lib-path')) $('#m-lib-path').value = p;
  };
  $('#m-lib-drop').onclick = async () => {
    const r = await window.api.libRemove(l.path);
    if (r.error) { toast(r.error, true); return; }
    hideModal();
    toast('已从列表中移除');
    await loadLibList();
    showLibrariesView();
  };
}

// ---------- 阅览区导航历史（前进 / 后退） ----------
function navSnapshot() {
  return {
    view: state.view,
    libRoot: state.libRoot,
    catPath: state.libSel?.type === 'category' ? state.libSel.data.path : null,
    groupPath: state.libSel?.type === 'group' ? state.libSel.data.path : null,
    search: state.libSearch,
    catFilter: state.libCatFilter,
    tagFilter: state.libTagFilter,
    file: state.libPreviewFile ? state.libPreviewFile.path : null,
    page: state.libPageNum
  };
}
// 记录一次"到达这里"的状态；前进/后退期间（navLock）不记录，避免污染历史
function navCommit() {
  if (state.navLock) { updateNavButtons(); return; }
  const snap = navSnapshot();
  const cur = state.nav.stack[state.nav.index];
  if (cur && JSON.stringify(cur) === JSON.stringify(snap)) { updateNavButtons(); return; }
  state.nav.stack = state.nav.stack.slice(0, state.nav.index + 1);
  state.nav.stack.push(snap);
  if (state.nav.stack.length > 60) state.nav.stack.shift();
  state.nav.index = state.nav.stack.length - 1;
  updateNavButtons();
}
function updateNavButtons() {
  $('#btn-nav-back').disabled = state.nav.index <= 0;
  $('#btn-nav-forward').disabled = state.nav.index >= state.nav.stack.length - 1;
}
async function navGo(delta) {
  const i = state.nav.index + delta;
  if (i < 0 || i >= state.nav.stack.length) return;
  state.nav.index = i;
  await navRestore(state.nav.stack[i]);
  updateNavButtons();
}
async function navRestore(snap) {
  state.navLock = true;
  try {
    if (snap.libRoot !== state.libRoot) {
      state.libRoot = snap.libRoot;
      if (snap.libRoot) {
        localStorage.setItem('fm_lib_root', snap.libRoot);
        await loadLibrary(true);
      } else {
        state.libData = null;
        await loadLibList();
      }
    }
    state.libSearch = snap.search || '';
    state.libCatFilter = snap.catFilter || '全部';
    state.libTagFilter = snap.tagFilter || null;
    state.libPageNum = snap.page || 1;
    $('#search-input').value = state.libSearch;
    state.libPreviewFile = null;
    state.libSel = null;
    if (snap.catPath && state.libData) {
      const c = state.libData.categories.find(x => x.path === snap.catPath);
      if (c) state.libSel = { type: 'category', data: c };
    }
    if (snap.groupPath && state.libData) {
      const g = findGroup(state.libData, snap.groupPath);
      if (g) state.libSel = { type: 'group', data: g };
    }
    state.view = snap.view || 'libs';
    if (state.view === 'cat' && state.libSel?.type !== 'category') state.view = 'lib';
    if (state.view === 'group' && state.libSel?.type !== 'group') state.view = 'lib';
    if (state.view === 'lib' && !state.libData) state.view = 'libs';
    buildCatChips();
    renderTagChips();
    renderLibTree();
    renderBreadcrumb();
    renderCurrentView();
    if (snap.file) {
      const f = findLibFile(snap.file);
      if (f) { state.libPreviewFile = f; showPreview(f); showDetails(f); }
    }
  } finally { state.navLock = false; }
}
function findLibFile(p) {
  if (!state.libData) return null;
  for (const c of state.libData.categories)
    for (const g of c.groups)
      for (const f of g.files) if (f.path === p) return f;
  return null;
}
$('#btn-nav-back').onclick = () => navGo(-1);
$('#btn-nav-forward').onclick = () => navGo(1);

// ---------- 卡片操作：重命名 / 迁移 / 删除（右键菜单与悬浮图标共用） ----------
const KIND_LABEL = { lib: '文库', cat: '大类', group: '组', file: '文件' };
// 悬浮在卡片上时右下角出现的小图标
const OPS_HTML = `<div class="tile-ops">
  <span data-op="rename" title="重命名">改</span>
  <span data-op="move" title="迁移">移</span>
  <span data-op="del" title="删除">删</span>
</div>`;
// 组卡片：在三个通用操作之外，再加三个标签操作
const GROUP_OPS_HTML = `<div class="tile-ops group-ops">
  <span data-op="rename" title="重命名">改</span>
  <span data-op="move" title="迁移">移</span>
  <span data-op="del" title="删除">删</span>
  <span data-op="tag-add" title="添加标签">加标</span>
  <span data-op="tag-rename" title="修改标签">改标</span>
  <span data-op="tag-del" title="删除标签">删标</span>
</div>`;
function cardDataAttr(kind, path, name) {
  return ` data-kind="${kind}" data-path="${escapeHtml(path)}" data-name="${escapeHtml(name || '')}"`;
}

function showContextMenu(x, y, items) {
  const m = $('#context-menu');
  m.innerHTML = items.map((it, i) => `<div data-i="${i}">${it.label}</div>`).join('');
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  m.querySelectorAll('div').forEach(d => d.onclick = () => {
    hideContextMenu();
    items[parseInt(d.dataset.i)].action();
  });
}
function hideContextMenu() { $('#context-menu').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#context-menu')) hideContextMenu();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());   // 不弹浏览器默认菜单

// 右键：对阅览区中的文库 / 大类 / 组 / 文件卡片操作（组额外提供标签三项）
$('#preview-body').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('[data-kind]');
  if (!card) return;
  e.preventDefault();
  const t = { kind: card.dataset.kind, path: card.dataset.path, name: card.dataset.name };
  selectCard(t.kind, t.path);                 // 右键顺带选中，右侧同步显示它的详情
  const items = [
    { label: '重命名', action: () => opRename(t) },
    { label: '迁移', action: () => opMove(t) },
    { label: '删除', action: () => opDelete(t) }
  ];
  if (t.kind === 'group') {
    items.push(
      { label: '添加标签', action: () => opTagAdd(t) },
      { label: '修改标签', action: () => opTagRename(t) },
      { label: '删除标签', action: () => opTagDelete(t) }
    );
  }
  showContextMenu(e.clientX, e.clientY, items);
});
// 中间阅览区单击：点小图标=执行操作；点卡片=选中；点空白=取消选中
$('#preview-body').addEventListener('click', (e) => {
  const opEl = e.target.closest('[data-op]');
  if (opEl) {                                  // 悬浮小图标
    const card = opEl.closest('[data-kind]');
    if (!card) return;
    e.stopPropagation();
    e.preventDefault();
    const t = { kind: card.dataset.kind, path: card.dataset.path, name: card.dataset.name };
    const op = opEl.dataset.op;
    if (op === 'rename') opRename(t);
    else if (op === 'move') opMove(t);
    else if (op === 'del') opDelete(t);
    else if (op === 'tag-add') opTagAdd(t);
    else if (op === 'tag-rename') opTagRename(t);
    else if (op === 'tag-del') opTagDelete(t);
    return;
  }
  if (e.target.closest('button')) return;      // 分页等按钮不参与选中
  const card = e.target.closest('[data-kind]');
  if (card) { selectCard(card.dataset.kind, card.dataset.path); return; }
  clearCardSel();                              // 点空白处：取消选中
}, true);
// 双击卡片：进入下一层（文库 → 大类 → 组 → 文件预览）
$('#preview-body').addEventListener('dblclick', (e) => {
  if (e.target.closest('[data-op]') || e.target.closest('button')) return;
  const card = e.target.closest('[data-kind]');
  if (!card) return;
  enterCard(card.dataset.kind, card.dataset.path);
});

async function opRename(t) {
  const label = KIND_LABEL[t.kind] || '项目';
  showModal(`重命名${label}`, `
    <label class="field-label">新名称</label>
    <input id="m-input" value="${escapeHtml(t.name || '')}" spellcheck="false">
    ${t.kind === 'group' ? '<div class="hint">只修改名字部分，前面的日期与序号会自动保留</div>' : ''}
    ${t.kind === 'file' ? '<div class="hint">扩展名会自动保留，不用重复输入</div>' : ''}
    ${t.kind === 'lib' ? '<div class="hint">文库文件夹会一起改名，账本与登记信息自动同步</div>' : ''}`, async () => {
    const v = $('#m-input').value.trim();
    if (!v || v === t.name) return;
    const r = await window.api.libRename(t.kind, t.path, v);
    if (r.error) { toast(r.error, true); return true; }
    toast(`已重命名为「${r.name}」`);
    await refreshAfterOp(t, r.path);
  }, '保存');
}

async function opMove(t) {
  if (t.kind === 'lib') {                                    // 文库迁移：整体搬到新位置
    if (t.path !== state.libRoot) await selectLibrary(t.path);
    openLibMigrateModal();
    return;
  }
  const dest = await pickFolderSafe();
  if (!dest) return;
  const r = await window.api.libMove(t.path, dest);
  if (r.error) { toast(r.error, true); return; }
  toast('已迁移到：' + r.path);
  await refreshAfterOp(t, r.path);
}

async function opDelete(t) {
  const label = KIND_LABEL[t.kind] || '项目';
  if (t.kind === 'lib') {
    showModal(`删除${label}`, `<div class="hint">确定把文库「<b>${escapeHtml(t.name)}</b>」从列表中移除吗？<br><br>
      为安全起见，<b>磁盘上的文件不会被删除</b>，只是不再登记在本程序里；以后可以重新「新建」并指向该目录找回。</div>`, async () => {
      const r = await window.api.libRemove(t.path);
      if (r.error) { toast(r.error, true); return; }
      toast('已移出列表');
      await loadLibList();
      state.view = 'libs';
      showLibrariesView();
    }, '移出列表');
    return;
  }
  showModal(`删除${label}`, `<div class="hint">确定删除「<b>${escapeHtml(t.name)}</b>」吗？<br><br>
    内容会被移入<b>系统回收站</b>，需要时可以还原。</div>`, async () => {
    const r = await window.api.trash([t.path]);
    if (r.failed && r.failed.length) { toast('删除失败：' + r.failed[0].reason, true); return; }
    toast('已删除，可在回收站还原');
    await refreshAfterOp(t);
  }, '删除');
}

// ---------- 组标签操作：添加 / 修改 / 删除 ----------
// 统一写回标签（一处实现，右键菜单与右侧详情共用）
async function setGroupTags(g, names) {
  const r = await window.api.libSetTags(state.libRoot, g.path, names);
  if (r.error) { toast(r.error, true); return false; }
  g.tags = r.group.tags || [];
  renderTagChips();
  renderLibTree();
  renderCurrentView();
  return true;
}
function groupTagNames(g) { return (g.tags || []).map(t => t.name); }

// 弹出标签列表供选择（该组暂无标签时给出提示）
function pickTag(g, title, emptyHint, onPick) {
  const names = groupTagNames(g);
  if (!names.length) { toast(emptyHint, true); return; }
  showModal(title,
    `<div class="ip-list">${names.map(n => `<div class="ip-item" data-t="${escapeHtml(n)}">${escapeHtml(n)}</div>`).join('')}</div>
     <div class="hint">点击要操作的标签</div>`, async () => {}, '关闭');
  document.querySelectorAll('#modal-body .ip-item').forEach(it => {
    it.onclick = () => { hideModal(); onPick(it.dataset.t); };
  });
}

function opTagAdd(t) {
  const g = findGroupByPath(t.path);
  if (!g) return;
  showModal('添加标签', `
    <label class="field-label">标签名称</label>
    <input id="m-input" spellcheck="false">
    <div class="hint">支持中文；回车或点「保存」即可，可反复添加多个标签</div>`, async () => {
    const v = $('#m-input').value.trim();
    if (!v) return true;
    const names = groupTagNames(g);
    if (names.includes(v)) { toast('这个组已经有同名标签了', true); return true; }
    if (await setGroupTags(g, [...names, v])) toast(`已添加标签「${v}」`);
  }, '保存');
}

function opTagRename(t) {
  const g = findGroupByPath(t.path);
  if (!g) return;
  pickTag(g, '修改标签', '这个组还没有标签，先添加吧', (old) => {
    showModal('修改标签', `
      <label class="field-label">新的标签名称</label>
      <input id="m-input" value="${escapeHtml(old)}" spellcheck="false">
      <div class="hint">只改这个组上的这个标签，其他组不受影响</div>`, async () => {
      const v = $('#m-input').value.trim();
      if (!v || v === old) return;
      const names = groupTagNames(g).map(n => (n === old ? v : n));
      if (await setGroupTags(g, names)) toast(`标签已改为「${v}」`);
    }, '保存');
  });
}

function opTagDelete(t) {
  const g = findGroupByPath(t.path);
  if (!g) return;
  pickTag(g, '删除标签', '这个组还没有标签', (old) => {
    showModal('删除标签', `<div class="hint">确定从「<b>${escapeHtml(g.displayName)}</b>」删除标签「<b>${escapeHtml(old)}</b>」？</div>`, async () => {
      if (await setGroupTags(g, groupTagNames(g).filter(n => n !== old))) toast('标签已删除');
    }, '删除');
  });
}

// 操作完成后重新扫描并回到合适的视图
async function refreshAfterOp(t, newPath) {
  if (t.kind === 'lib') {
    if (newPath) { state.libRoot = newPath; localStorage.setItem('fm_lib_root', newPath); }
    await loadLibList();
    if (state.libRoot) await loadLibrary(true);
    state.view = 'libs';
    showLibrariesView();
    return;
  }
  await loadLibrary(true);          // 静默重扫：state.libSel 会自动校正或被清空
  renderLibTree();
  renderBreadcrumb();
  if (state.libSel?.type === 'group') state.view = 'group';
  else if (state.libSel?.type === 'category') state.view = 'cat';
  else state.view = state.libData ? 'lib' : 'libs';
  renderCurrentView();
}

// ---------- 检索方式切换（按分类 / 按标签） ----------
function renderSearchMode() {
  const btn = $('#btn-search-mode');
  btn.textContent = state.searchMode === 'cat' ? '按标签' : '按分类';
  btn.title = state.searchMode === 'cat'
    ? '当前：按文件分类检索，点击切换为按标签检索'
    : '当前：按标签检索，点击切换为按分类检索';
}
$('#btn-search-mode').onclick = () => {
  state.searchMode = state.searchMode === 'cat' ? 'tag' : 'cat';
  localStorage.setItem('fm_search_mode', state.searchMode);
  // 两种检索方式互斥，切换时清掉另一种的筛选条件
  if (state.searchMode === 'cat') state.libTagFilter = null;
  else state.libCatFilter = '全部';
  state.libPageNum = 1;
  buildCatChips();
  renderTagChips();
  renderSearchMode();
  applyFilterView();
  renderLibTree();
  renderCurrentView();
};

// ---------- 历史记录折叠 ----------
function applyHistoryHidden() {
  $('#history-box').classList.toggle('collapsed', state.historyHidden);
  $('#btn-toggle-history').textContent = state.historyHidden ? '展开' : '隐藏';
}
$('#btn-toggle-history').onclick = () => {
  state.historyHidden = !state.historyHidden;
  localStorage.setItem('fm_history_hidden', state.historyHidden ? '1' : '0');
  applyHistoryHidden();
};

// ---------- 文件文库（多文库：文库 → 大类 → 组 → 文件） ----------
function findGroup(libData, groupPath) {
  for (const c of libData.categories) {
    const g = c.groups.find(x => x.path === groupPath);
    if (g) return g;
  }
  return null;
}

async function loadLibList() {
  state.libLibraries = await window.api.libList();
  const cur = state.libLibraries.find(l => l.path === state.libRoot);
  if (!cur || !cur.exists) {
    const first = state.libLibraries.find(l => l.exists);
    state.libRoot = first ? first.path : null;
    if (state.libRoot) localStorage.setItem('fm_lib_root', state.libRoot);
  }
  renderLibCard();
}

// ---------- 左侧「当前文库」卡片 ----------
function renderLibCard() {
  const reg = state.libLibraries.find(l => l.path === state.libRoot);
  const d = state.libData;
  const name = d?.name || reg?.name || (state.libRoot ? baseName(state.libRoot) : null);
  const libPath = d?.root || state.libRoot || '';
  $('#lib-card-name').textContent = name || '未选择文库';
  $('#lib-card-path').textContent = libPath || '点击「新建」创建，或「切换」选择已有文库';
  $('#lib-card-path').title = libPath;
  const stEl = $('#lib-card-state');
  if (!state.libRoot) { stEl.textContent = '未选择'; stEl.className = 'lc-state'; }
  else if (reg && !reg.exists) { stEl.textContent = '路径失效'; stEl.className = 'lc-state bad'; }
  else { stEl.textContent = '正常'; stEl.className = 'lc-state ok'; }
  $('#lc-stat-cat').textContent = d ? d.categories.length : '–';
  $('#lc-stat-group').textContent = d ? d.categories.reduce((s, c) => s + c.groupCount, 0) : '–';
  $('#lc-stat-size').textContent = d ? fmtSize(d.categories.reduce((s, c) => s + c.totalSize, 0)) : '–';
}

async function loadLibrary(silent = false) {
  await loadLibList();
  if (!state.libRoot) {
    state.libData = null;
    state.libSel = null;
    renderLibCard();
    $('#lib-tree').innerHTML = '<div class="list-empty">点击「新建」创建第一个文库</div>';
    renderTagChips();
    renderBreadcrumb();
    if (!silent) { state.view = 'libs'; renderCurrentView(); }
    return;
  }
  const stEl = $('#lib-card-state');
  stEl.textContent = '扫描中…'; stEl.className = 'lc-state';
  const data = await window.api.libScan(state.libRoot);
  if (data.error) { toast(data.error, true); renderLibCard(); return; }
  state.libData = data;
  renderLibCard();
  if (!state.libExpanded.size && data.categories.length) state.libExpanded.add(data.categories[0].name);
  // 刷新当前选中对象的最新数据
  if (state.libSel?.type === 'category') {
    const cat = data.categories.find(c => c.path === state.libSel.data.path);
    if (cat) state.libSel.data = cat;
    else state.libSel = null;
  } else if (state.libSel?.type === 'group') {
    const g = findGroup(data, state.libSel.data.path);
    if (g) state.libSel.data = g;
    else state.libSel = null;
  }
  renderTagChips();
  renderLibTree();
  renderBreadcrumb();
  if (!silent) renderCurrentView();
}

// ---------- 切换 / 进入文库 ----------
async function selectLibrary(p) {
  state.cardSel = null;
  state.libRoot = p;
  localStorage.setItem('fm_lib_root', p);
  state.libSel = null;
  state.libExpanded.clear();
  state.libTagFilter = null;
  state.libPageNum = 1;
  clearLibFilters();
  await loadLibrary(true);
  state.view = state.libData ? 'lib' : 'libs';
  renderCurrentView();
  renderLibTree();
  renderBreadcrumb();
}

function openLibSwitchModal() {
  const items = state.libLibraries.map(l => `
    <div class="ip-item lib-switch-item${l.path === state.libRoot ? ' picked' : ''}" data-p="${escapeHtml(l.path)}" data-ex="${l.exists ? 1 : 0}">
      <span>${l.exists ? '📚' : '⚠️'}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(l.name)}${l.exists ? '' : '（路径失效）'}</span>
      <span style="font-size:10.5px;opacity:.75">${l.groupCount ?? 0} 组</span>
    </div>`).join('');
  showModal('切换文库',
    `<div class="ip-list">${items || '<div class="hint" style="padding:8px">还没有登记的文库</div>'}</div>
     <div class="hint">点击文库名即可切换；蓝色高亮的是当前文库，「路径失效」表示原位置已找不到该文库</div>`,
    async () => {}, '关闭');
  document.querySelectorAll('#modal-body .lib-switch-item').forEach(it => {
    it.onclick = async () => {
      hideModal();
      if (it.dataset.ex !== '1') { toast('该文库已不在原位置，无法打开', true); return; }
      await selectLibrary(it.dataset.p);
    };
  });
}

// ---------- 中间：全部文库总览（程序启动后的默认视图） ----------
// 所有层级（全部文库 / 大类列表 / 组内组 / 组内文件 / 检索结果）每页数量统一
const PAGE_SIZE = 12;
// 分页条：四个层级共用同一段 HTML 与翻页逻辑，保证排版与文案一致
function pagerHTML(page, pages) {
  if (pages <= 1) return '';
  return `<div class="pager">
      <button id="pg-prev"${page <= 1 ? ' disabled' : ''}>上一页</button>
      <span>第 ${page} / ${pages} 页</span>
      <button id="pg-next"${page >= pages ? ' disabled' : ''}>下一页</button>
    </div>`;
}
function bindPager(body, rerender) {
  const prev = body.querySelector('#pg-prev');
  if (prev) prev.onclick = () => { state.libPageNum--; rerender(); };
  const next = body.querySelector('#pg-next');
  if (next) next.onclick = () => { state.libPageNum++; rerender(); };
}

function showLibrariesView() {
  state.view = 'libs';
  $('#btn-new-lib-inline').classList.remove('hidden');
  $('#btn-open-external').classList.add('hidden');
  $('#preview-name').textContent = `共 ${state.libLibraries.length} 个文库`;

  const list = state.libLibraries;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const tiles = slice.map((l, i) => `
    <div class="tile lib-tile${l.exists ? '' : ' missing'}${l.path === state.libRoot ? ' current' : ''}${selClass(l.path)}" data-i="${i}"${cardDataAttr('lib', l.path, l.name)} title="${escapeHtml(l.path)}">
      <div class="t-slot">
        ${l.path === state.libRoot ? '<span class="lib-flag">当前</span>' : (l.exists ? '' : '<span class="lib-flag">已丢失</span>')}
        ${l.cover ? `<img src="${fileUrl(l.cover)}" alt="">` : `<span class="cover-fallback">${l.exists ? '📚' : '⚠️'}</span>`}
      </div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</div>
        <div class="t-size">${l.exists ? `${l.catCount ?? 0} 大类 · ${l.groupCount ?? 0} 组 · ${fmtSize(l.totalSize || 0)}` : '目录已丢失'}</div>
      </div>
      ${OPS_HTML}
    </div>`).join('');
  const body = $('#preview-body');
  body.innerHTML = list.length
    ? `<div class="grid-wrap"><div class="tile-grid lib-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`
    : `<div class="preview-placeholder"><div class="big">📚</div><div>还没有任何文库</div>
        <div class="empty-sub">点击右上角「新建文库」创建第一个文库</div>
        <button id="pv-create">新建文库</button></div>`;
  const mkBtn = $('#pv-create');
  if (mkBtn) mkBtn.onclick = () => openLibCreateModal();

  bindPager(body, showLibrariesView);

  refreshDetails();
  renderBreadcrumb();
  navCommit();
}

// 右侧：全部文库的汇总信息
function showLibrariesInfo() {
  const list = state.libLibraries;
  const existsCount = list.filter(l => l.exists).length;
  const catRows = list.filter(l => l.exists).map(l =>
    detailRow(escapeHtml(l.name), `${l.catCount ?? 0} 大类 · ${l.groupCount ?? 0} 组 · ${fmtSize(l.totalSize || 0)}`)).join('');
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('视图', '📚 全部文库')}
    ${detailRow('文库数量', `${list.length} 个（${existsCount} 个可用${list.length - existsCount ? `，${list.length - existsCount} 个丢失` : ''}）`)}
    ${detailRow('大类合计', list.reduce((s, l) => s + (l.catCount || 0), 0) + ' 个')}
    ${detailRow('文件组合计', list.reduce((s, l) => s + (l.groupCount || 0), 0) + ' 个')}
    ${detailRow('占用空间', fmtSize(list.reduce((s, l) => s + (l.totalSize || 0), 0)))}
  </div>
  ${catRows ? `<div class="box-title" style="padding:10px 0 4px">各文库规模</div><div class="detail-rows">${catRows}</div>` : ''}
  <div class="hint" style="margin-top:10px">点击卡片进入文库；统计来自各文库账本，进入文库后可「重新扫描」刷新。</div>`;
}

// ---------- 中间：单个文库首页（大类卡片） ----------
function showLibraryHome() {
  const data = state.libData;
  if (!data) { state.view = 'libs'; showLibrariesView(); return; }
  state.view = 'lib';
  $('#btn-new-lib-inline').classList.add('hidden');
  $('#btn-open-external').classList.add('hidden');
  $('#preview-name').textContent = `${data.categories.length} 个大类 · ${data.categories.reduce((s, c) => s + c.groupCount, 0)} 组`;

  const cats = data.categories;
  const pages = Math.max(1, Math.ceil(cats.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = cats.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tiles = slice.map((c, i) => {
    const covers = c.groups.map(g => g.cover).filter(Boolean).slice(0, 4);
    const cells = [0, 1, 2, 3].map(k => covers[k]
      ? `<img src="${escapeHtml(covers[k])}" alt="">`
      : `<div class="m-cell">${k === 0 ? '📚' : ''}</div>`).join('');
    return `
    <div class="tile cat-tile${selClass(c.path)}" data-i="${i}"${cardDataAttr('cat', c.path, c.name)}>
      <div class="t-slot"><div class="cat-mosaic">${cells}</div></div>
      <div class="t-foot">
        <div class="cat-tile-head"><span>${escapeHtml(c.name)}</span><span class="c-count">${c.groupCount} 组</span></div>
        <div class="t-size">${fmtSize(c.totalSize)}</div>
      </div>
      ${OPS_HTML}
    </div>`;
  }).join('');
  const body = $('#preview-body');
  body.innerHTML = cats.length
    ? `<div class="grid-wrap"><div class="tile-grid cat-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`
    : `<div class="preview-placeholder"><div class="big">📭</div><div>这个文库还没有大类</div>
        <div class="empty-sub">点击左侧「新建组」时会自动创建所属大类</div></div>`;

  bindPager(body, showLibraryHome);

  refreshDetails();
  renderBreadcrumb();
  navCommit();
}

// 右侧：文库详情
function showLibraryDetails(data) {
  const reg = state.libLibraries.find(l => l.path === (data.root || state.libRoot));
  const groupCount = data.categories.reduce((s, c) => s + c.groupCount, 0);
  const fileCount = data.categories.reduce((s, c) => s + c.groups.reduce((g, x) => g + x.fileCount, 0), 0);
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('名称', escapeHtml(data.name))}
    ${detailRow('类型', '📚 文库')}
    ${detailRow('大类数量', data.categories.length + ' 个')}
    ${detailRow('文件组', groupCount + ' 个')}
    ${detailRow('文件总数', fileCount + ' 个')}
    ${detailRow('总大小', fmtSize(data.categories.reduce((s, c) => s + c.totalSize, 0)))}
    ${detailRow('账本更新', fmtDate(data.updatedAt))}
    ${detailRow('路径', escapeHtml(data.root))}
  </div>
  <button id="btn-open-lib" class="ghost-btn" style="margin-top:8px">打开文库目录</button>
  <button id="btn-lib-rescan" class="ghost-btn" style="margin-top:6px">重新扫描</button>
  ${reg ? `<div class="hint" style="margin-top:8px">点击阅览区中的大类卡片即可浏览其中的文件组。</div>` : ''}`;
  $('#btn-open-lib').onclick = () => window.api.showInFolder(data.root);
  $('#btn-lib-rescan').onclick = async () => { await loadLibrary(false); toast('已重新扫描'); };
}

// ---------- 标签筛选（左侧） ----------
function allTags() {
  const map = new Map();
  if (state.libData) for (const c of state.libData.categories)
    for (const g of c.groups) for (const t of (g.tags || []))
      if (!map.has(t.name)) map.set(t.name, t.color);
  return map;
}

function renderTagChips() {
  const box = $('#lib-tag-chips');
  const tags = allTags();
  // 只有「按标签」检索模式时才展示标签区
  box.classList.toggle('hidden', state.searchMode !== 'tag' || !tags.size);
  if (!tags.size) { box.innerHTML = ''; return; }
  let html = `<span class="tag-chip${!state.libTagFilter ? ' active' : ''}" data-tag="">全部</span>`;
  for (const [name, color] of tags)
    html += `<span class="tag-chip${state.libTagFilter === name ? ' active' : ''}" data-tag="${escapeHtml(name)}" style="--tag-c:${color}">${escapeHtml(name)}</span>`;
  box.innerHTML = html;
  box.querySelectorAll('.tag-chip').forEach(ch => ch.onclick = () => {
    state.libTagFilter = ch.dataset.tag || null;
    applyFilterView();
    renderTagChips();
    renderLibTree();
    renderCurrentView();
  });
}

function matchTag(g) {
  return !state.libTagFilter || (g.tags || []).some(t => t.name === state.libTagFilter);
}

// ---------- 文库树（左） ----------
function renderLibTree() {
  const box = $('#lib-tree');
  box.innerHTML = '';
  if (!state.libData || !state.libData.categories.length) {
    box.innerHTML = '<div class="list-empty">文库为空</div>';
    return;
  }
  for (const cat of state.libData.categories) {
    const expanded = state.libExpanded.has(cat.name);
    const catRow = document.createElement('div');
    catRow.className = 'cat-row' + (state.libSel?.type === 'category' && state.libSel.data.path === cat.path ? ' selected' : '');
    catRow.innerHTML = `<span class="cat-arrow">${expanded ? '▾' : '▸'}</span>
      <span>${ICONS['文件夹']}</span><span>${escapeHtml(cat.name)}</span>
      <span class="cat-meta">${cat.groupCount} 组 · ${fmtSize(cat.totalSize)}</span>`;
    catRow.onclick = () => {
      if (expanded) state.libExpanded.delete(cat.name);
      else state.libExpanded.add(cat.name);
      gotoCategory(cat);
    };
    box.appendChild(catRow);

    if (expanded) {
      const wrap = document.createElement('div');
      wrap.className = 'group-rows';
      const shown = cat.groups.filter(matchTag);
      if (!shown.length) {
        wrap.innerHTML = '<div class="list-empty" style="padding:6px 8px 6px 26px">暂无符合条件的组</div>';
      }
      for (const g of shown) {
        const row = document.createElement('div');
        row.className = 'group-row' + (state.libSel?.type === 'group' && state.libSel.data.path === g.path ? ' selected' : '');
        const dots = (g.tags || []).map(t => `<i class="tag-dot" style="background:${t.color}" title="${escapeHtml(t.name)}"></i>`).join('');
        row.innerHTML = `<span class="g-seq">${g.seq != null ? String(g.seq).padStart(4, '0') : '—'}</span>
          <span class="g-name" title="${escapeHtml(g.path)}">${escapeHtml(g.displayName)}</span>
          <span class="g-dotwrap">${dots}</span>
          <span class="g-meta">${g.fileCount} 文件 · ${fmtSize(g.totalSize)}</span>`;
        row.onclick = () => gotoGroup(g);
        wrap.appendChild(row);
      }
      box.appendChild(wrap);
    }
  }
}

// ---------- 大类视图（中：组预览图网格分页 + 右：大类详情） ----------
function showCategoryView(cat) {
  state.view = 'cat';
  $('#btn-new-lib-inline').classList.add('hidden');
  const groups = cat.groups.filter(matchTag);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  $('#preview-name').textContent = `大类：${cat.name} · ${groups.length} 组`;
  const tiles = slice.map((g, i) => `
    <div class="tile g-tile${selClass(g.path)}" data-i="${i}"${cardDataAttr('group', g.path, g.displayName)}>
      <div class="t-slot">
        ${g.cover ? `<img src="${escapeHtml(g.cover)}" alt="">` : '<span class="cover-fallback">📚</span>'}
        ${(g.tags && g.tags.length) ? `<div class="t-tags">${g.tags.map(t => `<i style="background:${t.color}" title="${escapeHtml(t.name)}"></i>`).join('')}</div>` : ''}
      </div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(g.displayName)}">${escapeHtml(g.displayName)}</div>
        <div class="t-size">${g.seq != null ? '#' + String(g.seq).padStart(4, '0') + ' · ' : ''}${g.fileCount} 文件 · ${fmtSize(g.totalSize)}</div>
      </div>
      ${GROUP_OPS_HTML}
    </div>`).join('');
  const body = $('#preview-body');
  body.innerHTML = groups.length
    ? `<div class="grid-wrap"><div class="tile-grid cover-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`
    : `<div class="preview-placeholder"><div class="big">📭</div><div>该大类还没有符合条件的组</div></div>`;

  bindPager(body, () => showCategoryView(cat));
  refreshDetails();
  navCommit();
}

// 大类详情（右）
function showCategoryDetails(cat) {
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('名称', escapeHtml(cat.name))}
    ${detailRow('类型', '📚 大类')}
    ${detailRow('组数量', cat.groupCount + ' 组')}
    ${detailRow('总大小', fmtSize(cat.totalSize))}
    ${detailRow('路径', escapeHtml(cat.path))}
  </div>
  <button id="btn-open-cat" class="ghost-btn" style="margin-top:8px">打开大类文件夹</button>
  <div class="hint" style="margin-top:8px">单击卡片看信息，双击进入该组</div>`;
  $('#btn-open-cat').onclick = () => window.api.showInFolder(cat.path);
}

// ---------- 搜索/分类筛选结果视图（中：文件平铺分页 + 右：统计） ----------
function getLibFiles() {
  const out = [];
  if (state.libData) for (const c of state.libData.categories)
    for (const g of c.groups)
      for (const f of g.files) out.push({ file: f, group: g, catName: c.name });
  return out;
}

let filterInfo = { list: [], kw: '', cat: '全部', tag: null };
function showFilterDetails() {
  const { list, kw, cat, tag } = filterInfo;
  const countByCat = {};
  for (const x of list) countByCat[x.file.category] = (countByCat[x.file.category] || 0) + 1;
  const catStat = Object.entries(countByCat).map(([c, n]) => detailRow(ICONS[c] + ' ' + c, n + ' 个')).join('');
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('类型', '检索结果')}
    ${kw ? detailRow('关键词', escapeHtml(kw)) : ''}
    ${cat !== '全部' ? detailRow('类型筛选', cat) : ''}
    ${tag ? detailRow('标签筛选', escapeHtml(tag)) : ''}
    ${detailRow('文件总数', list.length + ' 个')}
    ${detailRow('总大小', fmtSize(list.reduce((s, x) => s + x.file.size, 0)))}
  </div>
  ${catStat ? `<div class="box-title" style="padding:8px 0 4px">按类型</div><div class="detail-rows">${catStat}</div>` : ''}
  <div class="hint" style="margin-top:8px">单击文件查看信息，双击预览；清空搜索框返回文库浏览</div>`;
}

function showLibFilterView() {
  state.view = 'search';
  $('#btn-new-lib-inline').classList.add('hidden');
  const kw = state.libSearch.toLowerCase();
  let list = getLibFiles();
  if (state.libCatFilter !== '全部') list = list.filter(x => x.file.category === state.libCatFilter);
  if (state.libTagFilter) list = list.filter(x => (x.group.tags || []).some(t => t.name === state.libTagFilter));
  if (kw) list = list.filter(x => x.file.name.toLowerCase().includes(kw));

  filterInfo = { list, kw, cat: state.libCatFilter, tag: state.libTagFilter };

  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const conds = [state.libSearch ? `关键词“${state.libSearch}”` : null,
    state.libCatFilter !== '全部' ? `类型：${state.libCatFilter}` : null,
    state.libTagFilter ? `标签：${state.libTagFilter}` : null].filter(Boolean).join(' + ');
  $('#preview-name').textContent = `搜索结果${conds ? '：' + conds : ''} · ${list.length} 个文件`;
  const tiles = slice.map((x, i) => `
    <div class="tile f-tile${selClass(x.file.path)}" data-i="${i}"${cardDataAttr('file', x.file.path, x.file.name)}>
      <div class="t-slot with-icon"><span class="t-icon">${ICONS[x.file.category] || '📃'}</span></div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(x.file.name)}">${escapeHtml(x.file.name)}</div>
        <div class="t-size">${escapeHtml(x.group.displayName)} · ${fmtSize(x.file.size)}</div>
      </div>
      ${OPS_HTML}
    </div>`).join('');
  const body = $('#preview-body');
  body.innerHTML = list.length
    ? `<div class="grid-wrap"><div class="tile-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`
    : `<div class="preview-placeholder"><div class="big">🔍</div><div>没有匹配的文件</div><div class="empty-sub">换个关键词或类型试试</div></div>`;

  bindPager(body, showLibFilterView);
  refreshDetails();
  navCommit();
}

// ---------- 组视图（中：文件平铺 + 右：组详情含标签） ----------
function showGroupPreview(g, cat) {
  state.view = 'group';
  $('#btn-new-lib-inline').classList.add('hidden');
  $('#preview-name').textContent = `${g.displayName}${g.seq != null ? '（#' + String(g.seq).padStart(4, '0') + '）' : ''} · ${g.fileCount} 个文件`;
  const body = $('#preview-body');
  if (!g.files.length) {
    body.innerHTML = `<div class="preview-placeholder"><div class="big">📭</div>
      <div>该组还没有文件</div><div class="empty-sub">点击左侧「添加文件」导入</div></div>`;
    refreshDetails();
    navCommit();
    return;
  }
  const pages = Math.max(1, Math.ceil(g.files.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = g.files.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tiles = slice.map((f, i) => `
    <div class="tile${selClass(f.path)}" data-i="${i}"${cardDataAttr('file', f.path, f.name)}>
      <div class="t-slot with-icon"><span class="t-icon">${ICONS[f.category] || '📃'}</span></div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="t-size">${fmtSize(f.size)}</div>
      </div>
      ${OPS_HTML}
    </div>`).join('');
  body.innerHTML = `<div class="grid-wrap"><div class="tile-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`;
  bindPager(body, () => showGroupPreview(g, cat));
  refreshDetails();
  navCommit();
}


// 组详情（右）：信息 + 标签编辑 + 预览图
function showGroupDetails(g) {
  const tags = g.tags || [];
  const tagHtml = tags.length
    ? `<div class="detail-tags">${tags.map(t =>
        `<span class="tag-chip mini" style="--tag-c:${t.color}" data-rename="${escapeHtml(t.name)}" title="点击修改名称">${escapeHtml(t.name)}<i class="tag-x" data-x="${escapeHtml(t.name)}" title="删除">✕</i></span>`).join('')}</div>`
    : '<div class="hint">暂无标签，可在下方添加</div>';
  const fileList = g.files.slice(0, 30).map(f =>
    `<div class="history-item" style="cursor:default">
      <span>${ICONS[f.category] || '📃'}</span><span class="h-name">${escapeHtml(f.name)}</span>
      <span style="margin-left:auto;font-size:10.5px">${fmtSize(f.size)}</span>
    </div>`).join('');
  const dateStr = g.date ? `${g.date.slice(0, 4)}-${g.date.slice(4, 6)}-${g.date.slice(6, 8)}` : null;
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('序号', g.seq != null ? String(g.seq).padStart(4, '0') + (dateStr ? '（' + dateStr + '）' : '') : '未编号')}
    ${detailRow('名称', escapeHtml(g.displayName))}
    ${detailRow('文件数', g.fileCount + ' 个')}
    ${detailRow('总大小', fmtSize(g.totalSize))}
    ${detailRow('修改时间', fmtDate(g.mtime))}
    ${detailRow('所属大类', escapeHtml(parentName(g.path)))}
    ${detailRow('预览图', g.cover ? escapeHtml(baseName(g.cover)) : '自动（组内第一张图片）')}
    ${detailRow('路径', escapeHtml(g.path))}
  </div>
  <button id="btn-open-group" class="ghost-btn" style="margin-top:8px">打开组文件夹</button>
  <div class="box-title" style="padding:10px 0 4px">标签</div>
  ${tagHtml}
  <div class="tag-add-row">
    <input id="tag-input" placeholder="输入标签，回车添加" spellcheck="false">
    <button id="btn-add-tag">添加</button>
  </div>
  <button id="btn-set-cover" class="ghost-btn" style="margin-top:8px">设置预览图</button>
  ${g.files.length ? `<div class="box-title" style="padding:10px 0 4px">组内文件（前 ${Math.min(30, g.files.length)} 个）</div>
    <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;max-height:36%;overflow-y:auto">${fileList}</div>`
    : '<div class="hint" style="margin-top:10px">组内暂无文件，点击「添加文件到组」</div>'}`;

  $('#btn-open-group').onclick = () => window.api.showInFolder(g.path);

  const commitTags = async (names) => { await setGroupTags(g, names); };
  const addTag = () => {
    const v = $('#tag-input').value.trim();
    if (!v) return;
    $('#tag-input').value = '';
    commitTags([...tags.map(t => t.name), v]);
  };
  $('#btn-add-tag').onclick = addTag;
  bindEnter($('#tag-input'), addTag);          // 回车添加（拼音选字时不触发）
  const box = $('#detail-body');
  box.querySelectorAll('[data-x]').forEach(x => x.onclick = ev => {
    ev.stopPropagation();
    const name = x.dataset.x;
    showModal('删除标签', `<div class="hint">确定从「<b>${escapeHtml(g.displayName)}</b>」删除标签「<b>${escapeHtml(name)}</b>」？</div>`, async () => {
      commitTags(tags.map(t => t.name).filter(n => n !== name));
    }, '删除');
  });
  box.querySelectorAll('[data-rename]').forEach(ch => ch.onclick = ev => {
    if (ev.target.classList.contains('tag-x')) return;
    const old = ch.dataset.rename;
    showModal('修改标签', `
      <label class="field-label">标签名称</label>
      <input id="m-input" value="${escapeHtml(old)}" spellcheck="false">`, async () => {
      const v = $('#m-input').value.trim();
      if (!v || v === old) return;
      commitTags(tags.map(t => t.name === old ? v : t.name));
    }, '保存');
  });
  $('#btn-set-cover').onclick = async () => {
    const files = await pickFilesSafe();
    if (!files || !files.length) return;
    const r = await window.api.libSetCover(state.libRoot, g.path, files[0]);
    if (r.error) { toast(r.error, true); return; }
    g.cover = r.group.cover;
    toast('预览图已更新');
    renderLibTree();
    if (state.libSel?.type === 'category') showCategoryView(state.libSel.data);
  };
}

// ---------- 文库工具按钮 ----------
$('#btn-rescan').onclick = () => loadLibrary(false);

$('#btn-lib-switch').onclick = () => openLibSwitchModal();
$('#btn-new-lib-inline').onclick = () => openLibCreateModal();
$('#btn-open-lib-root').onclick = () => {
  if (!state.libRoot) { toast('请先创建或选择一个文库', true); return; }
  window.api.showInFolder(state.libRoot);
};

function openLibCreateModal(prev = {}) {
  showModal('新建文库', `
    <label class="field-label">位置</label>
    <div class="search-row"><input id="m-lib-path" placeholder="点击右侧「选择…」指定创建位置" readonly value="${escapeHtml(prev.path || '')}"><button id="m-lib-pick" type="button">选择…</button></div>
    <label class="field-label">文库名称</label>
    <input id="m-lib-name" placeholder="例如：我的漫画库" spellcheck="false" value="${escapeHtml(prev.name || '')}">
    <div class="hint">将在所选位置创建以名称命名的文件夹，内含默认大类（漫画/小说）与独立账本</div>`, async () => {
    const parentPath = $('#m-lib-path').value.trim();
    const name = $('#m-lib-name').value.trim();
    if (!parentPath) { toast('请先选择创建位置', true); return true; }
    if (!name) { toast('请输入文库名称', true); return true; }
    const r = await window.api.libCreate(parentPath, name);
    if (r.error) { toast(r.error, true); return true; }
    state.libRoot = r.path;
    localStorage.setItem('fm_lib_root', r.path);
    state.libSel = null;
    state.libExpanded.clear();
    state.libTagFilter = null;
    state.libPageNum = 1;
    clearLibFilters();
    toast(`文库已创建：${r.path}`);
    state.view = 'lib';
    await loadLibrary();
    renderBreadcrumb();
  }, '创建');
  $('#m-lib-pick').onclick = async () => {
    const curName = $('#m-lib-name') ? $('#m-lib-name').value.trim() : (prev.name || '');
    const p = await pickFolderSafe();
    if (p) openLibCreateModal({ path: p, name: curName });
  };
}
$('#btn-lib-new').onclick = () => openLibCreateModal();

function openLibMigrateModal(prev = {}) {
  const libName = baseName(state.libRoot);
  showModal('迁移文库', `
    <div class="hint">将把文库「<b>${escapeHtml(libName)}</b>」整体移动到新位置：所有文件与账本（含标签/预览图）一起移动，迁移后原位置不再保留。</div>
    <label class="field-label">目标位置</label>
    <div class="search-row"><input id="m-lib-path" placeholder="点击右侧「选择…」指定目标位置" readonly value="${escapeHtml(prev.path || '')}"><button id="m-lib-pick" type="button">选择…</button></div>`,
    async () => {
      const newParent = $('#m-lib-path').value.trim();
      if (!newParent) { toast('请先选择目标位置', true); return true; }
      const r = await window.api.libMigrate(state.libRoot, newParent);
      if (r.error) { toast(r.error, true); return true; }
      state.libRoot = r.path;
      localStorage.setItem('fm_lib_root', r.path);
      state.libSel = null;
      state.libExpanded.clear();
      state.libPageNum = 1;
      clearLibFilters();
      toast(`文库迁移完成：${r.path}`);
      state.view = 'lib';
      await loadLibrary();
      renderBreadcrumb();
    }, '开始迁移');
  $('#m-lib-pick').onclick = async () => {
    const p = await pickFolderSafe();
    if (p) openLibMigrateModal({ path: p });
  };
}
$('#btn-lib-migrate').onclick = () => {
  if (!state.libRoot) { toast('请先选择要迁移的文库', true); return; }
  openLibMigrateModal();
};

$('#btn-new-group').onclick = () => {
  if (!state.libData) { toast('请先创建或选择文库', true); return; }
  const opts = state.libData.categories.map(c =>
    `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}（${c.groupCount} 组）</option>`).join('');
  showModal('新建文件组', `
    <label class="field-label">所属大类</label>
    <select id="m-cat">${opts}</select>
    <label class="field-label">组名称</label>
    <input id="m-input" placeholder="例如：海贼王" spellcheck="false">
    <div class="hint">文件夹命名：<b>日期(8位)_序号(4位)_组名</b>，如 <b>20261027_0001_海贼王</b>；序号同日接续，隔日从 1 重新开始</div>`, async () => {
    const catName = $('#m-cat').value;
    const name = $('#m-input').value.trim();
    if (!name) { toast('请输入组名称', true); return true; }
    const r = await window.api.libCreateGroup(state.libRoot, catName, name);
    if (r.error) { toast(r.error, true); return true; }
    toast(`已创建组：${r.path}`);
    await loadLibrary();
    state.libExpanded.add(catName);
    const cat = state.libData.categories.find(c => c.name === catName);
    const g = cat?.groups.find(x => x.path === r.path);
    if (g) {
      state.libSel = { type: 'group', data: g };
      showGroupPreview(g, cat);
      showGroupDetails(g);
      renderLibTree();
      renderBreadcrumb();
    }
  }, '创建');
};

$('#btn-add-to-group').onclick = async () => {
  if (state.libSel?.type !== 'group') { toast('请先在文库树或卡片中选中一个组', true); return; }
  const g = state.libSel.data;
  const files = await pickFilesSafe();
  if (!files || !files.length) return;
  const r = await window.api.libAddFiles(g.path, files);
  if (r.error) { toast(r.error, true); return; }
  if (r.failed.length) toast(`${r.failed.length} 个失败：${r.failed[0].reason}`, true);
  else toast(`已添加 ${r.done.length} 个文件到「${g.displayName}」（${g.path}）`);
  await loadLibrary();
  const ng = findGroup(state.libData, g.path);
  if (ng) {
    state.libSel = { type: 'group', data: ng };
    showGroupPreview(ng);
    showGroupDetails(ng);
    renderLibTree();
    renderBreadcrumb();
  }
};

// ---------- 阅览区全屏 ----------
const previewPanel = $('#preview-panel');
const fsBtn = $('#btn-fullscreen');
function setFullscreen(on) {
  previewPanel.classList.toggle('fs-fullscreen', on);
  fsBtn.textContent = on ? '退出全屏' : '全屏';
}
fsBtn.onclick = () => setFullscreen(!previewPanel.classList.contains('fs-fullscreen'));

// ---------- 可拖拽分隔条 ----------
function setupSplitter(handleId, panelId, side, storageKey) {
  const handle = $(handleId);
  const panel = $(panelId);
  const saved = localStorage.getItem(storageKey);
  if (saved) panel.style.setProperty(side, saved + 'px');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const onMove = (ev) => {
      const delta = ev.clientX - startX;
      const w = Math.min(560, Math.max(190, side === '--left-w' ? startW + delta : startW - delta));
      panel.style.setProperty(side, w + 'px');
      panel.style.flexBasis = w + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(storageKey, parseInt(panel.getBoundingClientRect().width));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
setupSplitter('#split-left', '#left-panel', '--left-w', 'fm_left_w');
setupSplitter('#split-right', '#detail-panel', '--right-w', 'fm_right_w');

// ---------- 键盘 ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideModal(); setFullscreen(false); }
});

// ---------- 启动 ----------
(async function init() {
  state.homeDirs = await window.api.homeDirs();
  applyHistoryHidden();
  renderSearchMode();
  buildCatChips();
  renderHistory();
  await loadLibList();
  // 启动首屏：中间区域直接显示全部文库
  state.view = 'libs';
  showLibrariesView();
  // 后台静默加载上次使用的文库，供左侧目录与检索直接使用（不抢占首屏）
  if (state.libRoot) {
    (async () => { await loadLibrary(true); renderBreadcrumb(); })();
  }
})();
