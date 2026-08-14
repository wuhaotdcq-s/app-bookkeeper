'use strict';

/**
 * 我的记账本 —— 本地静态服务（v3）
 *
 * 应用已改为纯网页版：数据保存在 GitHub 私有仓库（data.json），
 * 本服务只负责把 public/ 目录托管到本机，方便电脑使用；
 * 手机端可用局域网访问本服务，或把 public/ 部署到 GitHub Pages 随时随地用。
 *
 * 附带接口：
 *   GET /api/health  健康检查
 *   GET /api/legacy  读取旧版 SQLite（data/bookkeeper.db），导出为 v2 数据文档，
 *                    供网页首次配置 GitHub 时自动迁移旧数据
 *
 * 零依赖：仅使用 Node.js 内置模块（http / fs / path / node:sqlite）。
 * 启动：node server.js    默认 http://127.0.0.1:3000
 * 环境变量：PORT（默认 3000）、HOST（默认 127.0.0.1；手机同 Wi-Fi 访问请用 HOST=0.0.0.0）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'bookkeeper.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- 工具 ---------------- */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ---------------- 旧版 SQLite 数据导出 ---------------- */

/** 读取旧版 bookkeeper.db，导出为 v2 数据文档（与 sync-core 结构一致，id 转为字符串） */
function legacyExport() {
  if (!fs.existsSync(DB_FILE)) return { exists: false };
  const sdb = new DatabaseSync(DB_FILE);
  try {
    const ledgers = sdb.prepare('SELECT * FROM ledgers ORDER BY id').all();
    const records = sdb.prepare('SELECT * FROM records ORDER BY id').all();
    const budgets = sdb.prepare('SELECT * FROM budgets ORDER BY id').all();
    const cats = sdb.prepare('SELECT * FROM categories ORDER BY id').all();
    const doc = {
      version: 2,
      updatedAt: new Date().toISOString(),
      ledgers: ledgers.map((r) => ({ id: String(r.id), name: r.name, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at })),
      records: records.map((r) => ({
        id: String(r.id),
        ledgerId: String(r.ledger_id),
        date: r.date,
        type: r.type,
        category: r.category,
        amount: r.amount,
        note: r.note,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      budgets: budgets.map((r) => ({
        id: String(r.id),
        ledgerId: String(r.ledger_id),
        category: r.category,
        amount: r.amount,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      categories: {
        income: cats.filter((c) => c.type === 'income').map((c) => ({ name: c.name, builtin: !!c.builtin })),
        expense: cats.filter((c) => c.type === 'expense').map((c) => ({ name: c.name, builtin: !!c.builtin })),
      },
      deleted: { ledgers: [], records: [], budgets: [] },
    };
    return { exists: true, doc };
  } finally {
    sdb.close();
  }
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, url) {
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + p);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    // no-cache：本地开发方便，浏览器刷新即可拿到最新文件
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api') {
    try {
      if (parts[1] === 'health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, time: new Date().toISOString() });
        return;
      }
      if (parts[1] === 'legacy' && req.method === 'GET') {
        sendJson(res, 200, legacyExport());
        return;
      }
      sendJson(res, 404, { error: '接口不存在' });
    } catch (err) {
      console.error('[错误]', err.message);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器错误：' + err.message });
      else res.end();
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url);
  } else {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  }
});

server.listen(PORT, HOST, () => {
  console.log('==========================================');
  console.log('  我的记账本（GitHub 同步版）');
  console.log(`  本机访问:  http://${HOST}:${PORT}`);
  console.log(`  手机同 Wi-Fi: http://电脑局域网IP:${PORT}（需 HOST=0.0.0.0 启动）`);
  console.log('  数据保存在你的 GitHub 私有仓库，本服务仅托管网页');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==========================================');
});
