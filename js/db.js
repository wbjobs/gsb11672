import { crc32 } from './checksum.js';

const DB_NAME = 'bulk-storage-demo';
const DB_VERSION = 1;

export function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

export class StorageEngine {
  constructor() {
    this.db = null;
    this.lastTx = null;
    this.currentTarget = 0;
    this.simulateQuota = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new DOMException('IndexedDB 不可用', 'NotSupportedError'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'id' });
          store.createIndex('ts', 'ts', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db.close();
          this.db = null;
        };
        resolve();
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new DOMException('数据库被阻塞', 'InvalidStateError'));
    });
  }

  ensureOpen() {
    if (!this.db) {
      throw new DOMException('数据库连接已关闭', 'InvalidStateError');
    }
  }

  async reopen() {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
    await this.open();
  }

  beginJob(target) {
    this.currentTarget = target;
  }

  writeBatch(records, committedSeq) {
    if (this.simulateQuota) {
      return Promise.reject(new DOMException('模拟的配额不足', 'QuotaExceededError'));
    }
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(['records', 'meta'], 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }
      this.lastTx = tx;
      const store = tx.objectStore('records');
      for (const record of records) {
        store.put(record);
      }
      tx.objectStore('meta').put({ key: 'job', target: this.currentTarget, committed: committedSeq });
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
    });
  }

  abortCurrentTx() {
    if (this.lastTx) {
      try { this.lastTx.abort(); } catch { /* already finished */ }
    }
  }

  getMeta(key) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  setMeta(key, value) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, ...value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
    });
  }

  count() {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('records', 'readonly').objectStore('records').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  clearRecords() {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['records', 'meta'], 'readwrite');
      tx.objectStore('records').clear();
      tx.objectStore('meta').put({ key: 'job', target: 0, committed: -1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
    });
  }

  evictOldest(limit) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('records', 'readwrite');
      const index = tx.objectStore('records').index('ts');
      const request = index.openCursor();
      let evicted = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && evicted < limit) {
          cursor.delete();
          evicted += 1;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(evicted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
    });
  }

  verify(onProgress) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const corrupt = [];
      let scanned = 0;
      const tx = this.db.transaction('records', 'readonly');
      const request = tx.objectStore('records').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const record = cursor.value;
          if (typeof record.payload !== 'string' || crc32(record.payload) !== record.crc) {
            corrupt.push(record.id);
          }
          scanned += 1;
          if (onProgress && scanned % 500 === 0) onProgress(scanned);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve({ scanned, corrupt });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
    });
  }

  corruptRandomRecord() {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('records', 'readwrite');
      const request = tx.objectStore('records').openCursor();
      let target = null;
      const skip = Math.floor(Math.random() * 50);
      let seen = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && seen < skip) {
          seen += 1;
          cursor.continue();
        } else if (cursor) {
          const record = cursor.value;
          record.payload = record.payload.slice(0, -1) + (record.payload.endsWith('X') ? 'Y' : 'X');
          cursor.update(record);
          target = record.id;
        }
      };
      tx.oncomplete = () => resolve(target);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('事务被中断', 'AbortError'));
    });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  deleteDatabase() {
    this.close();
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }
}
