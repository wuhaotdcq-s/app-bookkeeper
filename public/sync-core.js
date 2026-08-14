'use strict';

/**
 * sync-core.js —— 数据模型与同步核心（纯函数，浏览器 / Node 通用）
 *
 * 数据文档结构（GitHub 上保存为 data.json，浏览器 localStorage 缓存同一结构）：
 * {
 *   version: 2,
 *   updatedAt: ISO 时间戳,
 *   ledgers:   [{ id, name, note, createdAt, updatedAt }],
 *   records:   [{ id, ledgerId, date, type, category, amount, note, createdAt, updatedAt }],
 *   budgets:   [{ id, ledgerId, category, amount, createdAt, updatedAt }],
 *   categories:{ income: [{name, builtin}], expense: [{name, builtin}] },
 *   deleted:   { ledgers: [{id, ts}], records: [{id, ts}], budgets: [{id, ts}] }
 * }
 *
 * 同步策略：
 * - 每台设备持有完整文档副本，GitHub 上的 data.json 是同步媒介
 * - 合并：按 id 联合，同一 id 取 updatedAt 较新者；删除用墓碑（tombstone）避免“复活”
 * - 删除判定：墓碑时间 >= 条目更新时间 → 该条目视为已删除；条目更新晚于墓碑 → 视为重新创建
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOMBSTONE_DAYS = 180; // 墓碑保留天数，防止文档无限膨胀

  const DEFAULT_CATEGORIES = {
    income: ['工资', '奖金', '兼职', '理财', '红包', '其他'],
    expense: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '其他'],
  };

  const nowISO = () => new Date().toISOString();

  /** 生成跨设备唯一的 id */
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** 时间戳解析（兼容 ISO 字符串 / 数字 / 空） */
  const ts = (s) => {
    if (!s) return 0;
    const n = typeof s === 'number' ? s : Date.parse(s);
    return Number.isFinite(n) ? n : 0;
  };

  function emptyDoc() {
    const now = nowISO();
    return {
      version: 2,
      updatedAt: now,
      ledgers: [{ id: newId(), name: '日常账本', note: '默认账本', createdAt: now, updatedAt: now }],
      records: [],
      budgets: [],
      categories: {
        income: DEFAULT_CATEGORIES.income.map((name) => ({ name, builtin: true })),
        expense: DEFAULT_CATEGORIES.expense.map((name) => ({ name, builtin: true })),
      },
      deleted: { ledgers: [], records: [], budgets: [] },
    };
  }

  /** 规范化任意来源的文档（旧数据 / GitHub / 缓存），保证结构完整、id 为字符串 */
  function normalizeDoc(raw) {
    if (!raw || typeof raw !== 'object') return emptyDoc();
    const base = emptyDoc();
    const out = {
      version: 2,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowISO(),
      ledgers: [],
      records: [],
      budgets: [],
      categories: { income: [], expense: [] },
      deleted: { ledgers: [], records: [], budgets: [] },
    };
    const now = nowISO();
    const item = (x, defs) => Object.assign({}, defs, x, { id: String(x && x.id != null ? x.id : newId()) });

    out.ledgers = (Array.isArray(raw.ledgers) ? raw.ledgers : [])
      .map((x) => item(x, { name: '', note: '', createdAt: now, updatedAt: now }))
      .filter((x) => x.name);
    const validLedger = new Set(out.ledgers.map((l) => l.id));

    out.records = (Array.isArray(raw.records) ? raw.records : [])
      .map((x) =>
        item(x, {
          ledgerId: '',
          date: '',
          type: 'expense',
          category: '',
          amount: 0,
          note: '',
          createdAt: now,
          updatedAt: now,
        })
      )
      .filter((x) => validLedger.has(String(x.ledgerId)) && x.date && x.category && Number(x.amount) > 0)
      .map((x) => Object.assign(x, { ledgerId: String(x.ledgerId) }));

    out.budgets = (Array.isArray(raw.budgets) ? raw.budgets : [])
      .map((x) => item(x, { ledgerId: '', category: '', amount: 0, createdAt: now, updatedAt: now }))
      .filter((x) => validLedger.has(String(x.ledgerId)))
      .map((x) => Object.assign(x, { ledgerId: String(x.ledgerId) }));

    for (const type of ['income', 'expense']) {
      const seen = new Map();
      for (const c of (raw.categories && raw.categories[type]) || []) {
        const name = String(c && c.name != null ? c.name : '').trim().slice(0, 50);
        if (!name) continue;
        const cur = seen.get(name);
        if (!cur) seen.set(name, { name, builtin: !!(c && c.builtin) });
        else if (c && c.builtin) cur.builtin = true;
      }
      out.categories[type] = Array.from(seen.values());
    }

    for (const k of ['ledgers', 'records', 'budgets']) {
      out.deleted[k] = (raw.deleted && raw.deleted[k]) || [];
      out.deleted[k] = out.deleted[k]
        .filter((x) => x && x.id != null)
        .map((x) => ({ id: String(x.id), ts: typeof x.ts === 'string' ? x.ts : nowISO() }));
    }
    return out;
  }

  /** 合并两个文档：按 id 联合、较新 updatedAt 胜出、墓碑生效 */
  function mergeDocs(base, other) {
    const a = normalizeDoc(base);
    const b = normalizeDoc(other);

    // 分类：按 (type, name) 联合，builtin 优先
    for (const type of ['income', 'expense']) {
      const map = new Map(a.categories[type].map((c) => [c.name, c]));
      for (const c of b.categories[type]) {
        const cur = map.get(c.name);
        if (!cur) map.set(c.name, c);
        else if (!cur.builtin && c.builtin) map.set(c.name, { name: c.name, builtin: true });
      }
      a.categories[type] = Array.from(map.values());
    }

    a.ledgers = mergeList(a.ledgers, b.ledgers, a.deleted.ledgers, b.deleted.ledgers);
    a.records = mergeList(a.records, b.records, a.deleted.records, b.deleted.records);
    a.budgets = mergeList(a.budgets, b.budgets, a.deleted.budgets, b.deleted.budgets);

    // 墓碑取较新
    for (const k of ['ledgers', 'records', 'budgets']) {
      const map = new Map((a.deleted[k] || []).map((d) => [d.id, d]));
      for (const d of b.deleted[k] || []) {
        const cur = map.get(d.id);
        if (!cur || ts(d.ts) > ts(cur.ts)) map.set(d.id, d);
      }
      a.deleted[k] = Array.from(map.values());
    }

    a.updatedAt = nowISO();
    return a;
  }

  /** 合并单类实体列表（含墓碑判定） */
  function mergeList(listA, listB, deletedA, deletedB) {
    const byId = new Map();
    for (const item of listA) byId.set(item.id, Object.assign({}, item));
    for (const item of listB) {
      const cur = byId.get(item.id);
      if (!cur || ts(item.updatedAt) > ts(cur.updatedAt)) byId.set(item.id, Object.assign({}, item));
    }
    const tombTsOf = (id) => {
      let t = 0;
      for (const list of [deletedA, deletedB]) {
        const d = (list || []).find((x) => x.id === id);
        if (d) t = Math.max(t, ts(d.ts));
      }
      return t || null;
    };
    const out = [];
    for (const item of byId.values()) {
      const tomb = tombTsOf(item.id);
      if (tomb !== null && ts(item.updatedAt) <= tomb) continue; // 已删除
      out.push(item);
    }
    return out.sort((x, y) => ts(x.updatedAt) - ts(y.updatedAt));
  }

  /** 清理文档：删除被墓碑标记的条目、清理孤儿数据、裁剪过期墓碑 */
  function applyTombstones(doc) {
    const d = normalizeDoc(doc);
    const cut = Date.now() - TOMBSTONE_DAYS * 86400000;
    const validLedger = new Set(d.ledgers.map((l) => l.id));
    d.records = d.records.filter((r) => validLedger.has(String(r.ledgerId)));
    d.budgets = d.budgets.filter((b) => validLedger.has(String(b.ledgerId)));
    for (const k of ['ledgers', 'records', 'budgets']) {
      const delById = new Map();
      for (const x of d.deleted[k]) {
        if (ts(x.ts) <= cut) continue;
        delById.set(x.id, ts(x.ts));
      }
      d.deleted[k] = Array.from(delById, ([id, t]) => ({ id, ts: new Date(t).toISOString() }));
      d[k] = d[k].filter((item) => !(delById.has(item.id) && ts(item.updatedAt) <= delById.get(item.id)));
    }
    return d;
  }

  /* ---------------- base64（UTF-8 安全） ---------------- */

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  return {
    nowISO,
    newId,
    ts,
    emptyDoc,
    normalizeDoc,
    mergeDocs,
    mergeList,
    applyTombstones,
    toBase64,
    fromBase64,
    TOMBSTONE_DAYS,
  };
});
