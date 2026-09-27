import { isQuotaError } from './db.js';

const MAX_BATCH_RETRIES = 3;
const RETRY_BASE_MS = 300;
const EVICT_FRACTION = 0.1;

export function createWritePolicy({ engine, memoryStore, state, log, shouldInjectAbort, onDegrade, sleep }) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function persistCheckpoint(committedSeq) {
    try {
      await engine.setMeta('job', { target: state.target, committed: committedSeq });
    } catch { /* 内存模式下 checkpoint 仅尽力而为 */ }
  }

  async function handleQuotaExceeded(batch, committedSeq) {
    log('配额不足,执行 LRU 清理策略…', 'warn');
    const current = await engine.count().catch(() => 0);
    const toEvict = Math.max(1, Math.floor(current * EVICT_FRACTION));
    try {
      const evicted = await engine.evictOldest(toEvict);
      state.evicted += evicted;
      state.idbCount = Math.max(0, state.idbCount - evicted);
      log(`已清理 ${evicted} 条最旧记录,重试写入`, 'warn');
      await engine.writeBatch(batch, committedSeq);
      state.idbCount += batch.length;
      log('清理后写入成功', 'ok');
      return 'idb';
    } catch (err) {
      if (isQuotaError(err)) {
        log('清理后仍然配额不足', 'warn');
        return null;
      }
      throw err;
    }
  }

  async function degradeToMemory(batch, committedSeq) {
    if (state.mode !== 'memory') {
      state.mode = 'memory';
      log('已降级到内存存储,后续写入进入内存', 'error');
      if (onDegrade) onDegrade();
    }
    memoryStore.putAll(batch);
    await persistCheckpoint(committedSeq);
    return 'memory';
  }

  async function writeBatch(batch, committedSeq) {
    if (state.mode === 'memory') {
      memoryStore.putAll(batch);
      await persistCheckpoint(committedSeq);
      return 'memory';
    }

    if (shouldInjectAbort && shouldInjectAbort()) {
      setTimeout(() => engine.abortCurrentTx(), Math.floor(Math.random() * 30));
    }

    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
      try {
        await engine.writeBatch(batch, committedSeq);
        state.idbCount += batch.length;
        return 'idb';
      } catch (err) {
        if (isQuotaError(err)) {
          const recovered = await handleQuotaExceeded(batch, committedSeq);
          if (recovered) return recovered;
          return degradeToMemory(batch, committedSeq);
        }
        if (err.name === 'InvalidStateError' || err.name === 'UnknownError') {
          log(`数据库连接异常(${err.name}),尝试重新打开…`, 'warn');
          try {
            await engine.reopen();
            log('数据库已重新打开,重试当前批次', 'ok');
            continue;
          } catch (reopenErr) {
            log(`重新打开失败: ${reopenErr.message}`, 'error');
            return degradeToMemory(batch, committedSeq);
          }
        }
        if (attempt < MAX_BATCH_RETRIES) {
          state.retryCount += 1;
          const delay = RETRY_BASE_MS * 2 ** attempt;
          log(`批次写入失败(${err.name}),${delay}ms 后第 ${attempt + 1} 次重试`, 'warn');
          await wait(delay);
        } else {
          throw err;
        }
      }
    }
    throw new DOMException('重试耗尽', 'AbortError');
  }

  return { writeBatch };
}
