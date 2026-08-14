'use strict';

/* ================= 我的记账本 v3 —— 纯网页 + GitHub 自动同步 =================
 * 数据模型与同步核心见 sync-core.js（window.SyncCore）。
 * 数据源：GitHub 私有仓库中的 data.json（唯一权威）；本浏览器 localStorage 为缓存。
 * 同步：本地修改 → 防抖自动推送；每 60s 检查云端变化 → 拉取并三方合并（按 id、较新 updatedAt 胜出、墓碑防复活）。
 */

const C = window.SyncCore;
const $ = (sel) => document.querySelector(sel);

const KEYS = { doc: 'bookkeeper.doc', settings: 'bookkeeper.settings', ledger: 'bookkeeper.activeLedger' };
const GITHUB_API = 'https://api.github.com';
const SYNC_INTERVAL_MS = 60000;

const state = {
  doc: null,
  activeLedgerId: null,
  byType: 'expense',
  editId: null,
  sync: { settings: null, status: 'none', sha: null, dirty: false, pushTimer: null },
};

/* ---------------- 基础工具 ---------------- */

const fmtMoney = (n) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentMonth() {
  return todayStr().slice(0, 7);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function confirmDialog(msg) {
  return window.confirm(msg);
}

/* ---------------- 本地存储 ---------------- */

function saveCache() {
  try {
    localStorage.setItem(KEYS.doc, JSON.stringify(state.doc));
  } catch (e) {
    toast('本地缓存写入失败：' + e.message);
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(KEYS.doc);
    return raw ? C.normalizeDoc(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(KEYS.settings);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSettings(s) {
  localStorage.setItem(KEYS.settings, JSON.stringify(s));
}

/* ---------------- GitHub API ---------------- */

function ghUrl(settings, filePath) {
  return `${GITHUB_API}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${filePath}`;
}

function ghHeaders(settings, extra) {
  return Object.assign(
    {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + settings.token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    extra
  );
}

async function ghRequest(settings, filePath, options) {
  const res = await fetch(ghUrl(settings, filePath), options);
  if (res.status === 404) return null;
  if (res.status === 409) {
    const err = new Error('云端数据已被其他设备更新，正在重新合并…');
    err.conflict = true;
    throw err;
  }
  if (!res.ok) {
    let msg = 'GitHub 请求失败（' + res.status + '）';
    try {
      const j = await res.json();
      if (j && j.message) msg = j.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

async function ghGetData(settings) {
  const meta = await ghRequest(settings, 'data.json', {
    method: 'GET',
    headers: ghHeaders(settings),
  });
  if (!meta) return null;
  return { sha: meta.sha, doc: C.normalizeDoc(JSON.parse(C.fromBase64(meta.content))) };
}

async function ghPutData(settings, doc, sha) {
  const body = { message: 'bookkeeper sync', content: C.toBase64(JSON.stringify(doc)) };
  if (sha) body.sha = sha;
  const meta = await ghRequest(settings, 'data.json', {
    method: 'PUT',
    headers: ghHeaders(settings, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!meta || !meta.sha) throw new Error('GitHub 未返回新版本号');
  return meta.sha;
}

/** 测试连接：验证 owner/repo/token 是否有效 */
async function ghTest(owner, repo, token) {
  const settings = { owner: owner.trim(), repo: repo.trim(), token: token.trim() };
  const meta = await ghRequest(settings, 'data.json', { method: 'GET', headers: ghHeaders(settings) });
  return meta ? '连接成功，已找到云端数据（' + (meta.size || 0) + ' 字节）' : '连接成功（仓库有效，但还没有 data.json，保存后将自动创建）';
}

/* ---------------- 同步引擎 ---------------- */

function setStatus(status) {
  state.sync.status = status;
  const el = $('#syncStatus');
  const map = {
    none: '○ 未连接',
    connected: '✓ 已同步',
    syncing: '⟳ 同步中…',
    dirty: '◷ 待同步',
    offline: '⚠ 离线',
  };
  el.textContent = map[status] || map.none;
  el.className = 'sync-badge ' + status;
}

/** 标记本地有改动：缓存 + 防抖推送 */
function markDirty() {
  state.sync.dirty = true;
  saveCache();
  if (!state.sync.settings) return;
  clearTimeout(state.sync.pushTimer);
  state.sync.pushTimer = setTimeout(() => { syncNow(); }, 800);
  setStatus('dirty');
}

/** 应用文档到界面（拉取/合并后调用） */
function applyDoc(doc) {
  state.doc = C.applyTombstones(doc);
  saveCache();
  ensureActiveLedger();
  refreshUI();
}

/** 推送本地文档（含安全探测与 409 冲突重试） */
async function pushLocal() {
  const settings = state.sync.settings;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!state.sync.sha) {
        // 版本号未知：先探测云端文件是否存在（存在则取最新版本号并合并远端数据，避免覆盖）
        const existing = await ghGetData(settings);
        if (existing) {
          state.sync.sha = existing.sha;
          state.doc = C.mergeDocs(existing.doc, state.doc);
          saveCache();
        }
      }
      const doc = C.applyTombstones(state.doc);
      doc.updatedAt = C.nowISO();
      state.sync.sha = await ghPutData(settings, doc, state.sync.sha);
      state.sync.dirty = false;
      return;
    } catch (err) {
      if (err.conflict && attempt < 2) {
        const remote = await ghGetData(settings);
        if (remote) {
          state.sync.sha = remote.sha; // 关键：更新为云端最新版本号再重试
          state.doc = C.mergeDocs(remote.doc, state.doc);
          saveCache();
          continue;
        }
      }
      throw err;
    }
  }
}

/** 判断是否为“全新/未使用”的文档（仅默认账本、无任何数据） */
function isPristineDoc(doc) {
  return (
    doc &&
    doc.records.length === 0 &&
    doc.budgets.length === 0 &&
    doc.ledgers.length === 1 &&
    doc.deleted.ledgers.length === 0 &&
    doc.deleted.records.length === 0 &&
    doc.deleted.budgets.length === 0
  );
}

/** 比较文档内容（忽略 updatedAt，避免时间戳变化引发无意义的重复推送） */
function docBody(doc) {
  return JSON.stringify({
    version: doc.version,
    ledgers: doc.ledgers,
    records: doc.records,
    budgets: doc.budgets,
    categories: doc.categories,
    deleted: doc.deleted,
  });
}

/**
 * 完整同步：先拉取云端（拿到最新版本号 sha 与数据）→ 合并本地 → 有差异再推送。
 * 顺序很关键：必须先知道云端文件是否存在、版本号是多少，才能决定“新建”还是“更新”，
 * 避免对已存在的文件发不带 sha 的更新请求（会报 "sha" wasn't supplied）。
 *
 * 带串行锁：同一时间只允许一个同步在跑（防止“保存并同步”、60 秒轮询、
 * 修改防抖推送并发执行导致竞争）；期间有新请求则标记重跑，结束后再执行一次。
 */
async function syncNow() {
  const settings = state.sync.settings;
  if (!settings) return;
  if (state.sync._inProgress) {
    state.sync._rerun = true;
    return;
  }
  state.sync._inProgress = true;
  try {
    do {
      state.sync._rerun = false;
      await doSync(settings);
    } while (state.sync._rerun);
  } finally {
    state.sync._inProgress = false;
  }
}

async function doSync(settings) {
  setStatus('syncing');
  try {
    const remote = await ghGetData(settings);
    if (remote) {
      let merged;
      let changed;
      if (isPristineDoc(state.doc)) {
        // 全新设备的空文档：直接采用云端数据，不把自己默认账本并入共享数据
        merged = remote.doc;
        changed = false;
      } else {
        merged = C.mergeDocs(remote.doc, state.doc);
        changed = docBody(merged) !== docBody(remote.doc) || state.sync.dirty;
      }
      state.sync.sha = remote.sha;
      applyDoc(merged);
      state.sync.dirty = false;
      if (changed) {
        state.sync.dirty = true;
        await pushLocal();
      }
    } else {
      // 云端还没有数据文件 → 首次上传（sha 为空 = 新建文件，GitHub 允许）
      if (!state.doc) state.doc = C.emptyDoc();
      applyDoc(state.doc);
      await pushLocal();
    }
    setStatus('connected');
  } catch (err) {
    setStatus('offline');
    if (!/离线|网络/.test(err.message)) toast('同步失败：' + err.message);
    showSyncError(err.message);
  }
}

function startSyncLoop() {
  if (state._syncTimer) return;
  state._syncTimer = setInterval(() => {
    if (state.sync.settings) syncNow();
  }, SYNC_INTERVAL_MS);
}

/* ---------------- 数据变更（操作本地文档） ---------------- */

function afterChange() {
  saveCache();
  refreshUI();
  markDirty();
}

function currentLedger() {
  return state.doc.ledgers.find((l) => l.id === state.activeLedgerId) || state.doc.ledgers[0];
}

function addRecord({ date, type, category, amount, note }) {
  const now = C.nowISO();
  state.doc.records.push({
    id: C.newId(),
    ledgerId: state.activeLedgerId,
    date,
    type,
    category,
    amount: Math.round(Number(amount) * 100) / 100,
    note: String(note || '').slice(0, 200),
    createdAt: now,
    updatedAt: now,
  });
  afterChange();
}

function updateRecord(id, patch) {
  const rec = state.doc.records.find((r) => r.id === String(id));
  if (!rec) return;
  Object.assign(rec, patch, { amount: Math.round(Number(patch.amount) * 100) / 100, updatedAt: C.nowISO() });
  afterChange();
}

function deleteRecord(id) {
  const sid = String(id);
  state.doc.records = state.doc.records.filter((r) => r.id !== sid);
  state.doc.deleted.records.push({ id: sid, ts: C.nowISO() });
  afterChange();
}

function addLedger(name, note) {
  const now = C.nowISO();
  const ledger = { id: C.newId(), name, note: String(note || '').slice(0, 100), createdAt: now, updatedAt: now };
  state.doc.ledgers.push(ledger);
  afterChange();
  return ledger;
}

function updateLedger(id, name) {
  const l = state.doc.ledgers.find((x) => x.id === String(id));
  if (!l) return;
  l.name = name;
  l.updatedAt = C.nowISO();
  afterChange();
}

function deleteLedger(id) {
  const sid = String(id);
  if (state.doc.ledgers.length <= 1) throw new Error('至少保留一个账本');
  state.doc.ledgers = state.doc.ledgers.filter((l) => l.id !== sid);
  state.doc.deleted.ledgers.push({ id: sid, ts: C.nowISO() });
  // 级联删除该账本的记录与预算
  for (const r of state.doc.records.filter((r) => r.ledgerId === sid)) {
    state.doc.deleted.records.push({ id: r.id, ts: C.nowISO() });
  }
  for (const b of state.doc.budgets.filter((b) => b.ledgerId === sid)) {
    state.doc.deleted.budgets.push({ id: b.id, ts: C.nowISO() });
  }
  state.doc.records = state.doc.records.filter((r) => r.ledgerId !== sid);
  state.doc.budgets = state.doc.budgets.filter((b) => b.ledgerId !== sid);
  afterChange();
}

function addCategory(type, name) {
  if (state.doc.categories[type].some((c) => c.name === name)) throw new Error('该分类已存在');
  state.doc.categories[type].push({ name, builtin: false });
  afterChange();
}

function deleteCategory(type, name) {
  const cat = state.doc.categories[type].find((c) => c.name === name);
  if (!cat) throw new Error('分类不存在');
  if (cat.builtin) throw new Error('内置分类不可删除');
  state.doc.categories[type] = state.doc.categories[type].filter((c) => c.name !== name);
  afterChange();
}

function upsertBudget(category, amount) {
  const now = C.nowISO();
  const existing = state.doc.budgets.find((b) => b.ledgerId === state.activeLedgerId && b.category === category);
  if (existing) {
    existing.amount = Math.round(Number(amount) * 100) / 100;
    existing.updatedAt = now;
  } else {
    state.doc.budgets.push({ id: C.newId(), ledgerId: state.activeLedgerId, category, amount: Math.round(Number(amount) * 100) / 100, createdAt: now, updatedAt: now });
  }
  afterChange();
}

function deleteBudget(category) {
  const b = state.doc.budgets.find((x) => x.ledgerId === state.activeLedgerId && x.category === category);
  if (!b) return;
  state.doc.budgets = state.doc.budgets.filter((x) => x.id !== b.id);
  state.doc.deleted.budgets.push({ id: b.id, ts: C.nowISO() });
  afterChange();
}

/* ---------------- 统计计算 ---------------- */

function computeStats(ledgerId, month, windowSize) {
  const records = state.doc.records.filter((r) => r.ledgerId === ledgerId);
  let income = 0;
  let expense = 0;
  let count = 0;
  const byIncome = {};
  const byExpense = {};
  for (const r of records) {
    if (r.date.slice(0, 7) !== month) continue;
    count += 1;
    if (r.type === 'income') {
      income += r.amount;
      byIncome[r.category] = (byIncome[r.category] || 0) + r.amount;
    } else {
      expense += r.amount;
      byExpense[r.category] = (byExpense[r.category] || 0) + r.amount;
    }
  }
  const toArray = (obj) =>
    Object.entries(obj)
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

  // 趋势
  const months = [];
  const [yy, mm] = month.split('-').map(Number);
  for (let i = windowSize - 1; i >= 0; i--) {
    const d = new Date(yy, mm - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const trend = months.map((ym) => {
    let inc = 0;
    let exp = 0;
    for (const r of records) {
      if (r.date.slice(0, 7) !== ym) continue;
      if (r.type === 'income') inc += r.amount;
      else exp += r.amount;
    }
    return { month: ym, income: Math.round(inc * 100) / 100, expense: Math.round(exp * 100) / 100 };
  });

  // 预算进度
  const spentByCat = {};
  for (const r of records) {
    if (r.date.slice(0, 7) === month && r.type === 'expense') spentByCat[r.category] = (spentByCat[r.category] || 0) + r.amount;
  }
  const monthExpense = Math.round(expense * 100) / 100;
  const budgetInfo = (amount, spent) => ({
    amount: Math.round(amount * 100) / 100,
    spent: Math.round(spent * 100) / 100,
    remaining: Math.round((amount - spent) * 100) / 100,
    percent: amount > 0 ? Math.round((spent / amount) * 100) : 0,
  });
  const budgets = state.doc.budgets.filter((b) => b.ledgerId === ledgerId);
  const overall = budgets.find((b) => b.category === '');
  const byCatBudgets = budgets.filter((b) => b.category !== '').map((b) => ({ category: b.category, ...budgetInfo(b.amount, spentByCat[b.category] || 0) }));

  return {
    month,
    income: Math.round(income * 100) / 100,
    expense: monthExpense,
    balance: Math.round((income - expense) * 100) / 100,
    count,
    byIncome: toArray(byIncome),
    byExpense: toArray(byExpense),
    trend,
    budgets: { overall: overall ? budgetInfo(overall.amount, monthExpense) : null, byCategory: byCatBudgets },
  };
}

/* ---------------- 界面渲染 ---------------- */

function ensureActiveLedger() {
  if (!state.doc || state.doc.ledgers.length === 0) return;
  const saved = localStorage.getItem(KEYS.ledger);
  const active = state.doc.ledgers.find((l) => l.id === saved) || state.doc.ledgers[0];
  state.activeLedgerId = active.id;
  localStorage.setItem(KEYS.ledger, active.id);
}

function renderLedgerSelect() {
  const sel = $('#ledgerSelect');
  sel.innerHTML = state.doc.ledgers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  sel.value = state.activeLedgerId;
  renderLedgerList();
}

function renderLedgerList() {
  const ul = $('#ledgerList');
  const countOf = (id) => state.doc.records.filter((r) => r.ledgerId === id).length;
  ul.innerHTML = state.doc.ledgers
    .map(
      (l) => `<li>
        <span>
          <span class="lname">${esc(l.name)}</span>
          ${l.id === state.activeLedgerId ? '<span class="tag income">当前</span>' : ''}
          <span class="lmeta">${l.note ? esc(l.note) + ' · ' : ''}${countOf(l.id)} 笔</span>
        </span>
        <span class="actions">
          <button type="button" class="btn small" data-switch="${esc(l.id)}">切换</button>
          <button type="button" class="btn small" data-rename="${esc(l.id)}">重命名</button>
          <button type="button" class="btn small danger-btn" data-del-ledger="${esc(l.id)}">删除</button>
        </span>
      </li>`
    )
    .join('');
}

function renderRecords() {
  const month = $('#filterMonth').value;
  const type = $('#filterType').value;
  const cat = $('#filterCategory').value;
  const q = $('#filterQ').value.trim().toLowerCase();
  let list = state.doc.records.filter((r) => r.ledgerId === state.activeLedgerId);
  if (month) list = list.filter((r) => r.date.slice(0, 7) === month);
  if (type) list = list.filter((r) => r.type === type);
  if (cat) list = list.filter((r) => r.category === cat);
  if (q) list = list.filter((r) => r.category.toLowerCase().includes(q) || r.note.toLowerCase().includes(q));
  list = [...list].sort((a, b) => (a.date === b.date ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.date < b.date ? 1 : -1));

  $('#recordCount').textContent = list.length ? `共 ${list.length} 笔` : '';
  const body = $('#recordsBody');
  body.innerHTML = list
    .map((r) => {
      const cls = r.type === 'income' ? 'income' : 'expense';
      const sign = r.type === 'income' ? '+' : '-';
      return `<tr data-id="${esc(r.id)}">
        <td class="date">${esc(r.date)}</td>
        <td><span class="tag ${cls}">${r.type === 'income' ? '收入' : '支出'}</span></td>
        <td>${esc(r.category)}</td>
        <td class="note">${esc(r.note) || '<span class="muted">—</span>'}</td>
        <td class="num amount-${cls}">${sign}¥${fmtMoney(r.amount)}</td>
        <td class="ops">
          <button class="icon-btn" data-act="edit" title="编辑">✏️</button>
          <button class="icon-btn danger" data-act="del" title="删除">🗑</button>
        </td>
      </tr>`;
    })
    .join('');
  $('#emptyTip').hidden = list.length > 0;
}

function renderCategories() {
  const cats = state.doc.categories;
  const sel = $('#filterCategory');
  const prev = sel.value;
  const t = $('#filterType').value;
  const lists = t ? [cats[t]] : [cats.expense, cats.income];
  const names = [...new Set(lists.flat().map((c) => c.name))];
  sel.innerHTML = '<option value="">全部分类</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = prev && [...sel.options].some((o) => o.value === prev) ? prev : '';
  populateCategorySelect(currentSegType());
  renderCatList('expense');
  renderCatList('income');
}

function renderCatList(type) {
  const ul = type === 'expense' ? $('#catExpense') : $('#catIncome');
  ul.innerHTML = state.doc.categories[type]
    .map(
      (c) => `<li>
        <span>${esc(c.name)}</span>
        ${c.builtin ? '<span class="muted small">内置</span>' : `<button type="button" class="icon-btn danger" data-delcat="${type}:${encodeURIComponent(c.name)}" title="删除">删除</button>`}
      </li>`
    )
    .join('');
}

function renderStats() {
  const month = $('#filterMonth').value;
  const st = computeStats(state.activeLedgerId, month, 6);
  $('#sumExpense').textContent = fmtMoney(st.expense);
  $('#sumIncome').textContent = fmtMoney(st.income);
  $('#sumBalance').textContent = fmtMoney(st.balance);
  $('#sumCount').textContent = st.count;
  renderBudgetBox(st.budgets);
  drawTrend(st.trend);
  renderByCategory(st);
}

function renderBudgetBox(budgets) {
  const box = $('#budgetBox');
  const b = budgets || (state.stats && state.stats.budgets);
  if (!b || (!b.overall && (!b.byCategory || b.byCategory.length === 0))) {
    box.innerHTML = '<div class="muted center" style="padding:12px 0">尚未设置预算，点「设置」开始规划</div>';
    return;
  }
  let html = '';
  if (b.overall) {
    const o = b.overall;
    const over = o.spent > o.amount;
    const cls = over ? 'over' : o.percent >= 80 ? 'warn' : '';
    html += `<div class="budget-overall">
      <div class="budget-line">
        <span>总预算 ¥${fmtMoney(o.amount)}</span>
        <span>已用 ¥${fmtMoney(o.spent)} · 剩余 ¥${fmtMoney(Math.max(0, o.remaining))}${over ? ` <b class="over-text">超支 ¥${fmtMoney(-o.remaining)}</b>` : ''}</span>
      </div>
      <div class="cat-bar big ${cls}"><i style="width:${Math.min(100, o.percent)}%"></i></div>
    </div>`;
  }
  b.byCategory.forEach((c) => {
    const over = c.spent > c.amount;
    html += `<div class="cat-row">
      <span class="cat-name" title="${esc(c.category)}">${esc(c.category)}</span>
      <div class="cat-bar ${over ? 'over' : ''}"><i style="width:${Math.min(100, c.percent)}%"></i></div>
      <span class="cat-val">¥${fmtMoney(c.spent)}/¥${fmtMoney(c.amount)}</span>
    </div>`;
  });
  box.innerHTML = html;
}

function renderByCategory(st) {
  const box = $('#byCategory');
  const data = state.byType === 'income' ? st.byIncome : st.byExpense;
  if (!data || data.length === 0) {
    box.innerHTML = '<div class="muted center" style="padding:14px 0">本月暂无数据</div>';
    return;
  }
  const max = Math.max(...data.map((d) => d.amount));
  box.innerHTML = data
    .map(
      (d) => `<div class="cat-row">
        <span class="cat-name" title="${esc(d.category)}">${esc(d.category)}</span>
        <div class="cat-bar"><i class="${state.byType}" style="width:${((d.amount / max) * 100).toFixed(1)}%"></i></div>
        <span class="cat-val">¥${fmtMoney(d.amount)}</span>
      </div>`
    )
    .join('');
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return n * p;
}

function compactNum(v) {
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

function drawTrend(trend) {
  const canvas = $('#trendChart');
  const W = canvas.clientWidth || 320;
  const H = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 46;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  if (!trend || trend.length === 0) {
    ctx.fillStyle = '#8a94a6';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', W / 2, H / 2);
    return;
  }

  const maxV = Math.max(1, ...trend.map((t) => Math.max(t.income, t.expense)));
  const niceMax = niceCeil(maxV);

  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 2; i++) {
    const v = niceMax * (1 - i / 2);
    const y = padT + plotH * (i / 2);
    ctx.strokeStyle = '#eef1f5';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillStyle = '#8a94a6';
    ctx.textAlign = 'right';
    ctx.fillText(compactNum(v), padL - 6, y);
  }

  const n = trend.length;
  const slot = plotW / n;
  const barW = Math.min(14, slot * 0.22);
  const gap = barW + 5;
  trend.forEach((t, i) => {
    const cx = padL + slot * i + slot / 2;
    const y0 = padT + plotH;
    const hInc = (t.income / niceMax) * plotH;
    const hExp = (t.expense / niceMax) * plotH;
    if (hInc > 0) {
      ctx.fillStyle = '#30a46c';
      ctx.fillRect(cx - gap, y0 - hInc, barW, hInc);
    }
    if (hExp > 0) {
      ctx.fillStyle = '#e5484d';
      ctx.fillRect(cx, y0 - hExp, barW, hExp);
    }
    ctx.fillStyle = '#8a94a6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(t.month.slice(5) + '月', cx, padT + plotH + 6);
  });
}

function refreshUI() {
  if (!state.doc) return;
  renderLedgerSelect();
  renderCategories();
  renderRecords();
  renderStats();
}

/* ---------------- 弹窗逻辑 ---------------- */

function currentSegType() {
  const active = $('#segType button.active');
  return active ? active.dataset.t : 'expense';
}

function setSegType(type) {
  $('#segType').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.t === type));
  populateCategorySelect(type);
}

function populateCategorySelect(type) {
  const sel = $('#fCategory');
  const prev = sel.value;
  sel.innerHTML = state.doc.categories[type].map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function openRecordModal(rec) {
  state.editId = rec ? rec.id : null;
  $('#modalTitle').textContent = rec ? '编辑记录' : '记一笔';
  setSegType(rec ? rec.type : 'expense');
  $('#fId').value = rec ? rec.id : '';
  $('#fAmount').value = rec ? rec.amount : '';
  $('#fCategory').value = rec ? rec.category : '';
  $('#fDate').value = rec ? rec.date : todayStr();
  $('#fNote').value = rec ? rec.note : '';
  $('#recordModal').hidden = false;
  $('#fAmount').focus();
}

function saveRecord() {
  const id = $('#fId').value;
  const payload = {
    date: $('#fDate').value,
    type: currentSegType(),
    category: $('#fCategory').value,
    amount: Number($('#fAmount').value),
    note: $('#fNote').value.trim(),
  };
  if (!payload.date) return toast('请选择日期');
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) return toast('金额必须是大于 0 的数字');
  if (!payload.category) return toast('请选择分类');
  try {
    if (id) {
      updateRecord(id, payload);
      toast('已更新');
    } else {
      addRecord(payload);
      toast('已记录');
    }
    $('#recordModal').hidden = true;
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- 同步设置弹窗 ---------------- */

/** 常见 GitHub 错误 → 中文排查提示 */
function syncErrorHints(msg) {
  if (/Resource not accessible by personal access token/.test(msg)) {
    return '这是<b>权限问题</b>：Token 有效，但没被授权访问这个仓库。请逐项检查：<br>' +
      '① <b>仓库名</b>：填的是数据仓库（如 <code>bookkeeper-data</code>），拼写正确，不要带 <code>.git</code> 或完整网址；<br>' +
      '② <b>所有者</b>：与创建该仓库的账号一致（个人仓库填你的 GitHub 用户名）；<br>' +
      '③ 到 GitHub → Settings → Developer settings → Fine-grained tokens → 点开这个 Token <b>编辑</b>（无需重新生成）：<br>' +
      '　· Resource owner 选你的账号；<br>' +
      '　· Repository access 选 <b>Only select repositories</b> 并<b>勾选这个仓库</b>——如果 Token 是在建仓库<b>之前</b>生成的，这里不会包含新仓库，必须编辑重新勾选；<br>' +
      '　· Permissions → Contents 设为 <b>Read and write</b>（Metadata 会自动变为 Read-only）；<br>' +
      '　· 保存后回来再点「测试连接」。';
  }
  if (/Bad credentials|401|Unauthorized/i.test(msg)) {
    return 'Token <b>无效或已过期</b>：重新复制完整 Token（前后不要有空格），或到 Fine-grained tokens 页面重新生成一个再填进来。';
  }
  if (/Not Found|404/i.test(msg)) {
    return '仓库<b>不存在或无权查看</b>：确认所有者/仓库名拼写正确、仓库确实已创建。私有仓库也可以，只要 Token 授权后即可访问。';
  }
  return null;
}

function showSyncError(msg) {
  const el = $('#syncError');
  if (el.hidden) return; // 弹窗未打开时不显示
  const hint = syncErrorHints(msg);
  el.innerHTML = '⚠️ ' + esc(msg) + (hint ? '<br>' + hint : '');
  el.hidden = false;
}

function clearSyncError() {
  $('#syncError').hidden = true;
}

async function maybeLoadLegacy() {
  try {
    const res = await fetch('/api/legacy', { cache: 'no-store' });
    if (!res.ok) return false;
    const j = await res.json();
    if (!j || !j.exists || !j.doc) return false;
    state.doc = C.normalizeDoc(j.doc);
    saveCache();
    return true;
  } catch {
    return false;
  }
}

function openSyncModal() {
  const s = state.sync.settings;
  $('#syncOwner').value = s ? s.owner : '';
  $('#syncRepo').value = s ? s.repo : '';
  $('#syncToken').value = s ? s.token : '';
  const hint = $('#legacyHint');
  if (state.doc && state.doc.records.length > 0 && !s) {
    const nLedgers = state.doc.ledgers.length;
    const nRecords = state.doc.records.length;
    hint.hidden = false;
    hint.innerHTML = `📦 检测到本地已有数据：<b>${nLedgers}</b> 个账本、<b>${nRecords}</b> 条记录（${s ? '' : '来自旧版 SQLite，'}保存后将自动上传到 GitHub）。`;
  } else {
    hint.hidden = true;
  }
  clearSyncError();
  $('#syncModal').hidden = false;
}

function closeSyncModal() {
  $('#syncModal').hidden = true;
}

async function testConnection() {
  const owner = $('#syncOwner').value.trim();
  const repo = $('#syncRepo').value.trim();
  const token = $('#syncToken').value.trim();
  if (!owner || !repo || !token) return toast('请先填写所有者、仓库名和 Token');
  try {
    clearSyncError();
    toast(await ghTest(owner, repo, token));
  } catch (err) {
    toast('连接失败：' + err.message);
    showSyncError(err.message);
  }
}

async function saveSyncSettings() {
  const owner = $('#syncOwner').value.trim();
  const repo = $('#syncRepo').value.trim();
  const token = $('#syncToken').value.trim();
  if (!owner || !repo || !token) return toast('请先填写所有者、仓库名和 Token');
  state.sync.settings = { owner, repo, token };
  saveSettings(state.sync.settings);
  startSyncLoop();
  setStatus('syncing');
  await syncNow();
  if (state.sync.status === 'offline') {
    $('#syncModal').hidden = false; // 保持弹窗打开，显示排查提示
  } else {
    clearSyncError();
    closeSyncModal();
    toast('已保存并完成首次同步');
  }
}

/* ---------------- 导入 / 导出 ---------------- */

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function exportCsv() {
  const records = state.doc.records
    .filter((r) => r.ledgerId === state.activeLedgerId)
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['日期', '类型', '分类', '金额', '备注'].map(esc).join(',')];
  for (const r of records) {
    rows.push([r.date, r.type === 'income' ? '收入' : '支出', r.category, r.amount, r.note].map(esc).join(','));
  }
  const stamp = todayStr().replace(/-/g, '');
  download(`记账数据_${stamp}.csv`, '\uFEFF' + rows.join('\r\n'), 'text/csv');
  toast('已导出 CSV');
}

function exportJson() {
  const doc = C.applyTombstones(state.doc);
  const stamp = todayStr().replace(/-/g, '');
  download(`记账数据备份_${stamp}.json`, JSON.stringify(doc, null, 2), 'application/json');
  toast('已导出 JSON 备份');
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data && data.version === 2) {
      // 完整备份恢复
      if (!confirmDialog('检测到完整数据备份（含账本/预算）。恢复将覆盖当前全部数据，确定继续吗？')) return;
      applyDoc(C.normalizeDoc(data));
      toast('已恢复完整备份');
      return;
    }
    const arr = Array.isArray(data) ? data : Array.isArray(data && data.records) ? data.records : null;
    if (!arr) throw new Error('文件格式不正确，应为记录数组或 { records: [...] }');
    let imported = 0;
    let skipped = 0;
    for (const item of arr) {
      const date = item && item.date;
      const type = item && item.type;
      const category = item && item.category;
      const amount = Number(item && item.amount);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || (type !== 'income' && type !== 'expense') || !category || !Number.isFinite(amount) || amount <= 0) {
        skipped += 1;
        continue;
      }
      addRecord({ date, type, category, amount, note: (item && item.note) || '' });
      imported += 1;
    }
    toast(`导入完成：成功 ${imported} 条${skipped ? `，跳过无效 ${skipped} 条` : ''}`);
  } catch (err) {
    toast('导入失败：' + err.message);
  }
}

/* ---------------- 事件绑定 ---------------- */

function wireEvents() {
  $('#btnAdd').addEventListener('click', () => openRecordModal(null));
  $('#btnCancel').addEventListener('click', () => { $('#recordModal').hidden = true; });
  $('#recordModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  $('#recordForm').addEventListener('submit', (e) => { e.preventDefault(); saveRecord(); });

  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (seg.id === 'segType') populateCategorySelect(b.dataset.t);
      if (seg.id === 'segByType') {
        state.byType = b.dataset.t;
        const st = computeStats(state.activeLedgerId, $('#filterMonth').value, 6);
        renderByCategory(st);
      }
    });
  });

  $('#recordsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'edit') {
      const rec = state.doc.records.find((r) => r.id === id);
      if (rec) openRecordModal(rec);
    } else if (btn.dataset.act === 'del') {
      if (confirmDialog('确定删除这条记录吗？')) deleteRecord(id);
    }
  });

  $('#filterMonth').addEventListener('change', () => { renderRecords(); renderStats(); });
  $('#filterType').addEventListener('change', () => { renderCategories(); renderRecords(); });
  $('#filterCategory').addEventListener('change', renderRecords);
  let qTimer = null;
  $('#filterQ').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(renderRecords, 300);
  });

  /* 账本 */
  $('#ledgerSelect').addEventListener('change', (e) => {
    state.activeLedgerId = e.target.value;
    localStorage.setItem(KEYS.ledger, state.activeLedgerId);
    renderLedgerList();
    refreshUI();
  });
  $('#btnLedgers').addEventListener('click', () => { $('#ledgerModal').hidden = false; renderLedgerList(); });
  $('#btnCloseLedgers').addEventListener('click', () => { $('#ledgerModal').hidden = true; });
  $('#ledgerModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  $('#btnAddLedger').addEventListener('click', () => {
    const input = $('#newLedgerName');
    const name = input.value.trim();
    if (!name) return toast('请输入账本名称');
    const ledger = addLedger(name, '');
    input.value = '';
    state.activeLedgerId = ledger.id;
    localStorage.setItem(KEYS.ledger, ledger.id);
    toast('已新建账本');
  });
  $('#newLedgerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('#ledgerList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-switch],[data-rename],[data-del-ledger]');
    if (!btn) return;
    if (btn.dataset.switch) {
      state.activeLedgerId = btn.dataset.switch;
      localStorage.setItem(KEYS.ledger, state.activeLedgerId);
      renderLedgerList();
      refreshUI();
    } else if (btn.dataset.rename) {
      const l = state.doc.ledgers.find((x) => x.id === btn.dataset.rename);
      if (!l) return;
      const name = prompt('输入新的账本名称：', l.name);
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) return toast('名称不能为空');
      updateLedger(l.id, trimmed);
      toast('已重命名');
    } else if (btn.dataset.delLedger) {
      try {
        if (confirmDialog('确定删除该账本吗？账本内所有记录和预算将一并删除，且无法恢复！')) {
          deleteLedger(btn.dataset.delLedger);
          toast('已删除账本');
        }
      } catch (err) {
        toast(err.message);
      }
    }
  });

  /* 预算 */
  const openBudgetModal = () => {
    $('#budgetModal').hidden = false;
    renderBudgetSettings();
  };
  $('#btnBudgets').addEventListener('click', openBudgetModal);
  $('#btnOpenBudgets').addEventListener('click', openBudgetModal);
  $('#btnCloseBudgets').addEventListener('click', () => { $('#budgetModal').hidden = true; });
  $('#budgetModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  $('#budgetOverall').addEventListener('change', () => {
    const amount = Number($('#budgetOverall').value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('请输入大于 0 的总预算金额');
    upsertBudget('', amount);
    toast('总预算已保存');
    renderBudgetSettings();
  });
  $('#budgetList').addEventListener('change', (e) => {
    const input = e.target.closest('.budget-amount');
    if (!input) return;
    const amount = Number(input.value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('请输入大于 0 的预算金额');
    upsertBudget(input.dataset.cat, amount);
    toast('分类预算已保存');
  });
  $('#budgetList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-budgetdel]');
    if (btn) {
      deleteBudget(decodeURIComponent(btn.dataset.budgetdel));
      renderBudgetSettings();
      toast('已删除分类预算');
    }
  });
  $('#btnAddBudgetCat').addEventListener('click', () => {
    const category = $('#budgetCatSelect').value;
    const amount = Number($('#budgetCatAmount').value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('请输入大于 0 的预算金额');
    upsertBudget(category, amount);
    $('#budgetCatAmount').value = '';
    toast('已添加分类预算');
    renderBudgetSettings();
  });

  /* 分类 */
  $('#btnCats').addEventListener('click', () => { $('#catsModal').hidden = false; });
  $('#btnCloseCats').addEventListener('click', () => { $('#catsModal').hidden = true; });
  $('#catsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  $('#catsModal').addEventListener('click', (e) => {
    const del = e.target.closest('[data-delcat]');
    if (del) {
      const [type, name] = del.dataset.delcat.split(':');
      try {
        deleteCategory(type, decodeURIComponent(name));
        toast('已删除分类');
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      const input = add.dataset.add === 'expense' ? $('#newExpenseCat') : $('#newIncomeCat');
      const name = input.value.trim();
      if (!name) return toast('请输入分类名');
      try {
        addCategory(add.dataset.add, name);
        input.value = '';
        toast('已添加分类');
      } catch (err) {
        toast(err.message);
      }
    }
  });

  /* 同步 */
  $('#syncStatus').addEventListener('click', syncNow);
  $('#btnSyncSettings').addEventListener('click', openSyncModal);
  $('#btnSyncTest').addEventListener('click', testConnection);
  $('#btnSyncSave').addEventListener('click', saveSyncSettings);
  $('#btnSyncCancel').addEventListener('click', closeSyncModal);
  $('#syncModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSyncModal(); });

  /* 导入导出 */
  $('#btnExportCsv').addEventListener('click', exportCsv);
  $('#btnExportJson').addEventListener('click', exportJson);
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  });

  window.addEventListener('resize', () => {
    const st = computeStats(state.activeLedgerId, $('#filterMonth').value, 6);
    drawTrend(st.trend);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#recordModal').hidden = true;
      $('#catsModal').hidden = true;
      $('#ledgerModal').hidden = true;
      $('#budgetModal').hidden = true;
      closeSyncModal();
    }
  });

  // 页面离开前尽力推送未同步的改动（必须已知云端版本号，否则跳过，数据在缓存里等下次同步）
  window.addEventListener('beforeunload', () => {
    if (state.sync.settings && state.sync.dirty && state.sync.sha) {
      try {
        const doc = C.applyTombstones(state.doc);
        doc.updatedAt = C.nowISO();
        const body = { message: 'bookkeeper sync', content: C.toBase64(JSON.stringify(doc)) };
        if (state.sync.sha) body.sha = state.sync.sha;
        fetch(ghUrl(state.sync.settings, 'data.json'), {
          method: 'PUT',
          headers: ghHeaders(state.sync.settings, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(() => {});
      } catch { /* ignore */ }
    }
  });
}

function renderBudgetSettings() {
  const budgets = state.doc.budgets.filter((b) => b.ledgerId === state.activeLedgerId);
  const overall = budgets.find((b) => b.category === '');
  $('#budgetOverall').value = overall ? overall.amount : '';
  const sel = $('#budgetCatSelect');
  sel.innerHTML = state.doc.categories.expense.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  const ul = $('#budgetList');
  ul.innerHTML = budgets
    .filter((b) => b.category !== '')
    .map(
      (b) => `<li>
        <span>${esc(b.category)}</span>
        <input type="number" class="budget-amount" step="0.01" min="0" value="${b.amount}" data-cat="${esc(b.category)}">
        <button type="button" class="icon-btn danger" data-budgetdel="${encodeURIComponent(b.category)}" title="删除预算">删除</button>
      </li>`
    )
    .join('');
}

/* ---------------- 启动 ---------------- */

async function init() {
  // 1. 数据：本地缓存 → 旧版 SQLite 迁移 → 空文档
  state.doc = loadCache();
  if (!state.doc) await maybeLoadLegacy();
  if (!state.doc) state.doc = C.emptyDoc();
  saveCache();

  // 2. 同步配置
  state.sync.settings = loadSettings();

  // 3. 界面
  $('#filterMonth').value = currentMonth();
  wireEvents();
  ensureActiveLedger();
  refreshUI();

  // 4. 同步：已配置则立即同步并启动定时轮询
  if (state.sync.settings) {
    setStatus('syncing');
    await syncNow();
    startSyncLoop();
  } else {
    setStatus('none');
  }
}

init();
