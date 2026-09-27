/* 可在主线程与 Worker 中共用的纯工具函数 */
(function (global) {
  'use strict';

  /** FNV-1a 32bit 校验和，用于数据损坏检测 */
  function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /** 确定性 PRNG：相同 (runId, seq) 永远生成相同数据，保证中断恢复后数据一致 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  function makePayload(runId, seq, size) {
    const seed = (Math.imul(runId >>> 0, 0x9e3779b1) ^ Math.imul(seq, 0x85ebca77)) >>> 0;
    const rand = mulberry32(seed);
    let out = '';
    for (let i = 0; i < size; i++) {
      out += CHARSET[(rand() * CHARSET.length) | 0];
    }
    return out;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = -1;
    do {
      value /= 1024;
      unit++;
    } while (value >= 1024 && unit < units.length - 1);
    return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[unit];
  }

  function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
    return formatBytes(bytesPerSec) + '/s';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 指数退避重试：用于写入失败后的自动重试 */
  async function retry(fn, { attempts = 3, baseDelay = 300, maxDelay = 2000, shouldRetry = () => true, onAttempt } = {}) {
    let lastError;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn(i);
      } catch (err) {
        lastError = err;
        if (i === attempts || !shouldRetry(err)) throw err;
        const delay = Math.min(maxDelay, baseDelay * Math.pow(2, i - 1));
        if (onAttempt) onAttempt(i, delay, err);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  function isQuotaError(err) {
    if (!err) return false;
    return err.name === 'QuotaExceededError' || err.code === 22 || /quota/i.test(err.message || '');
  }

  global.Util = { fnv1a, mulberry32, makePayload, formatBytes, formatRate, sleep, retry, isQuotaError };
})(typeof self !== 'undefined' ? self : this);
