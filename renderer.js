/* 渲染进程逻辑：三栏布局，启动时中间区显示所有文库 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
let batchState = null;  // 批量添加表单状态（独立于 DOM，选择器可能临时占用通用弹窗）

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
  // 「最近添加」：通过「添加文件 / 批量添加」导入文库的文件，最多 10 条
  recentAdded: JSON.parse(localStorage.getItem('fm_recent_added') || '[]'),
  recentHidden: localStorage.getItem('fm_recent_hidden') === '1',
  historyHidden: localStorage.getItem('fm_history_hidden') === '1',
  // 中间阅览区当前视图：libs 全部文库 | lib 单个文库首页 | cat 大类 | group 组 | search 检索结果
  view: 'libs',
  // 检索方式：cat 按分类 | tag 按标签 | author 按作者（三态循环）
  searchMode: ['cat', 'tag', 'author'].includes(localStorage.getItem('fm_search_mode'))
    ? localStorage.getItem('fm_search_mode') : 'cat',
  // 跨库综合检索（v0.4.3 搜索功能区）：范围为全部文库
  advName: '',                                        // 按名称关键词
  advLevels: new Set(['group', 'file']),              // 搜索层级（组 / 文件，可多选）
  advTagOn: false, advTags: [],                       // 标签附加条件（需同时满足）
  advAuthorOn: false, advAuthors: [],                 // 作者附加条件（需同时满足）
  advBankTags: [], advBankAuthors: [],                // 跨库已有标签 / 作者候选
  searchPageNum: 1,                                    // 搜索结果当前页（每页 20 条）
  advBankTagPage: 1, advBankAuthorPage: 1,             // 搜索附加条件候选列表当前页（每页 25 个）
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
  libGroupsExpanded: new Set(), // 左栏「文库目录」中已展开显示全部组的大类（key = cat.path）
  libTagFilter: null,           // 标签筛选（标签名）
  libAuthorFilter: null,        // 作者筛选（作者名，仅组级结果）
  libSearch: '',                // 文库内搜索关键词
  libCatFilter: '全部',         // 文库内类型筛选
  libPageNum: 1,                // 大类组网格当前页
  libPreviewFile: null,         // 正在预览的文件（组内或搜索结果）
  // 左侧功能导航当前区块：dashboard 仪表盘 | workbench 文库操作 | search 搜索 | records 记录
  // 每次启动都从「文库操作」开始，不记忆上次选择
  section: 'workbench',
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
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 颜色白名单：主进程落盘时已过滤一遍，这里再兜一层（账本可能由旧版本写出）。
// 非法值一律按标签名重新分配，绝不让账本里的字符串直接进 style 属性。
function safeTagColor(c, name) {
  const s = String(c == null ? '' : c).trim();
  const hex = s.startsWith('#') ? s.slice(1) : '';
  return /^[0-9a-fA-F]+$/.test(hex) && [3, 4, 6, 8].includes(hex.length) ? s : metaTagColor(name);
}
// ---------- 维护信息：只属于「组」（作者 / 标签） ----------
// v0.4.2 起文库 / 大类 / 文件都不再拥有维护信息，也没有继承关系：
// 账本 meta 只存组级键，组的作者 / 标签即为组内文件的作者 / 标签。
const META_TAG_COLORS = ['#e74c3c', '#e67e22', '#d4a017', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63'];
function metaTagColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return META_TAG_COLORS[h % META_TAG_COLORS.length];
}
function ownMeta(rel) {
  const mm = state.libData && state.libData.meta ? state.libData.meta : null;
  return (mm && mm[rel || '']) || { author: [], tags: [] };
}
// 文件 / 组 → 其所属组的 rel（'大类/组/文件' 或 '大类/组' → '大类/组'）
function groupRelOf(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  return parts.slice(0, 2).join('/');
}
function metaChain(rel) { return [groupRelOf(rel)]; }
// 组级有效信息：作者 / 标签直接取所属组自己填的值，无上级继承。
function effectiveMeta(rel) {
  const m = ownMeta(groupRelOf(rel));
  const authors = metaListSafe(m.author);
  const tags = (m.tags || []).map(x => {
    const name = typeof x === 'string' ? x : (x && x.name);
    const color = safeTagColor(typeof x === 'string' ? '' : x.color, name);
    return { name, color };
  }).filter(x => x.name).sort((a, b) => tagCompare(a.name, b.name));
  return { authors, tags };
}
function metaListSafe(v) {
  return [...new Set((Array.isArray(v) ? v : [v])
    .map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
}
function tagHit(rel, name) {
  return !!name && effectiveMeta(rel).tags.some(x => x.name === name);
}
function metaListHTML(list) {
  if (!list.length) return '<span class="meta-empty">空</span>';
  return list.map(x => escapeHtml(x.value || x)).join('、');
}
function metaTagsHTML(tags) {
  if (!tags.length) return '<span class="meta-empty">空</span>';
  return `<span class="detail-tags">${tags.map(x =>
    `<span class="tag-chip mini" style="--tag-c:${safeTagColor(x.color, x.name)}">${escapeHtml(x.name)}</span>`
  ).join('')}</span>`;
}
// 组维护信息：作者 + 标签两行（无来源、无继承标记）
function metaRowsHTML(authors, tags) {
  return `<div class="detail-rows">
    <div class="detail-row"><span class="d-label">作者</span><span class="d-value">${metaListHTML(authors)}</span></div>
    <div class="detail-row"><span class="d-label">标签</span><span class="d-value">${metaTagsHTML(tags)}</span></div>
  </div>`;
}
// 组详情：统计信息之外固定显示 2 类维护信息，未填写显示「空」
function metaBlockHTML(rel, name) {
  const eff = effectiveMeta(rel);
  return `<div class="box-title" style="padding:10px 0 4px">维护信息</div>
    ${metaRowsHTML(eff.authors, eff.tags)}
    <button id="btn-edit-meta" class="ghost-btn" style="margin-top:8px">编辑信息</button>`;
}
// 标签统一按名称排序（中文拼音 + 数字按数值），与添加标签的先后顺序无关。
// 与主进程同名规则保持一致；末尾码点比较兜底，保证顺序确定。
function tagCompare(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  return x.localeCompare(y, 'zh', { numeric: true }) || (x < y ? -1 : x > y ? 1 : 0);
}
function sortTagNames(list) {
  return [...new Set((list || [])
    .map(x => typeof x === 'string' ? x : ((x && x.name) || ''))
    .map(x => String(x).trim()).filter(Boolean))].sort(tagCompare);
}
function splitMetaList(v) {
  return sortTagNames(String(v || '').split(/[、,，;；\n]+/));
}
// ---------- 跨文库标签库：「添加已有标签」多选 ----------
// 标签库存放在各个文库目录里，主进程按「当前仍在使用的标签」汇总并集后经 libTagBanks 返回。
// 每个编辑弹窗打开时重新拉一次，保证刚在别的文库加过的标签立刻可见、删掉的标签立刻消失。
let tagBankData = [];
async function refreshTagBanks() {
  const r = await window.api.libTagBanks();
  tagBankData = (r && Array.isArray(r.tags))
    ? [...r.tags].sort((a, b) => tagCompare(a.name, b.name)) : [];
  return tagBankData;
}
function tagBankChipHTML(t, selected) {
  const libs = (t.libs || []).join('、');
  return `<span class="tag-chip tb-chip${selected ? ' active' : ''}" data-tb="${escapeHtml(t.name)}" `
    + `style="--tag-c:${metaTagColor(t.name)}" title="${escapeHtml(libs ? '来自：' + libs : '已有标签')}">`
    + `${escapeHtml(t.name)}</span>`;
}
function tagBankSectionHTML(query, hint) {
  return `<div class="tb-box">
    <div class="tb-head"><span class="tb-title">添加已有标签（可多选）</span><span class="tb-count" id="tb-count"></span></div>
    <div class="tb-row">
      <input id="tb-search" placeholder="按关键字筛选标签" value="${escapeHtml(query || '')}" spellcheck="false">
      <button id="tb-refresh" type="button">刷新</button>
    </div>
    <div class="tb-list" id="tb-list"></div>
    <div id="tb-pager"></div>
    <div class="hint">${hint || '候选是各文库当前仍在使用的标签（按名称排序）；点一下加入，再点一下移除。'}</div>
  </div>`;
}
// 通用绑定：不同弹窗靠 getNames / setNames 适配，真源始终是各自的标签集合。
//   · 普通编辑框：真源是「、」分隔的文本框
//   · 批量添加：真源是 batchState.tags（setNames 里整表重绘）
//   · single：改名弹窗，点一个标签就把输入框换成这个名字
function bindTagBankSection(opts) {
  const { getNames, setNames, single, scope, onAfter, onQuery, getPage, setPage } = opts;
  const rootEl = scope || document;
  const search = rootEl.querySelector('#tb-search');
  const list = rootEl.querySelector('#tb-list');
  const pager = rootEl.querySelector('#tb-pager');
  const count = rootEl.querySelector('#tb-count');
  if (!list) return () => {};
  // 页码：外部可托管（批量添加整表重绘时保留页码），否则用局部状态
  let localPage = 1;
  const gp = getPage || (() => localPage);
  const sp = setPage || ((v) => { localPage = v; });
  const paint = () => {
    const q = (search ? search.value : '').trim().toLowerCase();
    const cur = getNames();
    const shown = tagBankData.filter(t => !q || t.name.toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(shown.length / CHIP_PAGE_SIZE));
    let page = gp();
    if (page > pages) { page = pages; sp(page); }
    if (page < 1) { page = 1; sp(page); }
    const slice = shown.slice((page - 1) * CHIP_PAGE_SIZE, page * CHIP_PAGE_SIZE);
    list.innerHTML = slice.length
      ? slice.map(t => tagBankChipHTML(t, cur.includes(t.name))).join('')
      : `<span class="hint">${tagBankData.length ? '没有匹配这个关键字的标签' : '还没有任何文库记录过标签，先在上方手动输入几个吧'}</span>`;
    if (pager) {
      pager.innerHTML = chipPagerHTML(page, pages, 'tbbpg');
      bindChipPager(pager, 'tbbpg', gp, sp, paint);
    }
    if (count) count.textContent = tagBankData.length
      ? `共 ${tagBankData.length} 个 · 已选 ${cur.length} 个` : '';
    list.querySelectorAll('.tb-chip').forEach(chip => {
      chip.onclick = () => {
        const name = chip.dataset.tb;
        const names = getNames();
        const hit = names.includes(name);
        const next = single ? [name]
          : sortTagNames(hit ? names.filter(n => n !== name) : [...names, name]);
        setNames(next);
        if (onAfter) onAfter(); else paint();
      };
    });
  };
  if (search) {
    search.addEventListener('input', () => { sp(1); if (onQuery) onQuery(search.value); paint(); });
    // 搜索框里的回车只用于筛选，不要连带触发弹窗的「确定」
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposing(e)) e.preventDefault(); });
  }
  const btn = rootEl.querySelector('#tb-refresh');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try { await refreshTagBanks(); paint(); }
    catch (err) { toast('读取标签库失败：' + (err && err.message ? err.message : err), true); }
    finally { btn.disabled = false; }
  };
  paint();
  return paint;
}

// ---------- 跨文库作者库：「添加已有作者」多选（与标签库同款） ----------
let authorBankData = [];
async function refreshAuthorBanks() {
  const r = await window.api.libAuthorBanks();
  authorBankData = (r && Array.isArray(r.authors))
    ? [...r.authors].sort((a, b) => tagCompare(a.name, b.name)) : [];
  return authorBankData;
}
function authorBankSectionHTML(query, hint) {
  return `<div class="tb-box">
    <div class="tb-head"><span class="tb-title">添加已有作者（可多选）</span><span class="tb-count" id="ab-count"></span></div>
    <div class="tb-row">
      <input id="ab-search" placeholder="按关键字筛选作者" value="${escapeHtml(query || '')}" spellcheck="false">
      <button id="ab-refresh" type="button">刷新</button>
    </div>
    <div class="tb-list" id="ab-list"></div>
    <div id="ab-pager"></div>
    <div class="hint">${hint || '候选是各文库当前仍在使用的作者（按名称排序）；点一下加入，再点一下移除。'}</div>
  </div>`;
}
// 与 bindTagBankSection 同构，真源是各自传来的名字集合（作者用「、」分隔文本框 / batchState.author）。
function bindAuthorBankSection(opts) {
  const { getNames, setNames, scope, onAfter, onQuery, getPage, setPage } = opts;
  const rootEl = scope || document;
  const search = rootEl.querySelector('#ab-search');
  const list = rootEl.querySelector('#ab-list');
  const pager = rootEl.querySelector('#ab-pager');
  const count = rootEl.querySelector('#ab-count');
  if (!list) return () => {};
  let localPage = 1;
  const gp = getPage || (() => localPage);
  const sp = setPage || ((v) => { localPage = v; });
  const paint = () => {
    const q = (search ? search.value : '').trim().toLowerCase();
    const cur = getNames();
    const shown = authorBankData.filter(t => !q || t.name.toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(shown.length / CHIP_PAGE_SIZE));
    let page = gp();
    if (page > pages) { page = pages; sp(page); }
    if (page < 1) { page = 1; sp(page); }
    const slice = shown.slice((page - 1) * CHIP_PAGE_SIZE, page * CHIP_PAGE_SIZE);
    list.innerHTML = slice.length
      ? slice.map(t => {
        const libs = (t.libs || []).join('、');
        const sel = cur.includes(t.name);
        return `<span class="tag-chip tb-chip${sel ? ' active' : ''}" data-ab="${escapeHtml(t.name)}" `
          + `title="${escapeHtml(libs ? '来自：' + libs : '已有作者')}">${escapeHtml(t.name)}</span>`;
      }).join('')
      : `<span class="hint">${authorBankData.length ? '没有匹配这个关键字的作者' : '还没有任何文库记录过作者，先在上方手动输入几个吧'}</span>`;
    if (pager) {
      pager.innerHTML = chipPagerHTML(page, pages, 'abbpg');
      bindChipPager(pager, 'abbpg', gp, sp, paint);
    }
    if (count) count.textContent = authorBankData.length
      ? `共 ${authorBankData.length} 个 · 已选 ${cur.length} 个` : '';
    list.querySelectorAll('.tb-chip').forEach(chip => {
      chip.onclick = () => {
        const name = chip.dataset.ab;
        const names = getNames();
        const next = sortTagNames(names.includes(name) ? names.filter(n => n !== name) : [...names, name]);
        setNames(next);
        if (onAfter) onAfter(); else paint();
      };
    });
  };
  if (search) {
    search.addEventListener('input', () => { sp(1); if (onQuery) onQuery(search.value); paint(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposing(e)) e.preventDefault(); });
  }
  const btn = rootEl.querySelector('#ab-refresh');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try { await refreshAuthorBanks(); paint(); }
    catch (err) { toast('读取作者库失败：' + (err && err.message ? err.message : err), true); }
    finally { btn.disabled = false; }
  };
  paint();
  return paint;
}

// 通用的编辑入口（仅组级）：只改本组自己填的作者 / 标签。
function bindMetaEdit(rel, name, root) {
  const btn = $('#btn-edit-meta');
  if (!btn || rel == null) return;
  btn.onclick = async () => {
    try { await Promise.all([refreshTagBanks(), refreshAuthorBanks()]); }
    catch { tagBankData = []; authorBankData = []; }
    const own = ownMeta(rel);
    const body = `
      <label class="field-label">作者（多个用「、」分隔，留空表示不填写）</label>
      <input id="m-author" value="${escapeHtml(metaListSafe(own.author).join('、'))}" spellcheck="false">
      ${authorBankSectionHTML('', '候选是各文库当前仍在使用的作者；点一下加入、再点一下移除，也可以直接在上方输入新作者。')}
      <label class="field-label">标签（多个用「、」分隔）</label>
      <input id="m-tags" value="${escapeHtml(sortTagNames(own.tags || []).join('、'))}" spellcheck="false">
      ${tagBankSectionHTML('', '候选是各文库当前仍在使用的标签；点一下加入、再点一下移除，也可以直接在上方输入新标签。')}
      <div class="hint">这里只修改「${escapeHtml(name || '')}」这一组的作者 / 标签，保存后立即生效。</div>`;
    showModal(`编辑信息 · ${name || ''}`, body, async () => {
      const patch = {
        author: splitMetaList($('#m-author') ? $('#m-author').value : ''),
        tags: splitMetaList($('#m-tags') ? $('#m-tags').value : '')
      };
      const r = await window.api.libSetMeta(root || state.libRoot, rel, 'group', patch);
      if (r && r.error) { toast(r.error, true); return true; }
      toast('已保存');
      if ((root || state.libRoot) === state.libRoot) await loadLibrary(true);
      else await loadLibList();
      renderTagChips();
      renderAuthorChips();
      refreshDetails();
      return;
    }, '保存');
    // 选取候选等价于往对应文本框里增删一项，保存逻辑完全不变
    const repaintTags = bindTagBankSection({
      getNames: () => splitMetaList($('#m-tags') ? $('#m-tags').value : ''),
      setNames: (ns) => { const el = $('#m-tags'); if (el) el.value = sortTagNames(ns).join('、'); }
    });
    const repaintAuthors = bindAuthorBankSection({
      getNames: () => splitMetaList($('#m-author') ? $('#m-author').value : ''),
      setNames: (ns) => { const el = $('#m-author'); if (el) el.value = sortTagNames(ns).join('、'); }
    });
    const tagInput = $('#m-tags');
    if (tagInput) tagInput.addEventListener('input', repaintTags);
    const authorInput = $('#m-author');
    if (authorInput) authorInput.addEventListener('input', repaintAuthors);
  };
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

// ---------- 缩略图（v0.4.6：图片 + 视频）----------
// 卡片 HTML 里给图片/视频文件的 .t-slot 加 data-thumb=源路径；渲染后异步填充。
// 缩略图由主进程按需生成并缓存，失败时保留原图标（降级）。
let thumbSeq = 0;
let thumbSuppress = false;   // 清除缓存后的那次重绘：只回退图标，不重新生成
async function hydrateThumbs(body) {
  if (thumbSuppress) return;
  if (!body || !window.api || !window.api.thumbBatch) return;
  const slots = Array.from(body.querySelectorAll('.t-slot[data-thumb]'));
  if (!slots.length) return;
  const mySeq = ++thumbSeq;
  const srcs = slots.map(s => s.getAttribute('data-thumb'));
  let map;
  try { map = await window.api.thumbBatch(srcs); } catch { return; }
  if (mySeq !== thumbSeq) return;   // 视图已切换，丢弃过期结果
  slots.forEach(s => {
    const tp = map && map[s.getAttribute('data-thumb')];
    if (!tp || !s.isConnected) return;
    s.classList.remove('with-icon');
    s.innerHTML = `<img src="${fileUrl(tp)}" alt="">`;
  });
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
function showModal(title, bodyHTML, onOK, okText = '确定', onCancel = null, opts = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-ok').textContent = okText;
  $('#modal-ok').disabled = false;
  // 宽屏模式用于内容较多的表单（如「批量添加」）
  $('#modal').classList.toggle('wide', !!opts.wide);
  $('#modal-mask').classList.remove('hidden');
  if (!opts.noFocus) {
    const first = $('#modal-body input, #modal-body select');
    if (first) setTimeout(() => first.focus(), 30);
  }
  $('#modal-ok').onclick = async () => {
    const keepOpen = await onOK();
    if (!keepOpen) hideModal();
  };
  $('#modal-cancel').onclick = () => { hideModal(); if (onCancel) onCancel(); };
  // 输入框内按 Enter 直接触发确定（输入法选字过程中不触发，避免把候选词选择当成确定）。
  // 多项表单通过 opts.enterOK=false 关掉这个行为，由表单自己处理回车。
  if (opts.enterOK !== false) {
    // 标签库搜索框只做筛选，回车不该连带触发弹窗的「确定」
    $('#modal-body').querySelectorAll('input:not(#tb-search)').forEach(inp => {
      bindEnter(inp, () => $('#modal-ok').click());
    });
  }
}
function hideModal() { $('#modal-mask').classList.add('hidden'); }
$('#modal-mask').addEventListener('mousedown', (e) => {
  if (e.target.id !== 'modal-mask' || $('#modal').classList.contains('wide')) return;
  hideModal();
  // 内置选择器被点空白关闭时，恢复批量添加表单
  if (batchState && !batchState.busy) setTimeout(() => { if (batchState && $('#modal-mask').classList.contains('hidden')) renderBatchForm(); }, 0);
  if (batchGroupState && !batchGroupState.busy) setTimeout(() => { if (batchGroupState && $('#modal-mask').classList.contains('hidden')) renderBatchGroupForm(); }, 0);
});

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
// 多选文件夹（「批量添加（组）」用）：系统对话框可一次挑多个，失败则回退内置多选
async function pickFoldersSafe() {
  try {
    if (typeof window.api.pickFolders !== 'function') throw new Error('no pickFolders');
    const dirs = await window.api.pickFolders();
    if (dirs && dirs.length) return dirs;
  } catch {}
  return inlinePickFolders();
}
// 内置多选文件夹选择器：点文件夹名进入，点左侧「＋选为组」把当前目录加入
function inlinePickFolders() {
  return new Promise((resolve) => {
    let cur = state.homeDirs.home || '/';
    const picked = new Set();
    showModal('选择文件夹（可多选）', `
      <div class="ip-path-row">
        <button id="ip-up" type="button">上一级</button>
        <span id="ip-cur" class="ip-cur"></span>
      </div>
      <div id="ip-list" class="ip-list"></div>
      <div id="ip-count" class="hint"></div>
      <div class="ba-tools" style="margin-top:8px"><button id="ip-add" type="button">＋ 选为组（当前文件夹）</button></div>`,
      () => { resolve([...picked]); }, '确定',
      () => resolve(null));
    const paintCount = () => {
      const el = $('#ip-count');
      if (el) el.textContent = `已选 ${picked.size} 个文件夹（点文件夹名进入子目录，点上方按钮把当前文件夹加入）`;
    };
    const render = async () => {
      $('#ip-cur').textContent = cur;
      paintCount();
      const list = $('#ip-list');
      const res = await window.api.list(cur);
      if (res.error) { list.innerHTML = `<div class="hint">${escapeHtml(res.error)}</div>`; return; }
      const dirs = res.entries.filter(x => x.isDir);
      list.innerHTML = dirs.length
        ? dirs.map(d => `<div class="ip-item" data-p="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</div>`).join('')
        : '<div class="hint" style="padding:8px">没有子文件夹，可直接点上方按钮选当前文件夹</div>';
      list.querySelectorAll('.ip-item').forEach(item => { item.onclick = () => { cur = item.dataset.p; render(); }; });
    };
    $('#ip-up').onclick = () => { if (cur !== '/') { cur = parentOf(cur); render(); } };
    $('#ip-add').onclick = () => { picked.add(cur); paintCount(); };
    render();
  });
}

// ---------- 打开文件（系统默认程序） ----------
async function openEntry(e) {
  if (e.isDir) { toast('请在文库树中浏览文件夹'); return; }
  const r = await window.api.open(e.path);
  if (r && r.error) { toast(r.error, true); return; }
  if (r && r.canceled) return;                 // 用户取消了可执行文件确认框
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
$('#btn-clear-history').onclick = () => clearHistoryRecords();
function clearHistoryRecords() {
  if (!state.openHistory.length) { toast('历史记录已经是空的'); return; }
  showModal('清空历史记录', `<div class="hint">确定清空全部 ${state.openHistory.length} 条历史记录？此操作不可恢复。</div>`, async () => {
    state.openHistory = [];
    localStorage.setItem('fm_open_history', '[]');
    renderHistory();
    if (state.section === 'records') renderRecordsStage();
    toast('历史记录已清空');
  }, '清空');
}

// ---------- 最近添加（导入文库的文件，最多 10 条） ----------
function catOfPath(p) {
  const ext = String(p || '').split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'tiff', 'ico'].includes(ext)) return '图片';
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'].includes(ext)) return '视频';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) return '音频';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(ext)) return '压缩包';
  if (TEXT_EXTS.has(ext)) return '文档';
  return '其他';
}
// paths: 落地后的绝对路径数组；libName: 所属文库名
function addRecentAdded(paths, libNameOrRoot) {
  const arr = Array.isArray(paths) ? paths : [];
  if (!arr.length) return;
  // 允许传库名或库根目录路径；路径则从注册表解析出名字
  let libName = libNameOrRoot || '';
  if (libName && /[\\/]/.test(libName)) {
    const hit = (state.libLibraries || []).find(l => l.path === libName);
    libName = hit ? hit.name : libName.split(/[\\/]/).pop();
  }
  const now = Date.now();
  for (const p of arr) {
    if (!p) continue;
    state.recentAdded = state.recentAdded.filter(x => x.path !== p);
    state.recentAdded.unshift({
      path: p, name: p.split(/[\\/]/).pop(), category: catOfPath(p),
      libName: libName || '', at: now
    });
  }
  if (state.recentAdded.length > 10) state.recentAdded.length = 10;
  localStorage.setItem('fm_recent_added', JSON.stringify(state.recentAdded));
  if (state.section === 'records') renderRecordsStage();
}
function clearRecentAdded() {
  if (!state.recentAdded.length) { toast('「最近添加」已经是空的'); return; }
  showModal('清空最近添加', `<div class="hint">确定清空全部 ${state.recentAdded.length} 条「最近添加」记录？此操作只清记录，不会删除文件。</div>`, async () => {
    state.recentAdded = [];
    localStorage.setItem('fm_recent_added', '[]');
    if (state.section === 'records') renderRecordsStage();
    toast('「最近添加」已清空');
  }, '清空');
}

// ---------- 分类筛选 chips（兼容旧逻辑，v0.4.3 起不再显示） ----------
function buildCatChips() {
  const box = $('#cat-chips');
  // 这些旧 chips 容器只存在于搜索功能区，已由「按标签 / 按作者」附加条件控件取代。
  // 旧逻辑会按 state.searchMode 把它们显示出来，导致未勾选时也冒出一批标签，故强制常隐。
  if (box) box.classList.add('hidden');
  if (!box) return;
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

// ---------- 跨库综合检索（v0.4.3 搜索功能区） ----------
// 搜索范围为全部文库：名称（组 / 文件）+ 标签 / 作者附加条件，全部为 AND。
$('#btn-search').onclick = runAdvSearch;
bindEnter($('#search-input'), runAdvSearch);              // 回车搜索
bindLiveInput($('#search-input'), runAdvSearch);         // 边打字边搜（等中文上屏后再搜）
function runLibSearch() { return runAdvSearch(); }        // 兼容旧调用点
async function runAdvSearch() {
  state.advName = ($('#search-input') ? $('#search-input').value : '').trim();
  state.searchPageNum = 1;   // 每次重新检索回到第一页
  if (typeof window.api.libSearchAdvanced !== 'function') {
    filterInfo = { list: [], mode: 'plain', adv: true, error: '当前版本不支持跨库检索' };
    renderSearchStage();
    return;
  }
  const payload = {
    name: state.advName,
    levels: [...state.advLevels],
    tags: state.advTagOn ? state.advTags.slice() : [],
    authors: state.advAuthorOn ? state.advAuthors.slice() : []
  };
  // 没有任何条件：给出空结果，避免一次列出全部
  if (!payload.name && !payload.tags.length && !payload.authors.length) {
    filterInfo = { list: [], mode: 'plain', adv: true, emptyHint: true };
    renderSearchStage();
    return;
  }
  filterInfo = { list: [], mode: 'plain', adv: true, loading: true };
  renderSearchStage();
  try {
    const res = await window.api.libSearchAdvanced(payload);
    const raw = (res && Array.isArray(res.list)) ? res.list : [];
    const list = raw.map(x => ({
      kind: x.kind, name: x.name, path: x.path,
      icon: x.kind === 'group' ? '🗂' : (ICONS[x.category] || '📃'),
      sub: x.sub || '', libName: x.libName || ''
    }));
    filterInfo = { list, mode: 'plain', adv: true, cond: payload };
  } catch (err) {
    filterInfo = { list: [], mode: 'plain', adv: true, error: String(err && err.message || err) };
  }
  renderSearchStage();
}

// 标签 / 作者附加条件控件：勾选后展开，点选候选或输入后回车加入（多选 = 同时满足）
function chipSelectedHTML(names, kind, colorMap) {
  if (!names.length) return '<span class="hint">尚未选择</span>';
  return names.map(n => {
    const color = colorMap && colorMap[n] ? `style="--tag-c:${safeTagColor(colorMap[n], n)}"` : '';
    return `<span class="tag-chip active" data-remove="${escapeHtml(n)}" data-kind="${kind}" ${color}>${escapeHtml(n)} ✕</span>`;
  }).join('');
}
function candidateHTML(entries, selected, kind) {
  if (!entries.length) return '<span class="hint">暂无跨库候选</span>';
  return entries.map(e => {
    const name = e.name;
    const active = selected.includes(name);
    const color = e.color ? `style="--tag-c:${safeTagColor(e.color, name)}"` : '';
    return `<span class="tag-chip${active ? ' active' : ''}" data-toggle="${escapeHtml(name)}" data-kind="${kind}" ${color} title="${escapeHtml((e.libs || []).join('、'))}">${escapeHtml(name)}</span>`;
  }).join('');
}
function renderAdvCondControls() {
  const tagOn = state.advTagOn, authorOn = state.advAuthorOn;
  const tBox = $('#cond-tag-box'), aBox = $('#cond-author-box');
  if (tBox) tBox.classList.toggle('hidden', !tagOn);
  if (aBox) aBox.classList.toggle('hidden', !authorOn);
  const tagColorMap = {};
  for (const t of state.advBankTags) if (t.color) tagColorMap[t.name] = t.color;
  const tSel = $('#cond-tag-selected');
  if (tSel && tagOn) {
    tSel.innerHTML = chipSelectedHTML(state.advTags, 'tag', tagColorMap);
    tSel.querySelectorAll('[data-remove]').forEach(ch => ch.onclick = () => {
      state.advTags = state.advTags.filter(x => x !== ch.dataset.remove);
      renderAdvCondControls(); runAdvSearch();
    });
  }
  const aSel = $('#cond-author-selected');
  if (aSel && authorOn) {
    aSel.innerHTML = chipSelectedHTML(state.advAuthors, 'author', null);
    aSel.querySelectorAll('[data-remove]').forEach(ch => ch.onclick = () => {
      state.advAuthors = state.advAuthors.filter(x => x !== ch.dataset.remove);
      renderAdvCondControls(); runAdvSearch();
    });
  }
  const tBank = $('#cond-tag-bank'), tPager = $('#cond-tag-pager');
  if (tBank && tagOn) {
    const pages = Math.max(1, Math.ceil(state.advBankTags.length / CHIP_PAGE_SIZE));
    if (state.advBankTagPage > pages) state.advBankTagPage = pages;
    if (state.advBankTagPage < 1) state.advBankTagPage = 1;
    const p = state.advBankTagPage;
    const slice = state.advBankTags.slice((p - 1) * CHIP_PAGE_SIZE, p * CHIP_PAGE_SIZE);
    tBank.innerHTML = candidateHTML(slice, state.advTags, 'tag');
    tBank.querySelectorAll('[data-toggle]').forEach(ch => ch.onclick = () => {
      const n = ch.dataset.toggle;
      state.advTags = state.advTags.includes(n) ? state.advTags.filter(x => x !== n) : [...state.advTags, n];
      renderAdvCondControls(); runAdvSearch();
    });
    if (tPager) {
      tPager.innerHTML = chipPagerHTML(p, pages, 'ctbp');
      bindChipPager(tPager, 'ctbp', () => state.advBankTagPage,
        (v) => { state.advBankTagPage = v; }, renderAdvCondControls);
    }
  }
  const aBank = $('#cond-author-bank'), aPager = $('#cond-author-pager');
  if (aBank && authorOn) {
    const pages = Math.max(1, Math.ceil(state.advBankAuthors.length / CHIP_PAGE_SIZE));
    if (state.advBankAuthorPage > pages) state.advBankAuthorPage = pages;
    if (state.advBankAuthorPage < 1) state.advBankAuthorPage = 1;
    const p = state.advBankAuthorPage;
    const slice = state.advBankAuthors.slice((p - 1) * CHIP_PAGE_SIZE, p * CHIP_PAGE_SIZE);
    aBank.innerHTML = candidateHTML(slice, state.advAuthors, 'author');
    aBank.querySelectorAll('[data-toggle]').forEach(ch => ch.onclick = () => {
      const n = ch.dataset.toggle;
      state.advAuthors = state.advAuthors.includes(n) ? state.advAuthors.filter(x => x !== n) : [...state.advAuthors, n];
      renderAdvCondControls(); runAdvSearch();
    });
    if (aPager) {
      aPager.innerHTML = chipPagerHTML(p, pages, 'cabp');
      bindChipPager(aPager, 'cabp', () => state.advBankAuthorPage,
        (v) => { state.advBankAuthorPage = v; }, renderAdvCondControls);
    }
  }
}
function bindAdvCondControls() {
  const ct = $('#cond-tag-on'), ca = $('#cond-author-on');
  if (ct) { ct.checked = state.advTagOn; ct.onchange = () => {
    state.advTagOn = ct.checked; renderAdvCondControls(); runAdvSearch();
  }; }
  if (ca) { ca.checked = state.advAuthorOn; ca.onchange = () => {
    state.advAuthorOn = ca.checked; renderAdvCondControls(); runAdvSearch();
  }; }
  // 层级勾选（组 / 文件，可多选）
  $$('#search-controls .sc-levels input[data-level]').forEach(cb => {
    cb.checked = state.advLevels.has(cb.dataset.level);
    cb.onchange = () => {
      if (cb.checked) state.advLevels.add(cb.dataset.level);
      else state.advLevels.delete(cb.dataset.level);
      // 至少保留一个层级
      if (!state.advLevels.size) { state.advLevels.add(cb.dataset.level); cb.checked = true; return; }
      runAdvSearch();
    };
  });
  const bindAdd = (inputSel, arrKey) => {
    const inp = $(inputSel);
    if (!inp) return;
    bindEnter(inp, () => {
      const v = inp.value.trim();
      if (!v) return;
      if (!state[arrKey].includes(v)) state[arrKey].push(v);
      inp.value = '';
      renderAdvCondControls(); runAdvSearch();
    });
  };
  bindAdd('#cond-tag-input', 'advTags');
  bindAdd('#cond-author-input', 'advAuthors');
}
// 跨库候选（标签 / 作者）来自主进程并集，进入搜索区时按需刷新
async function refreshAdvBanks() {
  try {
    if (window.api.libTagBanks) {
      const r = await window.api.libTagBanks();
      state.advBankTags = ((r && r.tags) || []).map(t => ({ name: t.name, libs: t.libs || [] }));
    }
    if (window.api.libAuthorBanks) {
      const r = await window.api.libAuthorBanks();
      state.advBankAuthors = ((r && r.authors) || []).map(a => ({ name: a.name, libs: a.libs || [] }));
    }
  } catch {}
  renderAdvCondControls();
}

// 清空搜索与类型筛选（点击具体大类/组时调用，保持界面直觉）
function clearLibFilters() {
  state.libSearch = '';
  state.libCatFilter = '全部';
  state.libTagFilter = null;
  state.libAuthorFilter = null;
  $('#search-input').value = '';
  buildCatChips();
}

// 当前中间阅览区应渲染什么（由 state.view 决定）
// 「新建大类」只在文库首页（大类网格）与大类页面（组网格）出现，其余视图隐藏
function updateNewCatButton() {
  const b = $('#btn-new-cat-inline');
  if (!b) return;
  b.classList.toggle('hidden',
    !state.libData || !!state.libPreviewFile || (state.view !== 'lib' && state.view !== 'cat'));
}
function renderCurrentView() {
  updateNewCatButton();
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
    case 'search':
      // 搜索功能区（全宽舞台）自己维护跨库结果，不再走库内筛选视图
      if (state.section !== 'search') showLibFilterView();
      break;
    default: showLibrariesView();
  }
  updateFileNavButtons();
  // 搜索功能区激活时只重绘自己的舞台，避免库内渲染覆盖跨库结果
  if (state.section === 'search') renderSearchStage();
}
// ---------- 左侧功能导航（仪表盘 / 文库操作 / 搜索 / 最新添加） ----------
// 同一时刻只显示一个功能区块：左侧只展开该区块的细分项，主体也只显示对应的舞台。
// 现有所有按钮 id 都保留，只是按 data-section 归属到不同区块。
const SECTION_STAGES = {
  dashboard: '#stage-dashboard', workbench: '#stage-workbench',
  search: '#stage-search', records: '#stage-records'
};
function setSection(name) {
  if (!SECTION_STAGES[name]) name = 'workbench';
  state.section = name;
  document.body.dataset.section = name;
  // 左侧导航高亮
  $$('#nav-rail .nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  // 左侧细分项：只显示属于当前区块的 section；历史记录在左栏仅「记录」区块显示
  $$('#lp-body .lp-sec[data-section]').forEach(sec => sec.classList.toggle('hidden', sec.dataset.section !== name));
  $('#history-box').classList.toggle('hidden', name !== 'records');
  // 主体舞台：只显示当前区块
  Object.entries(SECTION_STAGES).forEach(([key, sel]) => $(sel).classList.toggle('hidden', key !== name));
  // 各区块自有渲染
  if (name === 'dashboard') renderDashboard();
  else if (name === 'records') renderRecordsStage();
  else if (name === 'search') {
    if (!state._advBound) { bindAdvCondControls(); state._advBound = true; }
    renderAdvCondControls();
    renderSearchStage();
    refreshAdvBanks();                 // 刷新跨库标签 / 作者候选（异步）
  }
  else { renderCurrentView(); renderBreadcrumb(); }
}

// 仪表盘标签墙 / 作者墙点击条目：把该值设为搜索功能区的附加条件，切到「搜索」并跨库检索。
// 复用统一的 lib:searchAdvanced（组 / 文件两级），与功能区内的手动检索口径一致。
async function crossLibSearchFromWall(kind, value) {
  const val = String(value == null ? '' : value).trim();
  if (!val) return;
  const isTag = kind === 'tag';
  // 先清掉另一类条件，避免上次的选择污染本次跳转
  state.advTagOn = isTag;
  state.advAuthorOn = !isTag;
  state.advTags = isTag ? [val] : [];
  state.advAuthors = isTag ? [] : [val];
  state.advName = '';
  if ($('#search-input')) $('#search-input').value = '';
  setSection('search');                 // 内部完成首次绑定与候选刷新
  renderAdvCondControls();              // 同步刚设置的勾选 / 已选条件
  await runAdvSearch();
}
function searchTagFromWall(tag) { return crossLibSearchFromWall('tag', tag); }
function searchAuthorFromWall(author) { return crossLibSearchFromWall('author', author); }

// 仪表盘：全部文库统计之和 + 标签墙（标签并集）
function renderDashboard() {
  const box = $('#dashboard-body');
  if (!box) return;
  const libs = Array.isArray(state.libLibraries) ? state.libLibraries : [];
  const cats = libs.reduce((s, l) => s + (l.catCount || 0), 0);
  const groups = libs.reduce((s, l) => s + (l.groupCount || 0), 0);
  const files = libs.reduce((s, l) => s + (l.fileCount || 0), 0);
  const size = libs.reduce((s, l) => s + (l.totalSize || 0), 0);
  const stat = (n, label, icon) => `<div class="dash-card"><div class="dc-ico">${icon}</div><div class="dc-num">${n}</div><div class="dc-label">${label}</div></div>`;
  const head = `
    <div class="stage-title"><span>📊 仪表盘</span><span class="stage-sub">全部 ${libs.length} 个文库之和</span></div>
    <div class="dash-stats">
      ${stat(cats, '大类', '📁')}${stat(groups, '文件组', '🗂')}
      ${stat(files, '文件', '📄')}${stat(fmtSize(size), '总大小', '💾')}
    </div>`;
  if (!libs.length) {
    box.innerHTML = head + `<div class="stage-empty"><div class="big">📊</div><div>还没有文库</div>
      <div class="empty-sub">在「文库操作」中新建文库后，这里会汇总全部文库的统计与标签墙</div></div>`;
    return;
  }
  box.innerHTML = head + `
    <div class="stage-panel"><div class="panel-title">🏷 标签墙</div><div id="tag-wall-body" class="tw-loading">正在汇总标签…</div></div>
    <div class="stage-panel" style="margin-top:14px"><div class="panel-title">✍️ 作者墙</div><div id="author-wall-body" class="tw-loading">正在汇总作者…</div></div>
    <div class="stage-hint">统计为全部文库之和；标签墙 / 作者墙显示所有文库的并集，字号随拥有该标签 / 作者的组数增大。点击任意条目可跨库检索对应组。</div>`;
  // 标签墙 / 作者墙数据来自主进程（跨文库并集 + 组数），异步填充，失败时给出可读提示
  fillWall('tag-wall-body', 'tag');
  fillWall('author-wall-body', 'author');
}

// 填充单个词墙：取数 → 渲染 → 绑定点击（点击条目跨库检索对应组）
function fillWall(bodyId, kind) {
  const isTag = kind === 'tag';
  const apiName = isTag ? 'libTagWall' : 'libAuthorWall';
  const key = isTag ? 'tags' : 'authors';
  const label = isTag ? '标签' : '作者';
  const ph = $('#' + bodyId);
  if (typeof window.api[apiName] !== 'function') {
    if (ph) ph.innerHTML = `<div class="stage-empty"><div class="big">${isTag ? '🏷' : '✍️'}</div><div>当前版本不支持${label}墙数据</div></div>`;
    return;
  }
  window.api[apiName]().then(res => {
    const el = $('#' + bodyId);
    if (!el) return;
    const items = (res && Array.isArray(res[key])) ? res[key] : [];
    el.className = '';
    el.innerHTML = buildTagWall(items);
    el.querySelectorAll('.tw-clickable').forEach(node => {
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      const go = () => crossLibSearchFromWall(kind, node.getAttribute('data-tag') || '');
      node.addEventListener('click', go);
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }).catch(err => {
    const el = $('#' + bodyId);
    if (el) { el.className = ''; el.innerHTML = `<div class="stage-empty"><div class="big">${isTag ? '🏷' : '✍️'}</div><div>${label}加载失败</div><div class="empty-sub">${escapeHtml(String(err && err.message || err))}</div></div>`; }
  });
}

// 词墙（标签墙 / 作者墙共用）：≤10 个分两行平铺；>10 个组成爱心词云，字号按拥有该项的组数
function buildTagWall(tags) {
  if (!tags.length) return '<div class="stage-empty"><div class="big">🏷</div><div>还没有任何条目</div><div class="empty-sub">给文件组打上标签或作者后，这里会汇总展示</div></div>';
  if (tags.length <= 10) {
    const half = Math.ceil(tags.length / 2);
    const row = arr => arr.map(t => tagWallChip(t)).join('');
    return `<div class="tw-grid two-rows"><div class="tw-row">${row(tags.slice(0, half))}</div><div class="tw-row">${row(tags.slice(half))}</div></div>`;
  }
  return tagHeartCloud(tags);
}
function tagWallChip(t) {
  const name = String(t.name || '');
  const c = metaTagColor(name);
  const n = Number(t.groupCount) || 0;
  return `<span class="tw-chip tw-clickable" data-tag="${escapeHtml(name)}" style="--tw-c:${c}" title="${escapeHtml(name)}：${n} 个组">${escapeHtml(name)}<i>${n}</i></span>`;
}
// 爱心词云：先用参数方程画出可见爱心轮廓，再把标签名称放进轮廓内部（同一坐标系）
// 参数方程：x=16sin³t，y=13cos t−5cos2t−2cos3t−cos4t（数学坐标 y 向上），映射为容器 0~100 百分比坐标
const HEART_K = 2.4, HEART_CX = 50, HEART_CY = 50;
function heartParam(t) {
  const hx = 16 * Math.pow(Math.sin(t), 3);
  const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return { x: HEART_CX + hx * HEART_K, y: HEART_CY - hy * HEART_K };
}
// 爱心轮廓采样点（0~100 容器百分比坐标），轮廓绘制与文字布局共用同一组点
function heartPolygon(N) {
  N = N || 120;
  const pts = [];
  for (let i = 0; i < N; i++) pts.push(heartParam(i / N * Math.PI * 2));
  return pts;
}
// 射线法：判断点是否落在爱心内部（含边界近似）
function pointInHeart(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// 标签文字宽度（相对容器宽度的百分比）：中文按 1em，ASCII 按 0.56em
function tagTextWidthPct(name, fsPct) {
  let em = 0;
  for (const ch of String(name)) em += /[\x00-\xff]/.test(ch) ? 0.56 : 1;
  return em * fsPct;
}
// 爱心轮廓 SVG path
function heartOutlinePath() {
  const parts = heartPolygon(120).map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(2) + ' ' + p.y.toFixed(2));
  return parts.join(' ') + ' Z';
}
// 爱心词云：先画可见轮廓，再把标签放进爱心内部。字号大的先放、靠近中心，逐个避开已占区域，
// 并保证整段文字的四角都在爱心内（不会越界），尽量互不重叠。
function tagHeartCloud(tags) {
  const counts = tags.map(t => Number(t.groupCount) || 0);
  const max = Math.max(1, ...counts), min = Math.min(...counts);
  const span = Math.max(1, max - min);
  const items = tags.map((t, i) => ({
    name: String(t.name || ''), n: counts[i],
    fs: 2.2 + (counts[i] - min) / span * 3.6   // 2.2~5.8 cqw，随容器等比缩放；拥有该标签的组越多越大
  }));
  const poly = heartPolygon(120);
  // 候选网格：按到中心的距离由内向外，保证大标签靠中心、小标签向外铺开
  const grid = [];
  for (let y = 24; y <= 90; y += 2)
    for (let x = 14; x <= 86; x += 2)
      grid.push({ x, y, d: Math.hypot((x - 50), (y - 55) * 0.9) });
  grid.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  const insideBox = (p, hw, hh) => {
    for (const sx of [-1, 1]) for (const sy of [-1, 1])
      if (!pointInHeart(p.x + sx * hw, p.y + sy * hh, poly)) return false;
    return true;
  };
  const placed = [], pos = new Array(items.length);
  const order = items.map((_, i) => i)
    .sort((a, b) => items[b].fs - items[a].fs || tagCompare(items[a].name, items[b].name));
  for (const i of order) {
    const it = items[i];
    const hw = tagTextWidthPct(it.name, it.fs) / 2;
    const hh = Math.max(1.4, it.fs * 0.55);
    // 首选：四角都在爱心内且与已放文字不重叠
    let pick = grid.find(p => insideBox(p, hw, hh) &&
      !placed.some(q => Math.abs(q.x - p.x) < q.hw + hw + 0.8 && Math.abs(q.y - p.y) < q.hh + hh + 0.5));
    // 退化：只要求在爱心内，允许轻微重叠
    if (!pick) pick = grid.find(p => insideBox(p, hw, hh));
    if (!pick) pick = { x: 50, y: 55 };
    placed.push({ x: pick.x, y: pick.y, hw, hh });
    pos[i] = pick;
  }
  const words = items.map((it, i) => {
    const p = pos[i], c = metaTagColor(it.name);
    return `<span class="tw-word tw-clickable" data-tag="${escapeHtml(it.name)}" style="left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%;font-size:${it.fs.toFixed(2)}cqw;color:${c}" title="${escapeHtml(it.name)}：${it.n} 个组">${escapeHtml(it.name)}</span>`;
  }).join('');
  return `<div class="tw-cloud"><div class="tw-heart">
    <svg class="tw-heart-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${heartOutlinePath()}"/></svg>
    ${words}
  </div></div>`;
}
// 搜索（全宽初版）：复用已有的按标签 / 按分类筛选逻辑，结果与工具条都放在主体区
function renderSearchStage() {
  const box = $('#search-stage-body');
  if (!box) return;
  const list = Array.isArray(filterInfo.list) ? filterInfo.list : [];
  const adv = !!filterInfo.adv;
  // 结果分页（每页 20 条）
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  if (state.searchPageNum > pages) state.searchPageNum = pages;
  if (state.searchPageNum < 1) state.searchPageNum = 1;
  const page = state.searchPageNum;
  const pageList = list.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE);
  // 条件摘要
  let cond = '';
  if (adv && filterInfo.cond) {
    const c = filterInfo.cond;
    cond = [
      c.name ? '名称：' + escapeHtml(c.name) : null,
      '层级：' + escapeHtml((c.levels || []).map(l => l === 'group' ? '组' : '文件').join('/') || '—'),
      (c.tags || []).length ? '标签：' + escapeHtml(c.tags.join(' + ')) : null,
      (c.authors || []).length ? '作者：' + escapeHtml(c.authors.join(' + ')) : null
    ].filter(Boolean).join('　');
  } else {
    cond = [
      filterInfo.kw ? '关键词：' + escapeHtml(filterInfo.kw) : null,
      filterInfo.tag ? '标签：' + escapeHtml(filterInfo.tag) : null,
      filterInfo.author ? '作者：' + escapeHtml(filterInfo.author) : null
    ].filter(Boolean).join('　');
  }
  let rows = '';
  if (filterInfo.loading) {
    rows = '<div class="stage-empty"><div class="big">🔍</div><div>正在检索全部文库…</div></div>';
  } else if (filterInfo.error) {
    rows = '<div class="stage-empty"><div class="big">⚠️</div><div>检索失败</div><div class="empty-sub">' + escapeHtml(filterInfo.error) + '</div></div>';
  } else if (!list.length) {
    const hint = filterInfo.emptyHint
      ? '输入名称，或勾选标签 / 作者条件后再检索'
      : '在上方调整条件后再试（标签 / 作者为需同时满足的附加条件）';
    rows = '<div class="stage-empty"><div class="big">🔍</div><div>没有匹配的结果</div><div class="empty-sub">' + hint + '</div></div>';
  } else {
    rows = `<div class="tile-grid result-grid">` + pageList.map(x => {
      // 跨库结果项：{kind,name,path,icon,sub,libName}；旧库内文件项：{file,group}
      // 仅改显示样式：列表行改为卡片，保留 data-path / data-kind 供原有双击逻辑使用
      const isFlat = x && x.name !== undefined && x.file === undefined;
      const name = isFlat ? x.name : (x.file && x.file.name) || '';
      const sub = isFlat ? escapeHtml(x.sub || '') : (x.group ? escapeHtml(x.group.displayName) + ' · ' + fmtSize(x.file.size) : '');
      const kind = x.kind || (isFlat ? '' : 'file');
      const filePath = x.path || (x.file && x.file.path) || '';
      const cat = isFlat ? (x.category || catOfPath(filePath)) : ((x.file && x.file.category) || '');
      const icon = isFlat
        ? (cat ? (ICONS[cat] || '📃') : (x.icon || (kind === 'group' ? '🗂' : '📃')))
        : (ICONS[cat] || '📃');
      const level = (kind === 'group' || kind === 'file')
        ? `<span class="tile-level">${kind === 'group' ? '组' : '文件'}</span>` : '';
      const dp = x.path ? ` data-path="${escapeHtml(x.path)}" data-kind="${escapeHtml(kind)}"` : '';
      // 图片/视频文件卡片复用既有缩略图方式：data-thumb + hydrateThumbs
      const thumb = (kind === 'file' && (cat === '图片' || cat === '视频') && filePath)
        ? ` data-thumb="${escapeHtml(filePath)}"` : '';
      return `<div class="tile result-tile"${dp}>
        <div class="t-slot with-icon"${thumb}><span class="t-icon">${icon}</span>${level}</div>
        <div class="t-foot">
          <div class="t-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="t-size">${sub}</div>
        </div>
      </div>`;
    }).join('') + `</div>`;
  }
  box.innerHTML = `
    <div class="stage-title"><span>🔍 搜索</span><span class="stage-sub">共 ${total} 项结果 · 全部文库</span></div>
    <div class="stage-toolbar"><span class="stage-chip active">跨文库</span><span class="stage-chip">组 / 文件</span><span class="toolbar-cond">${cond || '未设置筛选条件'}</span></div>
    ${rows}
    ${pagerHTML(page, pages, { prev: 'spg-prev', next: 'spg-next' })}`;
  hydrateThumbs(box);   // 图片/视频结果卡片填充缩略图（失败自动回退图标）
  bindPager(box, renderSearchStage, {
    ids: { prev: 'spg-prev', next: 'spg-next' },
    getPage: () => state.searchPageNum,
    setPage: (v) => { state.searchPageNum = v; }
  });
  box.querySelectorAll('[data-path]').forEach(el => {
    const isGroup = el.dataset.kind === 'group';
    el.title = (isGroup ? '双击打开组文件夹：' : '双击打开：') + el.dataset.path;
    el.ondblclick = () => {
      if (isGroup) { window.api.showInFolder(el.dataset.path); return; }
      openEntry({ path: el.dataset.path, name: el.querySelector('.t-name')?.textContent || '', isDir: false });
    };
  });
}

// 最新添加（全宽单面板）：仅「最近添加」，最多 10 条，可隐藏 / 清空
// 仅改显示样式：记录行改为卡片网格，保留 data-recent 供原有点击打开逻辑使用
function recordCardsHTML(items, attr) {
  if (!items.length) return '<div class="list-empty" style="padding:10px">暂无记录</div>';
  return `<div class="tile-grid result-grid">` + items.map(h => {
    const thumb = (h.category === '图片' || h.category === '视频')
      ? ` data-thumb="${escapeHtml(h.path)}"` : '';
    return `<div class="tile result-tile" ${attr}="${escapeHtml(h.path)}">
      <div class="t-slot with-icon"${thumb}><span class="t-icon">${ICONS[h.category] || '📃'}</span></div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(h.path)}">${escapeHtml(h.name)}</div>
        <div class="t-size">${escapeHtml(h.libName ? h.libName + ' · ' : '')}${escapeHtml(h.path)}</div>
      </div>
    </div>`;
  }).join('') + `</div>`;
}
function renderRecordsStage() {
  const box = $('#records-stage-body');
  if (!box) return;
  const recent = state.recentAdded.slice(0, 10);
  box.innerHTML = `
    <div class="stage-title"><span>📥 最新添加</span><span class="stage-sub">最近添加的文件，保留最近 10 条</span></div>
    <div class="stage-panel rec-panel">
      <div class="panel-title rec-title">
        <span>📥 最近添加 <span class="rec-count">${state.recentAdded.length} / 10</span></span>
        <span class="rec-acts">
          <button id="rec-toggle-recent" class="stage-act">${state.recentHidden ? '展开' : '隐藏'}</button>
          <button id="rec-clear-recent" class="stage-act">清空</button>
        </span>
      </div>
      <div id="rec-recent-body" class="rec-body${state.recentHidden ? ' hidden' : ''}">
        ${recent.length ? recordCardsHTML(recent, 'data-recent')
          : '<div class="stage-empty"><div class="big">📥</div><div>暂无最近添加</div><div class="empty-sub">通过「添加文件 / 批量添加」导入的文件会出现在这里</div></div>'}
      </div>
    </div>`;
  hydrateThumbs(box);   // 图片/视频记录卡片填充缩略图（失败自动回退图标）
  // 点击记录：打开文件（逻辑不变）
  box.querySelectorAll('[data-recent]').forEach(el => {
    el.onclick = () => {
      const h = state.recentAdded.find(x => x.path === el.dataset.recent);
      if (h) openEntry({ path: h.path, name: h.name, isDir: false, category: h.category });
    };
  });
  // 隐藏 / 清空（逻辑不变）
  const tglR = $('#rec-toggle-recent');
  if (tglR) tglR.onclick = () => {
    state.recentHidden = !state.recentHidden;
    localStorage.setItem('fm_recent_hidden', state.recentHidden ? '1' : '0');
    renderRecordsStage();
  };
  const clrR = $('#rec-clear-recent');
  if (clrR) clrR.onclick = () => clearRecentAdded();
}

function libFilterActive() {
  return state.libSearch !== '' || state.libCatFilter !== '全部' || !!state.libTagFilter || !!state.libAuthorFilter;
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

// ---------- 文件连续浏览（上一个 / 下一个） ----------
// 按「用户是从哪份列表点进来的」决定翻页顺序：检索结果 > 当前组 > 整个文库。
// 这样在组内翻页不会突然跳到别的大类，在检索结果里翻页也保持结果顺序。
function previewFilesForNav() {
  const cur = state.libPreviewFile;
  if (!cur || cur.isDir) return [];
  const resolve = (x) => {
    if (!x) return null;
    if (x.file) return x.file;
    if (x.path) return findLibFile(x.path);
    return null;
  };
  const has = (list) => list.some(f => f.path === cur.path);
  if (state.view === 'search' && Array.isArray(filterInfo.list)) {
    const list = filterInfo.list.map(resolve).filter(f => f && f.path && !f.isDir);
    if (has(list)) return list;
  }
  const g = state.libSel?.type === 'group' ? state.libSel.data : null;
  if (g && Array.isArray(g.files)) {
    const list = g.files.filter(f => f && f.path && !f.isDir);
    if (has(list)) return list;
  }
  const all = getLibFiles().map(x => x.file).filter(f => f && f.path && !f.isDir);
  if (has(all)) return all;
  return [cur];
}
function updateFileNavButtons() {
  const prev = $('#btn-prev-file'), next = $('#btn-next-file');
  if (!prev || !next) return;
  const on = !!state.libPreviewFile && !state.libPreviewFile.isDir;
  prev.classList.toggle('hidden', !on);
  next.classList.toggle('hidden', !on);
  const list = on ? previewFilesForNav() : [];
  const i = list.findIndex(f => f.path === state.libPreviewFile.path);
  prev.disabled = !on || i <= 0;
  next.disabled = !on || i < 0 || i >= list.length - 1;
  if (on) {
    const pos = i >= 0 ? `（${i + 1} / ${list.length}）` : '';
    prev.title = '上一个文件' + pos + '，快捷键 ←';
    next.title = '下一个文件' + pos + '，快捷键 →';
  }
}
function stepPreview(delta) {
  if (!state.libPreviewFile) return;
  const list = previewFilesForNav();
  const i = list.findIndex(f => f.path === state.libPreviewFile.path);
  if (i < 0) { toast('当前文件不在浏览列表中', true); return; }
  const target = list[i + delta];
  if (!target) { toast(delta > 0 ? '已经是最后一个文件' : '已经是第一个文件'); return; }
  // 连续翻页不该把每一步都塞进「后退 / 前进」导航历史
  const oldLock = state.navLock;
  state.navLock = true;
  try { gotoFile(target); }
  finally { state.navLock = oldLock; }
  updateNavButtons();
}

// ---------- 阅览区预览 ----------
function clearPreview() {
  $('#preview-name').textContent = '未选择文库内容';
  $('#btn-open-external').classList.add('hidden');
  $('#btn-new-lib-inline').classList.add('hidden');
  $('#btn-new-cat-inline').classList.add('hidden');
  $('#btn-prev-file').classList.add('hidden');
  $('#btn-next-file').classList.add('hidden');
  $('#preview-body').innerHTML = `
    <div id="preview-empty">
      <div class="empty-icon">📚</div>
      <div>在左侧选择大类或文件组即可浏览</div>
      <div class="empty-sub">单击卡片看信息，双击进入下一层</div>
    </div>`;
  $('#detail-body').innerHTML = '<div class="hint">未选择文件</div>';
}
function showPreview(e) {
  updateFileNavButtons();
  $('#btn-new-cat-inline').classList.add('hidden');
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
    body.innerHTML = `<div class="video-stage">
      <video class="preview-video" src="${fileUrl(e.path)}" controls playsinline></video>
      <div class="video-tools">
        <span>内嵌播放器（Electron / Chromium）</span>
        <button id="pv-fs" title="全屏播放，按 ESC 退出">全屏播放</button>
        <button id="pv-ext" title="调用系统默认播放器">系统播放器打开</button>
      </div>
    </div>`;
    openBtn.classList.add('hidden');
    $('#pv-ext').onclick = () => openEntry(e);
    $('#pv-fs').onclick = async () => {
      const v = $('.preview-video');
      if (!v) return;
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (typeof v.requestFullscreen === 'function') await v.requestFullscreen();
        else throw new Error('当前环境不支持 Fullscreen API');
      } catch (err) {
        setFullscreen(true);   // 退回：把阅览区铺满应用窗口
        toast('已切换为窗口内全屏（系统全屏不可用）：' + (err.message || ''), true);
      }
    };
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
      if (r.encoding && r.encoding !== 'UTF-8') toast(`该文件为 ${r.encoding} 编码，已自动转换显示`);
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
  mk('全部文库', state.view !== 'libs', () => { state.libPreviewFile = null; state.view = 'libs'; renderCurrentView(); });

  // 「全部文库」视图或未进入文库时，只显示根级（数量由旁边的统计文字展示）
  if (state.view === 'libs' || !state.libRoot || !state.libData) return;
  const libName = state.libData.name || '文库';
  mkSep(bc);
  mk(libName, state.view !== 'lib', () => {
    state.libSel = null;
    state.libPreviewFile = null;
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
        state.libPreviewFile = null;
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
    if (s.kind === 'lib') {
      if (s.path === state.libRoot && state.libData) { showLibraryDetails(state.libData); return; }
      const l = state.libLibraries.find(x => x.path === s.path); if (l) { showLibCardDetails(l); return; }
    }
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
    if (path === state.libRoot && state.libData) { gotoLibraryHome(); return; }
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
    renderAuthorChips();
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
    if (r.backups && r.backups.length) {
      // 系统回收站不可用时主进程会把文件挪到备份区并回报真实落点，
      // 这里必须明确告知，不能再说「已移入回收站」。
      showModal('已移到备份区', `<div class="hint">系统回收站不可用，文件<b>没有被销毁</b>，已移到：<br><br>
        <code>${escapeHtml(r.backups[0].backup)}</code><br><br>需要时可从这个位置手动还原。</div>`,
        () => {}, '知道了', null, { noFocus: true });
    } else {
      toast('已删除，可在回收站还原');
    }
    await refreshAfterOp(t);
  }, '删除');
}

// ---------- 组标签操作：添加 / 修改 / 删除 ----------
// 统一写回标签（一处实现，右键菜单与右侧详情共用）
async function setGroupTags(g, names) {
  const r = await window.api.libSetMeta(state.libRoot, g.rel, 'group', { tags: sortTagNames(names) });
  if (r && r.error) { toast(r.error, true); return false; }
  await loadLibrary(true);
  renderTagChips();
  renderAuthorChips();
  refreshDetails();
  return true;
}
function groupTagNames(g) { return sortTagNames((g.tags || []).map(t => t.name)); }

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

// 组右键「添加标签」：改成与「编辑信息」一致的标签集合编辑，
// 既能一次选多个已有标签，也能手动输入、顺手删掉不需要的。
async function opTagAdd(t) {
  const g = findGroupByPath(t.path);
  if (!g) return;
  try { await refreshTagBanks(); } catch { tagBankData = []; }
  const cur = groupTagNames(g);
  showModal('添加标签', `
    <label class="field-label">标签（多个用「、」分隔）</label>
    <input id="m-tags" value="${escapeHtml(cur.join('、'))}" spellcheck="false">
    ${tagBankSectionHTML('', '候选是各文库当前仍在使用的标签；点一下加入、再点一下移除。')}
    <div class="hint">保存后整体替换「${escapeHtml(g.displayName)}」的标签，组内文件自动继承；也可以直接在上方手动输入新标签。</div>`, async () => {
    const names = splitMetaList($('#m-tags') ? $('#m-tags').value : '');
    if (await setGroupTags(g, names)) toast('标签已保存');
  }, '保存');
  const repaint = bindTagBankSection({
    getNames: () => splitMetaList($('#m-tags') ? $('#m-tags').value : ''),
    setNames: (ns) => { const el = $('#m-tags'); if (el) el.value = sortTagNames(ns).join('、'); }
  });
  const tagInput = $('#m-tags');
  if (tagInput) tagInput.addEventListener('input', repaint);
}

async function opTagRename(t) {
  const g = findGroupByPath(t.path);
  if (!g) return;
  pickTag(g, '修改标签', '这个组还没有标签，先添加吧', async (old) => {
    try { await refreshTagBanks(); } catch { tagBankData = []; }
    showModal('修改标签', `
      <label class="field-label">新的标签名称</label>
      <input id="m-input" value="${escapeHtml(old)}" spellcheck="false">
      ${tagBankSectionHTML('', '也可以直接点一个已有标签，把它作为新名称。')}
      <div class="hint">只改这个组上的这个标签，其他组不受影响</div>`, async () => {
      const v = $('#m-input').value.trim();
      if (!v || v === old) return;
      const names = sortTagNames(groupTagNames(g).map(n => (n === old ? v : n)));
      if (await setGroupTags(g, names)) toast(`标签已改为「${v}」`);
    }, '保存');
    // 改名是单选：点候选标签就替换输入框里的名字
    const repaint = bindTagBankSection({
      single: true,
      getNames: () => { const v = $('#m-input') ? $('#m-input').value.trim() : ''; return v ? [v] : []; },
      setNames: (ns) => { const el = $('#m-input'); if (el) el.value = ns[0] || ''; }
    });
    const inp = $('#m-input');
    if (inp) inp.addEventListener('input', repaint);
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

// ---------- 操作完成后的刷新 / 文库改名后的历史记录重定位 ----------
// 文库改名后，历史记录里存的还是旧绝对路径，点开就会提示"文件不存在"。
// 把这些条目的路径前缀一并换成新文库根。
function rebaseHistory(oldRoot, newRoot) {
  if (!oldRoot || !newRoot) return;
  const o = String(oldRoot).replace(/[\\/]+$/, ''), n = String(newRoot).replace(/[\\/]+$/, '');
  const lo = o.toLowerCase();
  let changed = false;
  state.openHistory = state.openHistory.map(h => {
    const p = h && h.path ? String(h.path) : '';
    if (p.toLowerCase() === lo || p.toLowerCase().startsWith(lo + '\\') || p.toLowerCase().startsWith(lo + '/')) {
      changed = true;
      return Object.assign({}, h, { path: n + p.slice(o.length) });
    }
    return h;
  });
  if (changed) {
    localStorage.setItem('fm_open_history', JSON.stringify(state.openHistory));
    renderHistory();
  }
}
async function refreshAfterOp(t, newPath) {
  if (t.kind === 'lib') {
    if (newPath) {
      rebaseHistory(t.path, newPath);
      // 只有当前正打开的文库被改名时才切换；否则不要莫名跳到别的文库
      if (state.libRoot && String(state.libRoot).toLowerCase() === String(t.path).toLowerCase()) {
        state.libRoot = newPath;
        localStorage.setItem('fm_lib_root', newPath);
      }
    }
    await loadLibList();
    if (state.libRoot) await loadLibrary(true);
    state.view = 'libs';
    showLibrariesView();
    return;
  }
  state.libPreviewFile = null;      // 列表已刷新，结束文件预览状态
  await loadLibrary(true);          // 静默重扫：state.libSel 会自动校正或被清空
  renderLibTree();
  renderBreadcrumb();
  if (state.libSel?.type === 'group') state.view = 'group';
  else if (state.libSel?.type === 'category') state.view = 'cat';
  else state.view = state.libData ? 'lib' : 'libs';
  renderCurrentView();
}

// ---------- 检索方式切换（按分类 / 按标签） ----------
// 检索方式三态循环：cat 按分类 → tag 按标签 → author 按作者 → cat …
const SEARCH_MODE_NEXT = { cat: 'tag', tag: 'author', author: 'cat' };
const SEARCH_MODE_LABEL = { cat: '分类', tag: '标签', author: '作者' };
function renderSearchMode() {
  const btn = $('#btn-search-mode');
  const next = SEARCH_MODE_NEXT[state.searchMode];
  btn.textContent = '按' + SEARCH_MODE_LABEL[next];
  btn.title = `当前：按${SEARCH_MODE_LABEL[state.searchMode]}检索，点击切换为按${SEARCH_MODE_LABEL[next]}检索`;
}
$('#btn-search-mode').onclick = () => {
  state.searchMode = SEARCH_MODE_NEXT[state.searchMode];
  localStorage.setItem('fm_search_mode', state.searchMode);
  // 三种检索方式互斥，切换时清掉其他方式的筛选条件
  state.libCatFilter = '全部';
  state.libTagFilter = null;
  state.libAuthorFilter = null;
  state.libPageNum = 1;
  buildCatChips();
  renderTagChips();
  renderAuthorChips();
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
    renderAuthorChips();
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
  renderAuthorChips();
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
// 卡片每页数量：随阅览区宽度 / 全屏状态动态调整（见 recomputePageSize）。
// 初始 12；正常窗口约 3 行，最大化/全屏时列数增多、每页最多 60。
let PAGE_SIZE = 12;
const SEARCH_PAGE_SIZE = 20;   // 搜索结果每页条数
const CHIP_PAGE_SIZE = 25;     // 标签 / 作者候选列表每页个数

// 按阅览区实际宽度重算每页卡片数：约每 160px 一列（卡片 150 + 间距 10），
// 普通视图 3 行、全屏 4 行，下限 12、上限 60。最大化 / 全屏后每页自动变多。
function recomputePageSize() {
  const panel = $('#preview-panel');
  const fs = panel && panel.classList.contains('fs-fullscreen');
  const w = (panel ? panel.clientWidth : 0) || window.innerWidth;
  const cols = Math.max(2, Math.floor(w / 160));
  const rows = fs ? 4 : 3;
  PAGE_SIZE = Math.min(60, Math.max(12, cols * rows));
}

// 紧凑分页条：供标签 / 作者候选列表复用（每页 25 个）
function chipPagerHTML(page, pages, prefix) {
  if (pages <= 1) return '';
  return `<div class="pager chip-pager">
      <button type="button" id="${prefix}-prev"${page <= 1 ? ' disabled' : ''}>上一页</button>
      <span>${page}/${pages}</span>
      <button type="button" id="${prefix}-next"${page >= pages ? ' disabled' : ''}>下一页</button>
    </div>`;
}
function bindChipPager(rootEl, prefix, getPage, setPage, rerender) {
  const prev = rootEl.querySelector('#' + prefix + '-prev');
  if (prev) prev.onclick = () => { setPage(getPage() - 1); rerender(); };
  const next = rootEl.querySelector('#' + prefix + '-next');
  if (next) next.onclick = () => { setPage(getPage() + 1); rerender(); };
}

// 分页条：四个层级共用同一段 HTML 与翻页逻辑，保证排版与文案一致。
// ids/get/set 可选；不传则沿用文库层级默认的 pg-* 与 state.libPageNum。
function pagerHTML(page, pages, ids) {
  if (pages <= 1) return '';
  const prevId = (ids && ids.prev) || 'pg-prev';
  const nextId = (ids && ids.next) || 'pg-next';
  return `<div class="pager">
      <button id="${prevId}"${page <= 1 ? ' disabled' : ''}>上一页</button>
      <span>第 ${page} / ${pages} 页</span>
      <button id="${nextId}"${page >= pages ? ' disabled' : ''}>下一页</button>
    </div>`;
}
function bindPager(body, rerender, opts) {
  const o = opts || {};
  const prevId = (o.ids && o.ids.prev) || 'pg-prev';
  const nextId = (o.ids && o.ids.next) || 'pg-next';
  const get = o.getPage || (() => state.libPageNum);
  const set = o.setPage || ((v) => { state.libPageNum = v; });
  const prev = body.querySelector('#' + prevId);
  if (prev) prev.onclick = () => { set(get() - 1); rerender(); };
  const next = body.querySelector('#' + nextId);
  if (next) next.onclick = () => { set(get() + 1); rerender(); };
}

function showLibrariesView() {
  state.view = 'libs';
  $('#btn-new-lib-inline').classList.remove('hidden');
  updateNewCatButton();
  $('#btn-open-external').classList.add('hidden');
  $('#preview-name').textContent = `共 ${state.libLibraries.length} 个文库`;

  const list = state.libLibraries;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 文库卡片不显示缩略图：只保留名称、统计与当前/丢失状态角标（角标放在名称行内）
  const tiles = slice.map((l, i) => `
    <div class="tile lib-tile${l.exists ? '' : ' missing'}${l.path === state.libRoot ? ' current' : ''}${selClass(l.path)}" data-i="${i}"${cardDataAttr('lib', l.path, l.name)} title="${escapeHtml(l.path)}">
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}${l.path === state.libRoot ? '<span class="lib-flag">当前</span>' : (l.exists ? '' : '<span class="lib-flag">已丢失</span>')}</div>
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
  updateNewCatButton();
  $('#preview-name').textContent = `${data.categories.length} 个大类 · ${data.categories.reduce((s, c) => s + c.groupCount, 0)} 组`;

  const cats = data.categories;
  const pages = Math.max(1, Math.ceil(cats.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = cats.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tiles = slice.map((c, i) => {
    // 大类卡片展示前 9 个组（3×3），没有封面的位置显示占位块
    const covers = c.groups.slice(0, 9).map(g => g.cover);
    const cells = Array.from({ length: 9 }, (_, k) => covers[k]
      ? `<img src="${escapeHtml(fileUrl(covers[k]))}" alt="">`
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
        <div class="empty-sub">点击上方「新建大类」创建第一个大类</div></div>`;

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

// ---------- 维护信息筛选：标签 / 作者（都只作用于「组」级） ----------
// 候选标签 / 作者来自账本组级 meta（v0.4.2 起维护信息只在组级）
function allTags() {
  const map = new Map();
  const mm = state.libData && state.libData.meta ? state.libData.meta : {};
  for (const m of Object.values(mm))
    for (const x of (m.tags || []))
      if (x && x.name && !map.has(x.name)) map.set(x.name, safeTagColor(x.color, x.name));
  return new Map([...map].sort((a, b) => tagCompare(a[0], b[0])));
}
function allAuthors() {
  const set = new Set();
  const mm = state.libData && state.libData.meta ? state.libData.meta : {};
  for (const m of Object.values(mm))
    for (const a of (m.author || [])) if (a) set.add(String(a).trim());
  return [...set].filter(Boolean).sort(tagCompare);
}
function renderTagChips() {
  const box = $('#lib-tag-chips');
  // v0.4.3：旧标签 chips 容器已由搜索功能区的「按标签」附加条件取代，强制常隐，
  // 避免旧 searchMode 命中时在没有勾选的情况下显示标签。
  if (box) box.classList.add('hidden');
  if (!box) return;
  const tags = allTags();
  if (!tags.size) { box.innerHTML = ''; return; }
  let html = `<span class="tag-chip${!state.libTagFilter ? ' active' : ''}" data-tag="">全部</span>`;
  for (const [name, color] of tags)
    html += `<span class="tag-chip${state.libTagFilter === name ? ' active' : ''}" data-tag="${escapeHtml(name)}" style="--tag-c:${safeTagColor(color, name)}">${escapeHtml(name)}</span>`;
  box.innerHTML = html;
  box.querySelectorAll('.tag-chip').forEach(ch => ch.onclick = () => {
    state.libTagFilter = ch.dataset.tag || null;
    applyFilterView();
    renderTagChips();
    renderLibTree();
    renderCurrentView();
  });
}
function renderAuthorChips() {
  const box = $('#lib-author-chips');
  if (!box) return;
  // v0.4.3：旧作者 chips 容器已由搜索功能区的「按作者」附加条件取代，强制常隐。
  box.classList.add('hidden');
  const authors = allAuthors();
  if (!authors.length) { box.innerHTML = ''; return; }
  let html = `<span class="tag-chip${!state.libAuthorFilter ? ' active' : ''}" data-author="">全部</span>`;
  for (const name of authors)
    html += `<span class="tag-chip${state.libAuthorFilter === name ? ' active' : ''}" data-author="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
  box.innerHTML = html;
  box.querySelectorAll('.tag-chip').forEach(ch => ch.onclick = () => {
    state.libAuthorFilter = ch.dataset.author || null;
    applyFilterView();
    renderAuthorChips();
    renderLibTree();
    renderCurrentView();
  });
}
// 左侧目录树 / 大类网格：用组级标签判断该组是否应出现
function matchTag(g) { return !state.libTagFilter || tagHit(g.rel, state.libTagFilter); }
// 标签检索结果：只返回「组」级（标签现在只属于组）
function collectTagResults(tag) {
  const out = [];
  const D = state.libData;
  if (!D || !tag) return out;
  for (const c of D.categories) for (const g of c.groups) {
    if (tagHit(g.rel, tag))
      out.push({ kind: 'group', name: g.displayName, path: g.path, icon: '🗂',
        sub: `${c.name} · ${g.fileCount} 文件 · ${fmtSize(g.totalSize)}` });
  }
  return out.sort((a, b) => tagCompare(a.name, b.name));
}
// 作者检索结果：只返回「组」级（作者现在只属于组）
function collectAuthorResults(author) {
  const out = [];
  const D = state.libData;
  if (!D || !author) return out;
  const mm = D.meta || {};
  for (const c of D.categories) for (const g of c.groups) {
    const m = mm[g.rel];
    if (m && (m.author || []).some(a => String(a == null ? '' : a).trim() === author))
      out.push({ kind: 'group', name: g.displayName, path: g.path, icon: '🗂',
        sub: `${c.name} · ${g.fileCount} 文件 · ${fmtSize(g.totalSize)}` });
  }
  return out.sort((a, b) => tagCompare(a.name, b.name));
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
      // 组数过多时默认只显示前 10 个，点「展开」显示全部、可再收起
      const TREE_GROUP_LIMIT = 10;
      const allOpen = state.libGroupsExpanded.has(cat.path);
      const truncated = shown.length > TREE_GROUP_LIMIT && !allOpen;
      const visible = truncated ? shown.slice(0, TREE_GROUP_LIMIT) : shown;
      for (const g of visible) {
        const row = document.createElement('div');
        row.className = 'group-row' + (state.libSel?.type === 'group' && state.libSel.data.path === g.path ? ' selected' : '');
        const dots = [...(g.tags || [])].sort((a, b) => tagCompare(a.name, b.name)).map(t => `<i class="tag-dot" style="background:${safeTagColor(t.color, t.name)}" title="${escapeHtml(t.name)}"></i>`).join('');
        row.innerHTML = `<span class="g-seq">${g.seq != null ? String(g.seq).padStart(4, '0') : '—'}</span>
          <span class="g-name" title="${escapeHtml(g.path)}">${escapeHtml(g.displayName)}</span>
          <span class="g-dotwrap">${dots}</span>
          <span class="g-meta">${g.fileCount} 文件 · ${fmtSize(g.totalSize)}</span>`;
        row.onclick = () => gotoGroup(g);
        wrap.appendChild(row);
      }
      if (shown.length > TREE_GROUP_LIMIT) {
        const more = document.createElement('div');
        more.className = 'group-more';
        more.textContent = allOpen
          ? '收起'
          : `展开剩余 ${shown.length - TREE_GROUP_LIMIT} 个组`;
        more.onclick = () => {
          if (allOpen) state.libGroupsExpanded.delete(cat.path);
          else state.libGroupsExpanded.add(cat.path);
          renderLibTree();
        };
        wrap.appendChild(more);
      }
      box.appendChild(wrap);
    }
  }
}

// ---------- 大类视图（中：组预览图网格分页 + 右：大类详情） ----------
function showCategoryView(cat) {
  state.view = 'cat';
  $('#btn-new-lib-inline').classList.add('hidden');
  updateNewCatButton();
  const groups = cat.groups.filter(matchTag);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  $('#preview-name').textContent = `大类：${cat.name} · ${groups.length} 组`;
  const tiles = slice.map((g, i) => `
    <div class="tile g-tile${selClass(g.path)}" data-i="${i}"${cardDataAttr('group', g.path, g.displayName)}>
      <div class="t-slot">
        ${g.cover ? `<img src="${escapeHtml(fileUrl(g.cover))}" alt="">` : '<span class="cover-fallback">📚</span>'}
        ${(g.tags && g.tags.length) ? `<div class="t-tags">${[...g.tags].sort((a, b) => tagCompare(a.name, b.name)).map(t => `<i style="background:${safeTagColor(t.color, t.name)}" title="${escapeHtml(t.name)}"></i>`).join('')}</div>` : ''}
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

let filterInfo = { list: [], kw: '', cat: '全部', tag: null, author: null, mode: 'plain' };
function showFilterDetails() {
  const { list, kw, cat, tag, author, mode } = filterInfo;
  const groupMode = mode === 'tag' || mode === 'author';
  const countByCat = {};
  if (mode === 'plain') for (const x of list) countByCat[x.file.category] = (countByCat[x.file.category] || 0) + 1;
  const catStat = Object.entries(countByCat).map(([c, n]) => detailRow(ICONS[c] + ' ' + c, n + ' 个')).join('');
  const modeLabel = mode === 'tag' ? '标签检索结果' : mode === 'author' ? '作者检索结果' : '检索结果';
  $('#detail-body').innerHTML = `<div class="detail-rows">
    ${detailRow('类型', modeLabel)}
    ${kw ? detailRow('关键词', escapeHtml(kw)) : ''}
    ${cat !== '全部' ? detailRow('类型筛选', cat) : ''}
    ${tag ? detailRow('标签筛选', escapeHtml(tag)) : ''}
    ${author ? detailRow('作者筛选', escapeHtml(author)) : ''}
    ${detailRow(groupMode ? '结果组数' : '文件总数', list.length + ' 个')}
    ${mode === 'plain' ? detailRow('总大小', fmtSize(list.reduce((s, x) => s + x.file.size, 0))) : ''}
  </div>
  ${catStat ? `<div class="box-title" style="padding:8px 0 4px">按类型</div><div class="detail-rows">${catStat}</div>` : ''}
  <div class="hint" style="margin-top:8px">单击查看信息，双击进入；清空筛选条件返回文库浏览</div>`;
}

function showLibFilterView() {
  state.view = 'search';
  $('#btn-new-lib-inline').classList.add('hidden');
  updateNewCatButton();
  const kw = state.libSearch.toLowerCase();
  const tag = state.libTagFilter;
  const author = state.libAuthorFilter;
  let list, mode;
  if (tag) {
    // 标签模式：只返回命中该标签的「组」
    mode = 'tag';
    list = collectTagResults(tag);
    if (kw) list = list.filter(x => x.name.toLowerCase().includes(kw));
  } else if (author) {
    // 作者模式：只返回拥有该作者的「组」
    mode = 'author';
    list = collectAuthorResults(author);
    if (kw) list = list.filter(x => x.name.toLowerCase().includes(kw));
  } else {
    mode = 'plain';
    list = getLibFiles();
    if (state.libCatFilter !== '全部') list = list.filter(x => x.file.category === state.libCatFilter);
    if (kw) list = list.filter(x => x.file.name.toLowerCase().includes(kw));
    list.sort((a, b) => tagCompare(a.file.name, b.file.name));
  }
  filterInfo = { list, kw, cat: state.libCatFilter, tag, author, mode };

  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.libPageNum > pages) state.libPageNum = 1;
  const page = state.libPageNum;
  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const conds = [state.libSearch ? `关键词“${state.libSearch}”` : null,
    state.libCatFilter !== '全部' ? `类型：${state.libCatFilter}` : null,
    tag ? `标签：${tag}` : null,
    author ? `作者：${author}` : null].filter(Boolean).join(' + ');
  $('#preview-name').textContent = `搜索结果${conds ? '：' + conds : ''} · ${list.length} 项`;
  const tiles = slice.map((x, i) => {
    if (mode === 'tag' || mode === 'author') return `
    <div class="tile f-tile${selClass(x.path)}" data-i="${i}"${cardDataAttr(x.kind, x.path, x.name)}>
      <div class="t-slot with-icon"><span class="t-icon">${x.icon}</span></div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div>
        <div class="t-size">${escapeHtml(x.sub)}</div>
      </div>
      <span class="tile-level">${mode === 'author' ? '组' : (escapeHtml(KIND_LABEL[x.kind] || ''))}</span>
    </div>`;
    return `
    <div class="tile f-tile${selClass(x.file.path)}" data-i="${i}"${cardDataAttr('file', x.file.path, x.file.name)}>
      <div class="t-slot with-icon"${(x.file.category === '图片' || x.file.category === '视频') ? ` data-thumb="${escapeHtml(x.file.path)}"` : ''}><span class="t-icon">${ICONS[x.file.category] || '📃'}</span></div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(x.file.name)}">${escapeHtml(x.file.name)}</div>
        <div class="t-size">${escapeHtml(x.group.displayName)} · ${fmtSize(x.file.size)}</div>
      </div>
      ${OPS_HTML}
    </div>`;
  }).join('');
  const body = $('#preview-body');
  body.innerHTML = list.length
    ? `<div class="grid-wrap"><div class="tile-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`
    : `<div class="preview-placeholder"><div class="big">🔍</div><div>没有匹配的结果</div><div class="empty-sub">换个标签 / 作者，或调整关键词再试试</div></div>`;

  hydrateThumbs(body);
  bindPager(body, showLibFilterView);
  refreshDetails();
  navCommit();
}

// ---------- 组视图（中：文件平铺 + 右：组详情） ----------
// ---------- 组视图（中：文件平铺 + 右：组详情含标签） ----------
function showGroupPreview(g, cat) {
  state.view = 'group';
  $('#btn-new-lib-inline').classList.add('hidden');
  updateNewCatButton();
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
      <div class="t-slot with-icon"${(f.category === '图片' || f.category === '视频') ? ` data-thumb="${escapeHtml(f.path)}"` : ''}><span class="t-icon">${ICONS[f.category] || '📃'}</span></div>
      <div class="t-foot">
        <div class="t-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="t-size">${fmtSize(f.size)}</div>
      </div>
      ${OPS_HTML}
    </div>`).join('');
  body.innerHTML = `<div class="grid-wrap"><div class="tile-grid">${tiles}</div>${pagerHTML(page, pages)}</div>`;
  hydrateThumbs(body);
  bindPager(body, () => showGroupPreview(g, cat));
  refreshDetails();
  navCommit();
}


// 组详情（右）：统计信息 + 3 类维护信息（含上级继承）+ 预览图操作
function showGroupDetails(g) {
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
    ${detailRow('路径', escapeHtml(g.path))}
  </div>
  ${metaBlockHTML(g.rel, g.displayName)}
  <button id="btn-open-group" class="ghost-btn" style="margin-top:8px">打开组文件夹</button>
  <button id="btn-set-cover" class="ghost-btn" style="margin-top:6px">设置预览图</button>
  ${g.files.length ? `<div class="box-title" style="padding:10px 0 4px">组内文件（前 ${Math.min(30, g.files.length)} 个）</div>
    <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;max-height:36%;overflow-y:auto">${fileList}</div>`
    : '<div class="hint" style="margin-top:10px">组内暂无文件，点击「添加文件到组」</div>'}`;

  $('#btn-open-group').onclick = () => window.api.showInFolder(g.path);
  bindMetaEdit(g.rel, g.displayName);
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

// 新建大类：文库首页（大类网格）与大类页面（组网格）的阅览区上方都可进入
$('#btn-new-cat-inline').onclick = () => openCatCreateModal();
function openCatCreateModal() {
  if (!state.libRoot || !state.libData) { toast('请先创建或选择一个文库', true); return; }
  showModal('新建大类', `
    <label class="field-label">所属文库</label>
    <div class="hint" style="margin:0 0 8px">${escapeHtml(state.libData.name || state.libRoot)}</div>
    <label class="field-label">大类名称</label>
    <input id="m-cat-name" placeholder="例如：画集" spellcheck="false">
    <div class="hint">将在文库目录下新建一个同名文件夹。名称不能与现有大类重复（Windows 下不区分大小写），也不能包含 \\ / : * ? " < > | 等字符。建好后可用左侧「新建组」或「批量添加」往里放文件</div>`, async () => {
    const name = $('#m-cat-name').value.trim();
    if (!name) { toast('请输入大类名称', true); return true; }
    const r = await window.api.libCreateCategory(state.libRoot, name);
    if (r.error) { toast(r.error, true); return true; }
    toast(`已创建大类：${r.name}`);
    state.libSel = null;
    state.libPreviewFile = null;
    state.libExpanded.add(r.name);
    clearLibFilters();
    state.view = 'lib';
    await loadLibrary(true);
    const idx = (state.libData?.categories || []).findIndex(c => c.path === r.path);
    state.libPageNum = idx >= 0 ? Math.floor(idx / PAGE_SIZE) + 1 : 1;
    renderCurrentView();
    renderLibTree();
    renderBreadcrumb();
  }, '创建');
}
$('#btn-open-lib-root').onclick = () => {
  if (!state.libRoot) { toast('请先创建或选择一个文库', true); return; }
  window.api.showInFolder(state.libRoot);
};

function openLibCreateModal(prev = {}) {
  showModal('新建文库', `
    <label class="field-label">位置</label>
    <div class="search-row"><input id="m-lib-path" placeholder="点击右侧「选择…」指定创建位置" readonly value="${escapeHtml(prev.path || '')}"><button id="m-lib-pick" type="button">选择…</button></div>
    <label class="field-label">文库名称</label>
    <input id="m-lib-name" placeholder="例如：我的资料库" spellcheck="false" value="${escapeHtml(prev.name || '')}">
    <div class="hint">将在所选位置创建以名称命名的文件夹，内含默认大类（大类1/大类2）与独立账本</div>`, async () => {
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
  if (!state.libData.categories.length) {
    toast('当前文库还没有大类，请先点击阅览区上方「新建大类」', true);
    return;
  }
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
  else toast(`已移动 ${r.done.length} 个文件到「${g.displayName}」（原位置不再保留）`);
  addRecentAdded(r.done, state.libData && state.libData.name);
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

// ---------- 批量添加：单页表单（5 项依次排列） ----------
// 表单状态独立于 DOM：系统对话框不可用时内置选择器会临时占用通用弹窗，
// 关闭后重新渲染即可恢复，已填内容不会丢失。
const BA_TAG_COLORS = META_TAG_COLORS;
function batchTagColor(name) { return metaTagColor(name); }
function batchTagChipsHtml(tags) {
  return sortTagNames(tags).map(t => `<span class="tag-chip mini" style="--tag-c:${batchTagColor(t)}">${escapeHtml(t)}<i class="tag-x" data-ba-x="${escapeHtml(t)}" title="移除">✕</i></span>`).join('');
}

function batchLocRow(b, loc, text, kindText, cls) {
  const sel = b.loc && b.loc.level === loc.level && b.loc.path === loc.path ? ' picked' : '';
  return `<div class="ip-item ba-loc ${cls}${sel}" data-level="${loc.level}" data-path="${escapeHtml(loc.path)}" data-lib="${escapeHtml(loc.libPath)}" data-cat="${escapeHtml(loc.catName || '')}" data-label="${escapeHtml(loc.label)}">${text}<span class="ba-loc-tag">${kindText}</span></div>`;
}
function batchLocHTML(b) {
  const rows = [];
  for (const lib of b.locations) {
    rows.push(batchLocRow(b,
      { level: 'lib', path: lib.path, libPath: lib.path, catName: '', label: lib.name },
      `📚 ${escapeHtml(lib.name)}`, '整个文库', 'ba-loc-lib'));
    for (const c of lib.categories) {
      const catLabel = `${lib.name} / ${c.name}`;
      rows.push(batchLocRow(b,
        { level: 'cat', path: c.path, libPath: lib.path, catName: c.name, label: catLabel },
        `📁 ${escapeHtml(c.name)}`, '大类', 'ba-loc-cat'));
      for (const g of c.groups) {
        rows.push(batchLocRow(b,
          { level: 'group', path: g.path, libPath: lib.path, catName: c.name, label: `${catLabel} / ${g.displayName}` },
          `🗂 ${escapeHtml(g.displayName)}`, '组', 'ba-loc-group'));
      }
    }
  }
  return rows.length ? rows.join('')
    : '<div class="hint" style="padding:8px">还没有可用文库，请先在左侧「新建」一个</div>';
}
function batchCatOptions(b) {
  const lib = b.locations.find(l => l.path === b.loc.libPath);
  const cats = lib ? lib.categories : [];
  return cats.map(c => `<option value="${escapeHtml(c.name)}"${b.catChoice === c.name ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')
    + `<option value="__new__"${b.catChoice === '__new__' ? ' selected' : ''}>＋ 新建大类…</option>`;
}
function suggestBatchGroupName(b) {
  if (b.sources.length === 1) {
    const n = baseName(b.sources[0]).replace(/\.[^./\\]+$/, '');
    if (n) return n;
  }
  const d = new Date(), p = x => String(x).padStart(2, '0');
  return `批量导入_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function renderBatchForm() {
  const b = batchState;
  if (!b) return;
  const needGroup = b.loc && b.loc.level !== 'group';
  const srcHTML = b.sources.length
    ? b.sources.map((p, i) => `<div class="ba-item"><span>📄</span><span class="ba-name" title="${escapeHtml(p)}">${escapeHtml(baseName(p))}</span><span class="ba-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span><span class="ba-x" data-ba-src="${i}" title="移除">✕</span></div>`).join('')
    : '<div class="hint" style="padding:6px">尚未选择。可反复点击「选择文件」/「选择文件夹」累加。</div>';
  const html = `
    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">1</span>待添加的文件（文件夹或多个文件）</div>
      <div class="ba-tools">
        <button id="ba-pick-files" type="button">选择文件（可多选）</button>
        <button id="ba-pick-folder" type="button">选择文件夹</button>
        <button id="ba-clear" type="button">清空</button>
      </div>
      <div class="ba-list">${srcHTML}</div>
      <div class="hint">共 ${b.sources.length} 项。选择文件夹时会递归展开其中所有文件（跳过隐藏文件），平铺放入目标组；目标文库内部已归档的文件会被跳过，避免打乱原有归档。<b>本操作为「移动」：添加成功后原位置不再保留</b>，源文件夹本身会保留（可能变空）。</div>
    </div>

    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">2</span>添加到哪个位置（文件库 / 大类 / 组）</div>
      <div class="ba-loc-list">${batchLocHTML(b)}</div>
      <div class="ba-summary">当前位置：<b>${b.loc ? escapeHtml(b.loc.label) : '尚未选择'}</b></div>
      ${needGroup ? `
        <label class="field-label">新组名称（留空自动命名：${escapeHtml(suggestBatchGroupName(b))}）</label>
        <input id="ba-group-name" placeholder="留空则自动命名" value="${escapeHtml(b.groupName)}" spellcheck="false">
        ${b.loc.level === 'lib' ? `
          <label class="field-label">归入大类</label>
          <select id="ba-cat">${batchCatOptions(b)}</select>
          ${b.catChoice === '__new__' ? `<input id="ba-new-cat" placeholder="输入新大类名称" value="${escapeHtml(b.newCatName)}" spellcheck="false">` : ''}
        ` : ''}
        <div class="hint">选「整个文库」或「大类」时会自动新建一个组存放本批文件；选「组」则直接加入该组。</div>
      ` : '<div class="hint">本批文件会直接移动进所选的组，成功后原位置不再保留。</div>'}
    </div>

    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">3</span>本批文件的作者（保存到组，可多选）</div>
      <input id="ba-author" placeholder="多个用「、」分隔，留空则不填写" value="${escapeHtml(b.author)}" spellcheck="false">
      ${authorBankSectionHTML(b.authorQuery || '', '候选是各文库当前仍在使用的作者；点一下加入、再点一下移除，选中的会进入上方输入框。')}
      <div class="hint">作为本批所属「组」的作者保存；往同一组反复添加会合并保留，不会互相覆盖。</div>
    </div>

    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">4</span>本批文件的标签（可添加多个）</div>
      <div class="ba-row">
        <input id="ba-tag-input" placeholder="输入标签后回车，或点「添加」" spellcheck="false">
        <button id="ba-tag-add" type="button">添加</button>
      </div>
      <div class="ba-chips">${b.tags.length ? batchTagChipsHtml(b.tags) : '<span class="hint">尚未添加标签</span>'}</div>
      ${tagBankSectionHTML(b.tbQuery || '', '候选是各文库当前仍在使用的标签；点一下加入、再点一下移除，选中的会进入上方标签列表。')}
      <div class="hint">作为本批所属「组」的标签保存；在「搜索」中切换到按标签模式即可按此筛选组。</div>
    </div>`;
  showModal('批量添加', html, submitBatch, '开始添加', () => { batchState = null; },
    { wide: true, enterOK: false, noFocus: true });
  bindBatchEvents();
}

function bindBatchEvents() {
  const b = batchState;
  const body = $('#modal-body');
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#ba-pick-files', async () => {
    const picked = await pickFilesSafe();
    if (picked && picked.length) for (const p of picked) if (!b.sources.includes(p)) b.sources.push(p);
    if (batchState) renderBatchForm();
  });
  on('#ba-pick-folder', async () => {
    const p = await pickFolderSafe();
    if (p && !b.sources.includes(p)) b.sources.push(p);
    if (batchState) renderBatchForm();
  });
  on('#ba-clear', () => { b.sources = []; renderBatchForm(); });
  body.querySelectorAll('[data-ba-src]').forEach(el => el.onclick = () => {
    b.sources.splice(parseInt(el.dataset.baSrc), 1);
    renderBatchForm();
  });
  body.querySelectorAll('.ba-loc').forEach(el => el.onclick = () => {
    b.loc = {
      level: el.dataset.level, path: el.dataset.path, libPath: el.dataset.lib,
      catName: el.dataset.cat || '', label: el.dataset.label
    };
    if (b.loc.level === 'lib') {
      const lib = b.locations.find(l => l.path === b.loc.libPath);
      b.catChoice = lib && lib.categories.length ? lib.categories[0].name : '__new__';
    }
    renderBatchForm();
  });
  const bindVal = (sel, key) => {
    const el = $(sel);
    if (el) el.addEventListener('input', () => { b[key] = el.value; });
  };
  let authorBankRepaint = () => {};
  bindVal('#ba-author', 'author');
  bindVal('#ba-group-name', 'groupName');
  bindVal('#ba-new-cat', 'newCatName');
  const authorInp = $('#ba-author');
  if (authorInp) authorInp.addEventListener('input', () => authorBankRepaint());
  const catSel = $('#ba-cat');
  if (catSel) catSel.onchange = () => { b.catChoice = catSel.value; renderBatchForm(); };
  const addTag = () => {
    const inp = $('#ba-tag-input');
    if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    if (!b.tags.includes(v)) { b.tags.push(v); b.tags = sortTagNames(b.tags); }
    b.focusTag = true;
    renderBatchForm();
  };
  on('#ba-tag-add', addTag);
  const tagInp = $('#ba-tag-input');
  if (tagInp) bindEnter(tagInp, addTag);   // 回车添加标签（输入法选字时不触发）
  body.querySelectorAll('[data-ba-x]').forEach(el => el.onclick = () => {
    b.tags = b.tags.filter(t => t !== el.dataset.baX);
    renderBatchForm();
  });
  authorBankRepaint = bindAuthorBankSection({
    scope: body,
    getNames: () => splitMetaList($('#ba-author') ? $('#ba-author').value : b.author),
    setNames: (ns) => { b.author = sortTagNames(ns).join('、'); renderBatchForm(); },
    onQuery: (q) => { b.authorQuery = q; },
    getPage: () => b.authorPage, setPage: (v) => { b.authorPage = v; },
    onAfter: () => {}          // setNames 已整表重绘
  });
  bindTagBankSection({
    scope: body,
    getNames: () => b.tags,
    setNames: (ns) => { b.tags = sortTagNames(ns); renderBatchForm(); },
    onQuery: (q) => { b.tbQuery = q; },
    getPage: () => b.tbPage, setPage: (v) => { b.tbPage = v; },
    onAfter: () => {}          // setNames 已整表重绘，无需再画旧节点
  });
  if (b.focusTag) {
    b.focusTag = false;
    const inp = $('#ba-tag-input');
    if (inp) setTimeout(() => inp.focus(), 20);
  }
}

async function submitBatch() {
  const b = batchState;
  if (!b || b.busy) return true;
  const grab = (sel, key) => { const el = $(sel); if (el) b[key] = el.value; };
  grab('#ba-author', 'author');
  grab('#ba-group-name', 'groupName'); grab('#ba-new-cat', 'newCatName');
  if (!b.sources.length) { toast('请先选择待添加的文件或文件夹', true); return true; }
  if (!b.loc) { toast('请选择添加到的位置', true); return true; }
  const target = {
    level: b.loc.level,
    path: b.loc.path,
    categoryName: b.loc.catName || '',
    groupName: (b.groupName || '').trim() || suggestBatchGroupName(b)
  };
  if (b.loc.level === 'lib') {
    if (b.catChoice === '__new__') {
      const n = (b.newCatName || '').trim();
      if (!n) { toast('请填写新建大类的名称', true); return true; }
      target.newCategoryName = n;
      target.categoryName = n;
    } else if (b.catChoice) target.categoryName = b.catChoice;
  }
  b.busy = true;
  const okBtn = $('#modal-ok');
  okBtn.disabled = true;
  okBtn.textContent = '正在添加…';
  let r;
  try {
    r = await window.api.libBatchAdd({
      root: b.loc.libPath, target, sources: b.sources,
      author: b.author, tags: b.tags
    });
  } catch (err) {
    b.busy = false; okBtn.disabled = false; okBtn.textContent = '开始添加';
    toast('批量添加失败：' + err.message, true);
    return true;
  }
  b.busy = false;
  okBtn.disabled = false;
  okBtn.textContent = '开始添加';
  if (r.error) { toast(r.error, true); return true; }
  toast(`已移动 ${r.done} 个文件（原位置不再保留）${r.failed.length ? `，${r.failed.length} 个失败` : ''}${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`);
  addRecentAdded(r.added, r.root);
  const root = r.root, groupPath = r.groupPath;
  batchState = null;
  if (root !== state.libRoot) await selectLibrary(root);
  else await loadLibrary(true);
  const g = state.libData ? findGroup(state.libData, groupPath) : null;
  if (g) {
    state.libExpanded.add(parentName(g.path));
    gotoGroup(g);                 // 右侧直接显示本组文件的批次信息
  } else {
    renderLibTree();
    renderCurrentView();
  }
  return;
}

async function openBatchAdd() {
  const fresh = {
    sources: [], locations: [], loc: null,
    groupName: '', catChoice: '', newCatName: '',
    author: '', tags: [], busy: false, focusTag: false, tbQuery: '', authorQuery: '',
    tbPage: 1, authorPage: 1
  };
  try { fresh.locations = await window.api.libLocations(); } catch { fresh.locations = []; }
  if (!fresh.locations.length) { toast('请先创建或选择一个可用的文库', true); return; }
  const cur = fresh.locations.find(l => l.path === state.libRoot) || fresh.locations[0];
  fresh.loc = { level: 'lib', path: cur.path, libPath: cur.path, catName: '', label: cur.name };
  fresh.catChoice = cur.categories.length ? cur.categories[0].name : '__new__';
  try { await Promise.all([refreshTagBanks(), refreshAuthorBanks()]); }
  catch { tagBankData = []; authorBankData = []; }
  batchState = fresh;
  renderBatchForm();
}
$('#btn-batch-add').onclick = openBatchAdd;

// ---------- 清除缩略图缓存（v0.4.5）：先弹窗展示各文库占用，确认后一键清除 ----------
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
$('#btn-clear-thumbs').onclick = async () => {
  let s;
  try { s = await window.api.thumbStats(); } catch { toast('读取缓存信息失败', true); return; }
  const libs = (s && s.libs) || [];
  const rows = libs.length
    ? libs.map(l => `<div class="thumb-stat-row"><span>${escapeHtml(l.name)}</span><span>${fmtBytes(l.bytes)} · ${l.count} 张</span></div>`).join('')
    : '<div class="hint">当前没有已登记的文库</div>';
  const bodyHTML = `
    <div class="thumb-stat-list">${rows}</div>
    <div class="thumb-stat-total">合计：${fmtBytes(s ? s.totalBytes : 0)} · ${s ? s.totalCount : 0} 张</div>
    <div class="hint" style="margin-top:10px">清除后再次浏览图片时会按需重新生成；原始文件不会受影响。</div>`;
  showModal('清除缩略图缓存', bodyHTML, async () => {
    try {
      const r = await window.api.thumbClear();
      toast(r && r.ok ? `已清除缩略图缓存（${r.removed} 个文件）` : '清除失败', !(r && r.ok));
      // 已缓存的图片链接会失效：重绘当前视图让图片回退到图标，
      // 但抑制这一次重绘的缩略图生成，避免「清完又立刻生成一批」。
      if (r && r.ok) {
        thumbSuppress = true;
        try { renderCurrentView(); } finally { thumbSuppress = false; }
      }
    } catch { toast('清除失败', true); }
  }, '确认清除');
};

// ---------- 批量添加（组）：每个文件/文件夹各建一个组，全部归入同一个大类 ----------
// 与「批量添加（文件）」共用标签库 / 作者库 / 位置列表等控件，只是位置只到「大类」级、
// 组名由来源自动决定，作者 / 标签写在本批新建的每一个组上。
let batchGroupState = null;   // 独立于 batchState，避免两个弹窗状态互相污染

function batchGroupLocHTML(b) {
  const rows = [];
  for (const lib of b.locations) {
    rows.push(batchLocRow(b,
      { level: 'lib', path: lib.path, libPath: lib.path, catName: '', label: lib.name },
      `📚 ${escapeHtml(lib.name)}`, '整个文库', 'ba-loc-lib'));
    for (const c of lib.categories) {
      const catLabel = `${lib.name} / ${c.name}`;
      rows.push(batchLocRow(b,
        { level: 'category', path: c.path, libPath: lib.path, catName: c.name, label: catLabel },
        `📁 ${escapeHtml(c.name)}`, '大类', 'ba-loc-cat'));
    }
  }
  return rows.length ? rows.join('')
    : '<div class="hint" style="padding:8px">还没有可用文库，请先在左侧「新建」一个</div>';
}

function renderBatchGroupForm() {
  const b = batchGroupState;
  if (!b) return;
  const srcHTML = b.sources.length
    ? b.sources.map((s, i) => `<div class="ba-item"><span>${s.kind === 'dir' ? '📁' : '📄'}</span><span class="ba-name" title="${escapeHtml(s.path)}">${escapeHtml(baseName(s.path))}</span><span class="ba-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</span><span class="ba-x" data-bg-src="${i}" title="移除">✕</span></div>`).join('')
    : '<div class="hint" style="padding:6px">尚未选择。可反复点击「选择文件」「选择文件夹」累加。</div>';
  const filesCount = b.sources.filter(s => s.kind === 'file').length;
  const dirsCount = b.sources.filter(s => s.kind === 'dir').length;
  const mixed = filesCount > 0 && dirsCount > 0;
  const libLevel = b.loc && b.loc.level === 'lib';
  const html = `
    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">1</span>待添加的来源（每个文件 / 文件夹各建一个组）</div>
      <div class="ba-tools">
        <button id="bg-pick-files" type="button">选择文件（可多选）</button>
        <button id="bg-pick-dirs" type="button">选择文件夹（可多选）</button>
        <button id="bg-clear" type="button">清空</button>
      </div>
      <div class="ba-list">${srcHTML}</div>
      <div class="hint">共 ${b.sources.length} 项${b.sources.length ? `（${filesCount} 个文件 · ${dirsCount} 个文件夹）` : ''}。
        选择<b>文件</b>：每个文件建一个同名组，文件移动进去；选择<b>文件夹</b>：每个文件夹建一个同名组，里面的文件平铺移动进去（<b>文件夹内不能再含子文件夹</b>，否则整批失败并提示）。
        <b>文件和文件夹不能混选</b>。本操作为「移动」：成功后原位置不再保留。</div>
      ${mixed ? '<div class="hint" style="color:var(--danger)">⚠ 文件和文件夹不能混在一起添加，请移除其中一类再继续。</div>' : ''}
    </div>

    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">2</span>新建的组统一归入哪个大类</div>
      <div class="ba-loc-list">${batchGroupLocHTML(b)}</div>
      <div class="ba-summary">当前位置：<b>${b.loc ? escapeHtml(b.loc.label) : '尚未选择'}</b></div>
      ${libLevel ? `
        <label class="field-label">归入大类</label>
        <select id="bg-cat">${batchCatOptions(b)}</select>
        ${b.catChoice === '__new__' ? `<input id="bg-new-cat" placeholder="输入新大类名称" value="${escapeHtml(b.newCatName)}" spellcheck="false">` : ''}
        <div class="hint">选「整个文库」时需指定一个大类；本批所有新组都放进这一个大类。选「大类」则直接归入该大类。</div>
      ` : '<div class="hint">本批所有新组都会放进上面选中的大类。</div>'}
    </div>

    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">3</span>本批组的作者（保存到每个新组，可多选）</div>
      <input id="bg-author" placeholder="多个用「、」分隔，留空则不填写" value="${escapeHtml(b.author)}" spellcheck="false">
      ${authorBankSectionHTML(b.authorQuery || '', '候选是各文库当前仍在使用的作者；点一下加入、再点一下移除，选中的会写进本批每一个组。')}
      <div class="hint">本批创建的每个组都会保存这些作者。</div>
    </div>

    <div class="ba-sec">
      <div class="ba-sec-head"><span class="ba-num">4</span>本批组的标签（保存到每个新组，可添加多个）</div>
      <div class="ba-row">
        <input id="bg-tag-input" placeholder="输入标签后回车，或点「添加」" spellcheck="false">
        <button id="bg-tag-add" type="button">添加</button>
      </div>
      <div class="ba-chips">${b.tags.length ? batchTagChipsHtml(b.tags) : '<span class="hint">尚未添加标签</span>'}</div>
      ${tagBankSectionHTML(b.tbQuery || '', '候选是各文库当前仍在使用的标签；点一下加入、再点一下移除，选中的会写进本批每一个组。')}
      <div class="hint">本批创建的每个组都会保存这些标签；在「搜索」中按标签即可筛到这些组。</div>
    </div>`;
  showModal('批量添加（组）', html, submitBatchGroups, '开始添加', () => { batchGroupState = null; },
    { wide: true, enterOK: false, noFocus: true });
  bindBatchGroupEvents();
}

function bindBatchGroupEvents() {
  const b = batchGroupState;
  const body = $('#modal-body');
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#bg-pick-files', async () => {
    const picked = await pickFilesSafe();
    if (picked && picked.length) for (const p of picked) if (!b.sources.some(s => s.path === p)) b.sources.push({ path: p, kind: 'file' });
    if (batchGroupState) renderBatchGroupForm();
  });
  on('#bg-pick-dirs', async () => {
    const picked = await pickFoldersSafe();
    if (picked && picked.length) for (const p of picked) if (!b.sources.some(s => s.path === p)) b.sources.push({ path: p, kind: 'dir' });
    if (batchGroupState) renderBatchGroupForm();
  });
  on('#bg-clear', () => { b.sources = []; renderBatchGroupForm(); });
  body.querySelectorAll('[data-bg-src]').forEach(el => el.onclick = () => {
    b.sources.splice(parseInt(el.dataset.bgSrc), 1);
    renderBatchGroupForm();
  });
  body.querySelectorAll('.ba-loc').forEach(el => el.onclick = () => {
    b.loc = {
      level: el.dataset.level, path: el.dataset.path, libPath: el.dataset.lib,
      catName: el.dataset.cat || '', label: el.dataset.label
    };
    if (b.loc.level === 'lib') {
      const lib = b.locations.find(l => l.path === b.loc.libPath);
      b.catChoice = lib && lib.categories.length ? lib.categories[0].name : '__new__';
    }
    renderBatchGroupForm();
  });
  const bindVal = (sel, key) => {
    const el = $(sel);
    if (el) el.addEventListener('input', () => { b[key] = el.value; });
  };
  let authorBankRepaint = () => {};
  bindVal('#bg-author', 'author');
  bindVal('#bg-new-cat', 'newCatName');
  const authorInp = $('#bg-author');
  if (authorInp) authorInp.addEventListener('input', () => authorBankRepaint());
  const catSel = $('#bg-cat');
  if (catSel) catSel.onchange = () => { b.catChoice = catSel.value; renderBatchGroupForm(); };
  const addTag = () => {
    const inp = $('#bg-tag-input');
    if (!inp) return;
    const v = inp.value.trim();
    if (!v) return;
    if (!b.tags.includes(v)) { b.tags.push(v); b.tags = sortTagNames(b.tags); }
    b.focusTag = true;
    renderBatchGroupForm();
  };
  on('#bg-tag-add', addTag);
  const tagInp = $('#bg-tag-input');
  if (tagInp) bindEnter(tagInp, addTag);
  body.querySelectorAll('[data-ba-x]').forEach(el => el.onclick = () => {
    b.tags = b.tags.filter(t => t !== el.dataset.baX);
    renderBatchGroupForm();
  });
  authorBankRepaint = bindAuthorBankSection({
    scope: body,
    getNames: () => splitMetaList($('#bg-author') ? $('#bg-author').value : b.author),
    setNames: (ns) => { b.author = sortTagNames(ns).join('、'); renderBatchGroupForm(); },
    onQuery: (q) => { b.authorQuery = q; },
    getPage: () => b.authorPage, setPage: (v) => { b.authorPage = v; },
    onAfter: () => {}
  });
  bindTagBankSection({
    scope: body,
    getNames: () => b.tags,
    setNames: (ns) => { b.tags = sortTagNames(ns); renderBatchGroupForm(); },
    onQuery: (q) => { b.tbQuery = q; },
    getPage: () => b.tbPage, setPage: (v) => { b.tbPage = v; },
    onAfter: () => {}
  });
  if (b.focusTag) {
    b.focusTag = false;
    const inp = $('#bg-tag-input');
    if (inp) setTimeout(() => inp.focus(), 20);
  }
}

async function submitBatchGroups() {
  const b = batchGroupState;
  if (!b || b.busy) return true;
  const grab = (sel, key) => { const el = $(sel); if (el) b[key] = el.value; };
  grab('#bg-author', 'author'); grab('#bg-new-cat', 'newCatName');
  if (!b.sources.length) { toast('请先选择要添加的文件或文件夹', true); return true; }
  const filesCount = b.sources.filter(s => s.kind === 'file').length;
  const dirsCount = b.sources.filter(s => s.kind === 'dir').length;
  if (filesCount && dirsCount) { toast('文件和文件夹不能混在一起添加，请移除其中一类', true); return true; }
  if (!b.loc) { toast('请选择新建组归入的大类位置', true); return true; }
  const target = {
    level: b.loc.level,
    path: b.loc.path,
    categoryName: b.loc.catName || ''
  };
  if (b.loc.level === 'lib') {
    if (b.catChoice === '__new__') {
      const n = (b.newCatName || '').trim();
      if (!n) { toast('请填写新建大类的名称', true); return true; }
      target.newCategoryName = n;
      target.categoryName = n;
    } else if (b.catChoice) target.categoryName = b.catChoice;
  }
  b.busy = true;
  const okBtn = $('#modal-ok');
  okBtn.disabled = true;
  okBtn.textContent = '正在创建…';
  let r;
  try {
    r = await window.api.libBatchAddGroups({
      root: b.loc.libPath, target, sources: b.sources.map(s => s.path),
      author: b.author, tags: b.tags
    });
  } catch (err) {
    b.busy = false; okBtn.disabled = false; okBtn.textContent = '开始添加';
    toast('批量添加（组）失败：' + err.message, true);
    return true;
  }
  b.busy = false;
  okBtn.disabled = false;
  okBtn.textContent = '开始添加';
  if (r.error) { toast(r.error, true); return true; }
  const failPart = r.failed.length ? `，${r.failed.length} 个失败（${r.failed[0].reason}）` : '';
  toast(`已创建 ${r.done} 个组${failPart}${r.skipped ? `，跳过 ${r.skipped} 个（已在文库内）` : ''}`);
  if (r.added && r.added.length) addRecentAdded(r.added, r.root);
  const root = r.root, categoryName = r.categoryName;
  batchGroupState = null;
  if (root !== state.libRoot) await selectLibrary(root);
  else await loadLibrary(true);
  // 定位到本次归入的大类
  const cat = (state.libData && state.libData.categories || []).find(c => c.name === categoryName);
  if (cat) {
    state.libSel = { type: 'category', data: cat };
    state.libPreviewFile = null;
    state.view = 'cat';
    state.libExpanded.add(cat.name);
    clearLibFilters();
    renderCurrentView();
    renderLibTree();
    renderBreadcrumb();
  } else {
    renderLibTree();
    renderCurrentView();
  }
  return;
}

async function openBatchAddGroups() {
  const fresh = {
    sources: [], locations: [], loc: null,
    catChoice: '', newCatName: '',
    author: '', tags: [], busy: false, focusTag: false, tbQuery: '', authorQuery: '',
    tbPage: 1, authorPage: 1
  };
  try { fresh.locations = await window.api.libLocations(); } catch { fresh.locations = []; }
  if (!fresh.locations.length) { toast('请先创建或选择一个可用的文库', true); return; }
  const cur = fresh.locations.find(l => l.path === state.libRoot) || fresh.locations[0];
  fresh.loc = { level: 'lib', path: cur.path, libPath: cur.path, catName: '', label: cur.name };
  fresh.catChoice = cur.categories.length ? cur.categories[0].name : '__new__';
  try { await Promise.all([refreshTagBanks(), refreshAuthorBanks()]); }
  catch { tagBankData = []; authorBankData = []; }
  batchGroupState = fresh;
  renderBatchGroupForm();
}
$('#btn-batch-add-groups').onclick = openBatchAddGroups;

// ---------- 阅览区全屏 ----------
const previewPanel = $('#preview-panel');
const fsBtn = $('#btn-fullscreen');
function setFullscreen(on) {
  previewPanel.classList.toggle('fs-fullscreen', on);
  fsBtn.textContent = on ? '退出全屏' : '全屏';
  onViewportChanged();   // 全屏后重算每页卡片数并重绘
}
fsBtn.onclick = () => setFullscreen(!previewPanel.classList.contains('fs-fullscreen'));

// 视口变化（窗口缩放 / 全屏 / 拖动分隔条）后：重算每页卡片数，必要时重绘网格。
let _vpRaf = null;
function onViewportChanged() {
  recomputePageSize();
  if (_vpRaf) cancelAnimationFrame(_vpRaf);
  _vpRaf = requestAnimationFrame(() => {
    if (state.section !== 'workbench' || state.libPreviewFile) return;
    const mask = $('#modal-mask');
    if (mask && !mask.classList.contains('hidden')) return;   // 弹窗打开时不重绘底层
    if (!['libs', 'lib', 'cat', 'group', 'search'].includes(state.view)) return;
    renderCurrentView();
  });
}
window.addEventListener('resize', onViewportChanged);
$('#btn-prev-file').onclick = () => stepPreview(-1);
$('#btn-next-file').onclick = () => stepPreview(1);

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
      onViewportChanged();   // 分隔条宽度变化后重算每页卡片数
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
setupSplitter('#split-left', '#left-panel', '--left-w', 'fm_left_w');
setupSplitter('#split-right', '#detail-panel', '--right-w', 'fm_right_w');

// ---------- 键盘 ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideModal(); setFullscreen(false); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (isComposing(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target;
  // 输入区、弹窗、以及音视频控件自己要用的方向键，一律不抢
  if (t && t.closest && t.closest('input, textarea, select, video, audio, [contenteditable="true"]')) return;
  if (!$('#modal-mask').classList.contains('hidden')) return;
  if (!state.libPreviewFile) return;
  e.preventDefault();
  stepPreview(e.key === 'ArrowLeft' ? -1 : 1);
});

// ---------- 启动 ----------
(async function init() {
  state.homeDirs = await window.api.homeDirs();
  applyHistoryHidden();
  renderSearchMode();
  buildCatChips();
  renderTagChips();
  renderAuthorChips();
  renderHistory();
  // 左侧功能导航绑定（事件委托，导航按钮常驻）
  $('#nav-rail').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (btn) setSection(btn.dataset.section);
  });
  // 三角按钮：展开 / 隐藏最左侧功能选择区（仅界面状态，不持久化）
  const navToggle = $('#nav-toggle');
  const navCollapsed0 = document.body.classList.contains('nav-collapsed');
  navToggle.textContent = navCollapsed0 ? '▶' : '◀';
  navToggle.title = navCollapsed0 ? '展开功能选择区' : '隐藏功能选择区';
  navToggle.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('nav-collapsed');
    navToggle.textContent = collapsed ? '▶' : '◀';
    navToggle.title = collapsed ? '展开功能选择区' : '隐藏功能选择区';
    onViewportChanged();   // 侧栏折叠改变阅览区宽度
  });
  await loadLibList();
  // 启动首屏：中间区域直接显示全部文库
  recomputePageSize();       // 按当前窗口宽度确定每页卡片数
  state.view = 'libs';
  showLibrariesView();
  // 每次启动都从「文库操作」开始，与旧版界面一致
  setSection(state.section);
  // 后台静默加载上次使用的文库，供左侧目录与检索直接使用（不抢占首屏）
  if (state.libRoot) {
    (async () => {
      await loadLibrary(true);
      renderBreadcrumb();
      if (state.section === 'dashboard') renderDashboard();
    })();
  }
})();
