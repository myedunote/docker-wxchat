/**
 * R2 → 本地文件系统适配器
 *
 * 复刻 Cloudflare R2 的最小接口，使 worker/services/fileService.js 无需改动：
 *   r2.put(key, body, { httpMetadata })
 *   r2.get(key)    -> { body: ReadableStream, size, httpMetadata } | null
 *   r2.delete(key)
 *   r2.head(key)   -> { size, httpMetadata } | null
 *
 * 所有对象落在 UPLOAD_PATH 目录下（Docker 里挂到 volume）。
 * 关键安全点：对 key 做规范化校验，杜绝 ../../ 之类的路径穿越。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * 删除单个文件；文件不存在视为成功（对齐 R2 delete 的幂等语义）。
 * 这里刻意用 unlink 而不是 rm(force)：rm 带 force 会在某些受限环境
 * （如批量删除保护、只读挂载）下产生额外的失败路径，而单文件删除本就是 unlink 的语义。
 */
async function removeFile(absPath) {
  try {
    await fsp.unlink(absPath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export class R2Bucket {
  /** @param {string} rootDir 本地存储根目录 */
  constructor(rootDir) {
    this._root = path.resolve(rootDir);
    fs.mkdirSync(this._root, { recursive: true });
  }

  /**
   * 把 R2 key 映射为绝对路径，并确保仍在根目录内。
   * key 形如 "files/1730000000000-ab12cd34ef56.png"
   */
  _resolve(key) {
    const raw = String(key ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!raw) throw new Error('[R2Adapter] key 不能为空');

    const abs = path.resolve(this._root, raw);
    const rootWithSep = this._root.endsWith(path.sep) ? this._root : this._root + path.sep;
    // 必须严格位于根目录之下
    if (abs !== this._root && !abs.startsWith(rootWithSep)) {
      throw new Error(`[R2Adapter] 非法 key（路径穿越）: ${key}`);
    }
    return abs;
  }

  /** 把上游可能传来的各种 body 类型统一成 Node 可读流 */
  async _toNodeStream(body) {
    if (body == null) return Readable.from([]);
    // Web ReadableStream（file.stream() 的产物）
    if (typeof body.getReader === 'function') return Readable.fromWeb(body);
    if (typeof body[Symbol.asyncIterator] === 'function') return body;
    if (Buffer.isBuffer(body)) return Readable.from([body]);
    if (body instanceof ArrayBuffer) return Readable.from([Buffer.from(body)]);
    if (ArrayBuffer.isView(body)) return Readable.from([Buffer.from(body.buffer, body.byteOffset, body.byteLength)]);
    if (typeof body === 'string') return Readable.from([Buffer.from(body)]);
    if (typeof body.arrayBuffer === 'function') {
      // Blob / File
      return Readable.from([Buffer.from(await body.arrayBuffer())]);
    }
    throw new Error('[R2Adapter] 不支持的 body 类型');
  }

  async put(key, body, options = {}) {
    const abs = this._resolve(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });

    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    const stream = await this._toNodeStream(body);

    try {
      // 先写临时文件再原子 rename：避免上传中断留下半个文件
      await fsp.writeFile(tmp, stream);
      await fsp.rename(tmp, abs);
    } catch (err) {
      await removeFile(tmp).catch(() => {});
      throw err;
    }

    const stat = await fsp.stat(abs);
    return {
      key: String(key),
      size: stat.size,
      etag: `${stat.size}-${Math.round(stat.mtimeMs)}`,
      httpMetadata: options.httpMetadata || {}
    };
  }

  async get(key) {
    const abs = this._resolve(key);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    return {
      key: String(key),
      size: stat.size,
      etag: `${stat.size}-${Math.round(stat.mtimeMs)}`,
      uploaded: stat.mtime,
      // 上游 route 直接把 object.body 交给 new Response()，必须是 Web ReadableStream
      body: Readable.toWeb(fs.createReadStream(abs)),
      arrayBuffer: async () => {
        const buf = await fsp.readFile(abs);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      text: () => fsp.readFile(abs, 'utf8'),
      httpMetadata: {}
    };
  }

  async head(key) {
    const abs = this._resolve(key);
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return null;
      return { key: String(key), size: stat.size, uploaded: stat.mtime, httpMetadata: {} };
    } catch {
      return null;
    }
  }

  async delete(key) {
    const abs = this._resolve(key);
    await removeFile(abs);
  }

  /** 列出对象，主要给运维排查用 */
  async list(options = {}) {
    const prefix = String(options.prefix || '');
    const base = prefix ? this._resolve(prefix.replace(/\/$/, '') || '.') : this._root;
    const objects = [];

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // 跳过启动期的可写性探测文件（由 src/server.js 的 ensureWritableDir 写入），
        // 避免污染运维列表
        if (entry.name === '.write-probe') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(full);
          objects.push({
            key: path.relative(this._root, full).split(path.sep).join('/'),
            size: stat.size,
            uploaded: stat.mtime
          });
        }
      }
    };

    await walk(base);
    return { objects, truncated: false };
  }
}

export function createR2(rootDir) {
  return new R2Bucket(rootDir);
}
