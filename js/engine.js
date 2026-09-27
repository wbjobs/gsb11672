/* 存储引擎：IndexedDB 主存储 + 内存降级存储 + 混合调度（清理/降级/恢复/校验） */
(function (global) {
  'use strict';

  const { fnv1a, isQuotaError } = global.Util;

  const DB_NAME = 'bulk-writer-demo';
  const DB_VERSION = 1;
  const STORE_RECORDS = 'records';
  const STORE_META = 'meta';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'seq' });
          store.createIndex('by_seq', 'seq', { unique: true });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他连接阻塞'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
      tx.onerror = () => reject(tx.error || new Error('事务失败'));
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------------- IndexedDB 后端 ---------------- */

  class IdbBackend {
    constructor() {
      this.db = null;
      this.onLost = null; // 数据库被外部删除/升级时回调
    }

    async init() {
      this.db = await openDb();
      this.db.onversionchange = () => {
        // 其他上下文删除/升级了数据库：关闭连接并通知上层
        try { this.db.close(); } catch (_) { /* ignore */ }
        this.db = null;
        if (this.onLost) this.onLost();
      };
    }

    get available() {
      return this.db !== null;
    }

    ensure() {
      if (!this.db) throw new Error('IndexedDB 连接不可用');
      return this.db;
    }

    /** 批量写入；会话进度在同一事务内提交，保证事务中断后可精确恢复 */
    async putBatch(records, session) {
      const db = this.ensure();
      const tx = db.transaction([STORE_RECORDS, STORE_META], 'readwrite');
      const store = tx.objectStore(STORE_RECORDS);
      for (const record of records) store.put(record);
      if (session) tx.objectStore(STORE_META).put({ key: 'session', ...session });
      await txDone(tx);
    }

    async saveSession(session) {
      const db = this.ensure();
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put({ key: 'session', ...session });
      await txDone(tx);
    }

    async getSession() {
      const db = this.ensure();
      const tx = db.transaction(STORE_META, 'readonly');
      const result = await reqToPromise(tx.objectStore(STORE_META).get('session'));
      return result || null;
    }

    async clearSession() {
      const db = this.ensure();
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).delete('session');
      await txDone(tx);
    }

    async count() {
      const db = this.ensure();
      const tx = db.transaction(STORE_RECORDS, 'readonly');
      return reqToPromise(tx.objectStore(STORE_RECORDS).count());
    }

    /** 清理策略：按 seq 升序驱逐最旧的 count 条（LRU 的确定性近似） */
    async evictOldest(count) {
      const db = this.ensure();
      const tx = db.transaction(STORE_RECORDS, 'readwrite');
      const index = tx.objectStore(STORE_RECORDS).index('by_seq');
      let removed = 0;
      let freedBytes = 0;
      await new Promise((resolve, reject) => {
        const cursorReq = index.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || removed >= count) return resolve();
          freedBytes += cursor.value.size || 0;
          cursor.delete();
          removed++;
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      await txDone(tx);
      return { removed, freedBytes };
    }

    /** 全量校验：重算校验和，返回损坏记录列表 */
    async verify(onProgress) {
      const db = this.ensure();
      const tx = db.transaction(STORE_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_RECORDS);
      const corrupted = [];
      let checked = 0;
      await new Promise((resolve, reject) => {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const record = cursor.value;
          checked++;
          if (typeof record.payload !== 'string' || fnv1a(record.payload) !== record.checksum) {
            corrupted.push({ seq: record.seq, store: 'indexeddb' });
          }
          if (onProgress && checked % 500 === 0) onProgress(checked);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      return { checked, corrupted };
    }

    /** 演示用：故意损坏一条记录 */
    async corruptOne() {
      const db = this.ensure();
      const tx = db.transaction(STORE_RECORDS, 'readwrite');
      const store = tx.objectStore(STORE_RECORDS);
      const first = await reqToPromise(store.openCursor());
      if (!first) return null;
      const record = first.value;
      record.payload = record.payload.slice(0, -1) + (record.payload.endsWith('X') ? 'Y' : 'X');
      first.update(record);
      await txDone(tx);
      return record.seq;
    }

    async clear() {
      const db = this.ensure();
      const tx = db.transaction([STORE_RECORDS, STORE_META], 'readwrite');
      tx.objectStore(STORE_RECORDS).clear();
      tx.objectStore(STORE_META).clear();
      await txDone(tx);
    }

    close() {
      if (this.db) {
        try { this.db.close(); } catch (_) { /* ignore */ }
        this.db = null;
      }
    }
  }

  /* ---------------- 内存降级后端（与 IDB 后端同构 API） ---------------- */

  class MemoryBackend {
    constructor() {
      this.map = new Map(); // seq -> record（Map 保持插入序，seq 递增即最旧在前）
    }

    get available() { return true; }

    async putBatch(records) {
      for (const record of records) this.map.set(record.seq, record);
    }

    async count() { return this.map.size; }

    async evictOldest(count) {
      let removed = 0;
      let freedBytes = 0;
      for (const [seq, record] of this.map) {
        if (removed >= count) break;
        freedBytes += record.size || 0;
        this.map.delete(seq);
        removed++;
      }
      return { removed, freedBytes };
    }

    async verify(onProgress) {
      const corrupted = [];
      let checked = 0;
      for (const record of this.map.values()) {
        checked++;
        if (typeof record.payload !== 'string' || fnv1a(record.payload) !== record.checksum) {
          corrupted.push({ seq: record.seq, store: 'memory' });
        }
        if (onProgress && checked % 2000 === 0) {
          onProgress(checked);
          await new Promise((r) => setTimeout(r, 0)); // 让出主线程
        }
      }
      return { checked, corrupted };
    }

    async corruptOne() {
      const first = this.map.values().next();
      if (first.done) return null;
      const record = first.value;
      record.payload = record.payload.slice(0, -1) + (record.payload.endsWith('X') ? 'Y' : 'X');
      return record.seq;
    }

    async clear() { this.map.clear(); }
  }

  /* ---------------- 混合引擎：统一写入入口，处理清理与降级 ---------------- */

  class HybridEngine {
    constructor(events) {
      this.events = events; // (type, detail) => void
      this.idb = new IdbBackend();
      this.spill = new MemoryBackend();
      this.degraded = false;      // 配额不足降级中
      this.idbSupported = true;   // 隐私模式等导致 IDB 不可用
      this.stats = { cleanups: 0, evicted: 0, freedBytes: 0 };
      this.idb.onLost = () => this.events('db-lost');
    }

    async init() {
      try {
        await this.idb.init();
      } catch (err) {
        // 隐私模式 / 禁用 IDB：不崩溃，直接整体降级到内存
        this.idbSupported = false;
        this.degraded = true;
        this.events('init-fallback', { message: err && err.message });
      }
    }

    /** 数据库被外部删除后尝试重建连接；失败则降级 */
    async reconnect() {
      this.idb.close();
      try {
        await this.idb.init();
        this.idbSupported = true;
        this.events('db-reconnected');
        return true;
      } catch (err) {
        this.idbSupported = false;
        this.degraded = true;
        this.events('init-fallback', { message: err && err.message });
        return false;
      }
    }

    get activeStoreName() {
      return this.degraded ? 'memory' : 'indexeddb';
    }

    /**
     * 写入一批记录。
     * 异常链路：配额不足 -> 清理最旧数据 -> 重试一次 -> 仍失败则降级到内存。
     * 其余错误原样抛出，由上层负责重试。
     */
    async writeBatch(records, session, { simulateQuotaError = false } = {}) {
      if (this.degraded || !this.idbSupported) {
        await this.spill.putBatch(records);
        return 'memory';
      }
      try {
        if (simulateQuotaError) {
          // 演示注入：走与真实配额不足完全一致的异常链路
          throw new DOMException('模拟的配额不足', 'QuotaExceededError');
        }
        await this.idb.putBatch(records, session);
        return 'indexeddb';
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        this.events('quota-exceeded', { message: err.message });
        const freed = await this.cleanup();
        if (freed.removed > 0) {
          try {
            await this.idb.putBatch(records, session);
            this.events('cleanup-recovered', freed);
            return 'indexeddb';
          } catch (retryErr) {
            if (!isQuotaError(retryErr)) throw retryErr;
          }
        }
        // 清理后仍写不进去：降级到内存，保证数据不丢
        this.degraded = true;
        this.events('degraded', { reason: 'quota' });
        await this.spill.putBatch(records);
        return 'memory';
      }
    }

    /** 清理策略：驱逐最旧的 10%（至少 50 条），返回释放统计 */
    async cleanup() {
      const total = await this.count();
      if (total === 0) return { removed: 0, freedBytes: 0 };
      const target = Math.max(50, Math.ceil(total * 0.1));
      const result = this.idbSupported && this.idb.available
        ? await this.idb.evictOldest(target)
        : await this.spill.evictOldest(target);
      this.stats.cleanups++;
      this.stats.evicted += result.removed;
      this.stats.freedBytes += result.freedBytes;
      this.events('cleanup', result);
      return result;
    }

    async count() {
      const idbCount = this.idbSupported && this.idb.available ? await this.idb.count() : 0;
      return idbCount + this.spill.map.size;
    }

    async counts() {
      const idbCount = this.idbSupported && this.idb.available ? await this.idb.count() : 0;
      return { indexeddb: idbCount, memory: this.spill.map.size };
    }

    /** 双存储合并校验：降级后数据一致性仍可验证 */
    async verify(onProgress) {
      const result = { checked: 0, corrupted: [] };
      if (this.idbSupported && this.idb.available) {
        const r = await this.idb.verify(onProgress);
        result.checked += r.checked;
        result.corrupted.push(...r.corrupted);
      }
      const m = await this.spill.verify(onProgress);
      result.checked += m.checked;
      result.corrupted.push(...m.corrupted);
      return result;
    }

    async corruptOne() {
      if (this.idbSupported && this.idb.available && (await this.idb.count()) > 0) {
        return { seq: await this.idb.corruptOne(), store: 'indexeddb' };
      }
      const seq = await this.spill.corruptOne();
      return seq === null ? null : { seq, store: 'memory' };
    }

    async getSession() {
      if (!this.idbSupported || !this.idb.available) return null;
      try { return await this.idb.getSession(); } catch (_) { return null; }
    }

    async finishSession(session) {
      if (this.idbSupported && this.idb.available) {
        await this.idb.saveSession({ ...session, status: 'done' });
      }
    }

    async clear() {
      if (this.idbSupported && this.idb.available) await this.idb.clear();
      await this.spill.clear();
      this.degraded = !this.idbSupported ? true : false;
      this.events('cleared');
    }
  }

  global.StorageEngine = { HybridEngine };
})(typeof self !== 'undefined' ? self : this);
