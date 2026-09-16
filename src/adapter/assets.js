/**
 * ASSETS → 本地静态资源适配器
 *
 * 复刻 Cloudflare Workers Static Assets binding 的 fetch(request) 行为，
 * 这样 worker/index.js 里那段 `c.env.ASSETS.fetch(c.req.raw)` 完全不用改：
 *
 *   - 命中文件  -> 返回 Response（带 Content-Type / ETag / 304）
 *   - 未命中    -> 抛错，交给 index.js 的 catch 做 SPA fallback 到 index.html
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export class Assets {
  /** @param {string} rootDir 静态资源根目录（public/） */
  constructor(rootDir) {
    this._root = path.resolve(rootDir);
  }

  /** 把 URL pathname 安全地映射到磁盘路径 */
  _resolvePath(pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      rel = pathname;
    }
    rel = rel.split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) rel = 'index.html';

    const abs = path.resolve(this._root, rel);
    const rootWithSep = this._root.endsWith(path.sep) ? this._root : this._root + path.sep;
    if (abs !== this._root && !abs.startsWith(rootWithSep)) return null;
    return abs;
  }

  /**
   * 与 Workers ASSETS binding 对齐：找不到就抛错（触发上游的 SPA fallback）
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);
    let filePath = this._resolvePath(url.pathname);

    if (filePath) {
      let stat = await fsp.stat(filePath).catch(() => null);
      // 目录请求（/js、/css）不对外暴露目录列表，直接视为未命中
      if (stat?.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = await fsp.stat(filePath).catch(() => null);
      }

      if (stat?.isFile()) {
        const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
        const lastModified = stat.mtime.toUTCString();

        // 条件请求：命中则回 304，省流量
        const inm = request.headers.get('if-none-match');
        const ims = request.headers.get('if-modified-since');
        if (inm === etag || (ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
          return new Response(null, {
            status: 304,
            headers: { ETag: etag, 'Last-Modified': lastModified }
          });
        }

        const ext = path.extname(filePath).toLowerCase();
        // HTML 不缓存（改完立即生效）；其余静态资源短缓存 + ETag 复验
        const cacheControl = ext === '.html' || ext === '.htm'
          ? 'no-cache'
          : 'public, max-age=3600, must-revalidate';

        const headers = {
          'Content-Type': contentTypeFor(filePath),
          'Content-Length': String(stat.size),
          'Cache-Control': cacheControl,
          ETag: etag,
          'Last-Modified': lastModified
        };

        if (request.method === 'HEAD') {
          return new Response(null, { status: 200, headers });
        }

        return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
          status: 200,
          headers
        });
      }
    }

    // 未命中 -> 抛错，由 worker/index.js 的 catch 分支做 SPA fallback
    throw new Error(`[Assets] 未找到: ${url.pathname}`);
  }
}

export function createAssets(rootDir) {
  return new Assets(rootDir);
}
