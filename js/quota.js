/* StorageManager 配额监控；隐私模式/不支持的环境下安全降级为 null，绝不抛错 */
(function (global) {
  'use strict';

  class QuotaMonitor {
    constructor() {
      this.supported = !!(global.navigator && global.navigator.storage && typeof global.navigator.storage.estimate === 'function');
      this.last = null; // { usage, quota, usageRatio }
      this.listeners = new Set();
      this.timer = null;
    }

    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    /** 返回估算结果或 null（隐私模式 / API 不可用 / 调用抛错） */
    async estimate() {
      if (!this.supported) return null;
      let value;
      try {
        value = await navigator.storage.estimate();
      } catch (_) {
        return null;
      }
      if (!value || (!Number.isFinite(value.quota) && !Number.isFinite(value.usage))) return null;
      const quota = Number.isFinite(value.quota) ? value.quota : null;
      const usage = Number.isFinite(value.usage) ? value.usage : 0;
      const result = {
        usage,
        quota,
        usageRatio: quota && quota > 0 ? Math.min(1, usage / quota) : null
      };
      this.last = result;
      return result;
    }

    async isPersisted() {
      if (!this.supported || !navigator.storage.persisted) return false;
      try { return await navigator.storage.persisted(); } catch (_) { return false; }
    }

    start(intervalMs = 2000) {
      this.stop();
      const tick = async () => {
        const value = await this.estimate();
        if (value) this.listeners.forEach((fn) => fn(value));
      };
      tick();
      this.timer = setInterval(tick, intervalMs);
    }

    /** 写入循环中高频刷新（写入后调用） */
    async refresh() {
      const value = await this.estimate();
      if (value) this.listeners.forEach((fn) => fn(value));
      return value;
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  global.QuotaMonitor = QuotaMonitor;
})(typeof self !== 'undefined' ? self : this);
