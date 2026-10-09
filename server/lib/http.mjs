/**
 * HTTP 基础设施：请求体解析、响应输出、CORS、静态文件托管。
 * 仅使用 Node 内置模块（NFR-001）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [extra] 附加到 error 对象上的诊断信息（不得含凭据）
   */
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** 允许的浏览器来源：仅本机页面，避免成为恶意站点的免费代理（NFR-006）。 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && LOCAL_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, status, code, message, extra) {
  sendJson(res, status, { error: { code, message, ...(extra ?? {}) } });
}

/**
 * 读取并解析 JSON 请求体，带大小上限。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<any>}
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'payload_too_large', `请求体超过 ${Math.round(limit / 1024)} KB 上限`));
      req.resume();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'payload_too_large', `请求体超过 ${Math.round(limit / 1024)} KB 上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(new HttpError(400, 'request_error', err.message)));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid_json', '请求体不是合法的 JSON'));
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 把 URL 路径解析为 rootDir 内的真实文件路径；越界返回 null（AC-6.2）。
 * @param {string} rootDir
 * @param {string} urlPath
 * @returns {string|null}
 */
export function resolveWithin(rootDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const normalizedSlashes = decoded.replace(/\\/g, '/');
  // 出现 .. 直接拒绝（fail closed），而不是依赖 normalize 把它夹到根目录
  if (normalizedSlashes.split('/').includes('..')) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, '.' + path.posix.normalize('/' + normalizedSlashes));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * 静态托管（SPA 回退到 index.html）。
 * @returns {Promise<boolean>} 是否已处理
 */
export async function serveStatic(req, res, rootDir, urlPath) {
  const root = path.resolve(rootDir);
  const target = resolveWithin(root, urlPath);
  if (!target) {
    sendError(res, 403, 'forbidden_path', '非法的资源路径');
    return true;
  }
  if (!fs.existsSync(path.join(root, 'index.html'))) return false;

  let filePath = target;
  let stat = await fsp.stat(filePath).catch(() => null);
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = await fsp.stat(filePath).catch(() => null);
  }
  if (!stat?.isFile()) {
    // 只有"看起来像页面"的路径才回退到 SPA 入口；缺失的静态资源应当老实报 404
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '' && ext !== '.html') {
      sendError(res, 404, 'not_found', `资源不存在：${urlPath}`);
      return true;
    }
    filePath = path.join(root, 'index.html');
    stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      res.end();
      resolve(undefined);
    });
    stream.on('end', () => resolve(undefined));
    stream.pipe(res);
  });
  return true;
}
