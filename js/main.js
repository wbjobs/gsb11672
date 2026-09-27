import { StorageEngine } from './db.js';
import { createWritePolicy } from './write-policy.js';
import { MemoryStore } from './memory-store.js';
import { getEstimate, requestPersistence, isPersisted, formatBytes } from './quota.js';
import { drawQuotaChart } from './chart.js';

const EVICT_FRACTION = 0.1;

const $ = (id) => document.getElementById(id);

const ui = {
  recordCount: $('record-count'),
  payloadSize: $('payload-size'),
  batchSize: $('batch-size'),
  btnStart: $('btn-start'),
  btnPause: $('btn-pause'),
  btnRetryFailed: $('btn-retry-failed'),
  btnVerify: $('btn-verify'),
  btnEvict: $('btn-evict'),
  btnClear: $('btn-clear'),
  btnReset: $('btn-reset'),
  btnPersist: $('btn-persist'),
  btnResume: $('btn-resume'),
  injectAbort: $('inject-abort'),
  injectQuota: $('inject-quota'),
  btnCorrupt: $('btn-corrupt'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  statMode: $('stat-mode'),
  statWritten: $('stat-written'),
  statIdb: $('stat-idb'),
  statMemory: $('stat-memory'),
  statFailed: $('stat-failed'),
  statRetried: $('stat-retried'),
  statEvicted: $('stat-evicted'),
  statCorrupt: $('stat-corrupt'),
  quotaCanvas: $('quota-canvas'),
  quotaDetail: $('quota-detail'),
  banner: $('banner'),
  log: $('log'),
};

const engine = new StorageEngine();
const memoryStore = new MemoryStore();

const state = {
  mode: 'idb',
  running: false,
  paused: false,
  target: 0,
  nextSeq: 0,
  written: 0,
  idbCount: 0,
  failedBatches: [],
  retryCount: 0,
  evicted: 0,
  corruptIds: [],
  estimate: null,
};

let worker = null;
let pendingBatch = null;

function log(message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${level}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  entry.textContent = `[${time}] ${message}`;
  ui.log.prepend(entry);
  while (ui.log.children.length > 200) {
    ui.log.lastChild.remove();
  }
}

function setBanner(text, kind) {
  if (!text) {
    ui.banner.hidden = true;
    return;
  }
  ui.banner.hidden = false;
  ui.banner.textContent = text;
  ui.banner.className = `banner banner-${kind}`;
}

function updateStats() {
  ui.statMode.textContent = state.mode === 'idb' ? 'IndexedDB' : '内存降级';
  ui.statMode.dataset.mode = state.mode;
  ui.statWritten.textContent = `${state.written} / ${state.target}`;
  ui.statIdb.textContent = String(state.idbCount);
  ui.statMemory.textContent = String(memoryStore.size);
  ui.statFailed.textContent = String(state.failedBatches.length);
  ui.statRetried.textContent = String(state.retryCount);
  ui.statEvicted.textContent = String(state.evicted);
  ui.statCorrupt.textContent = String(state.corruptIds.length);
  ui.btnRetryFailed.disabled = state.failedBatches.length === 0 || state.running;

  const ratio = state.target > 0 ? state.written / state.target : 0;
  ui.progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
  ui.progressText.textContent = `${(ratio * 100).toFixed(1)}% (${state.written}/${state.target})`;
}

async function refreshQuota() {
  state.estimate = await getEstimate();
  const estimate = state.estimate;
  drawQuotaChart(ui.quotaCanvas, {
    usage: estimate ? estimate.usage : NaN,
    quota: estimate ? estimate.quota : NaN,
    memoryBytes: memoryStore.bytesEstimate(),
  });
  if (estimate) {
    const persisted = await isPersisted();
    ui.quotaDetail.textContent =
      `已用 ${formatBytes(estimate.usage)} / 配额 ${formatBytes(estimate.quota)}` +
      (persisted === null ? '' : persisted ? ' · 已持久化' : ' · 未持久化(可能被回收)');
  } else {
    ui.quotaDetail.textContent = '当前环境不支持 StorageManager API(可能为隐私模式)';
  }
}

function ensureWorker() {
  if (worker) return;
  worker = new Worker('./js/data-worker.js', { type: 'module' });
  worker.onmessage = (event) => {
    if (event.data.type === 'batch' && pendingBatch) {
      const pending = pendingBatch;
      pendingBatch = null;
      pending.resolve(event.data.records);
    }
  };
  worker.onerror = (err) => {
    log(`Worker 错误: ${err.message}`, 'error');
    if (pendingBatch) {
      const pending = pendingBatch;
      pendingBatch = null;
      pending.reject(new Error(err.message || 'Worker 错误'));
    }
  };
}

function requestBatch(startSeq, count, payloadSize) {
  ensureWorker();
  return new Promise((resolve, reject) => {
    pendingBatch = { resolve, reject };
    worker.postMessage({ startSeq, count, payloadSize });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const policy = createWritePolicy({
  engine,
  memoryStore,
  state,
  log,
  shouldInjectAbort: () => {
    if (ui.injectAbort.checked && state.mode === 'idb' && Math.random() < 0.2) {
      log('故障注入: 中断当前事务', 'warn');
      return true;
    }
    return false;
  },
  onDegrade: () => setBanner('配额不足或存储不可用,已降级到内存存储(数据不落盘,刷新后丢失)', 'warn'),
});

async function runWriteLoop() {
  const payloadSize = Number(ui.payloadSize.value) * 1024;
  const batchSize = Number(ui.batchSize.value);

  while (state.running && !state.paused && state.nextSeq < state.target) {
    const count = Math.min(batchSize, state.target - state.nextSeq);
    let batch;
    try {
      batch = await requestBatch(state.nextSeq, count, payloadSize);
    } catch (err) {
      log(`数据生成失败: ${err.message},写入中止`, 'error');
      stopLoop();
      return;
    }
    if (!state.running) return;
    const committedSeq = state.nextSeq + batch.length - 1;
    try {
      await policy.writeBatch(batch, committedSeq);
      state.written += batch.length;
      state.nextSeq += batch.length;
    } catch (err) {
      log(`批次 [${state.nextSeq}..${committedSeq}] 重试后仍失败: ${err.message}`, 'error');
      state.failedBatches.push({ startSeq: state.nextSeq, records: batch });
      state.nextSeq += batch.length;
    }
    updateStats();
    refreshQuota();
    await sleep(0);
  }

  if (state.nextSeq >= state.target) {
    finishJob();
  }
}

function finishJob() {
  state.running = false;
  ui.btnStart.disabled = false;
  ui.btnPause.disabled = true;
  ui.btnPause.textContent = '暂停';
  const failedNote = state.failedBatches.length > 0 ? `,${state.failedBatches.length} 个批次失败可重试` : '';
  log(`写入完成,共 ${state.written} 条(IDB ${state.idbCount} / 内存 ${memoryStore.size})${failedNote}`, state.failedBatches.length > 0 ? 'warn' : 'ok');
  refreshQuota();
  updateStats();
}

async function startJob(fromSeq) {
  state.target = Number(ui.recordCount.value);
  state.nextSeq = fromSeq;
  state.written = fromSeq;
  state.running = true;
  state.paused = false;
  engine.beginJob(state.target);
  engine.simulateQuota = ui.injectQuota.checked;
  ui.btnStart.disabled = true;
  ui.btnPause.disabled = false;
  ui.btnResume.hidden = true;
  log(`开始写入 ${state.target - fromSeq} 条记录(起始 seq=${fromSeq})`);
  updateStats();
  await runWriteLoop();
}

async function retryFailedBatches() {
  if (state.failedBatches.length === 0) return;
  const failed = state.failedBatches.splice(0);
  state.running = true;
  ui.btnStart.disabled = true;
  log(`重试 ${failed.length} 个失败批次`, 'warn');
  updateStats();
  for (const { records } of failed) {
    const committedSeq = records[records.length - 1].seq;
    try {
      await policy.writeBatch(records, committedSeq);
      state.written += records.length;
      log(`失败批次 [${records[0].seq}..${committedSeq}] 重试成功`, 'ok');
    } catch (err) {
      state.failedBatches.push({ startSeq: records[0].seq, records });
      log(`批次 [${records[0].seq}..${committedSeq}] 重试仍失败: ${err.message}`, 'error');
    }
    updateStats();
  }
  state.running = false;
  ui.btnStart.disabled = false;
  updateStats();
  refreshQuota();
}

async function verifyIntegrity() {
  log('开始完整性校验(CRC32)…');
  try {
    const canVerifyIdb = engine.db && state.idbCount > 0;
    const [idbResult, memoryCorrupt] = await Promise.all([
      canVerifyIdb
        ? engine.verify().catch((err) => { log(`IDB 校验失败: ${err.message}`, 'error'); return { scanned: 0, corrupt: [] }; })
        : Promise.resolve({ scanned: 0, corrupt: [] }),
      Promise.resolve(memoryStore.verify()),
    ]);
    state.corruptIds = [...idbResult.corrupt, ...memoryCorrupt];
    const total = idbResult.scanned + memoryStore.size;
    if (state.corruptIds.length === 0) {
      log(`校验完成: ${total} 条记录全部完好`, 'ok');
    } else {
      log(`校验完成: ${total} 条中发现 ${state.corruptIds.length} 条损坏,如 ${state.corruptIds.slice(0, 3).join(', ')}`, 'error');
    }
  } catch (err) {
    log(`校验出错: ${err.message}`, 'error');
  }
  updateStats();
}

async function evictNow() {
  try {
    const current = await engine.count().catch(() => 0);
    const toEvict = Math.max(1, Math.floor(current * EVICT_FRACTION));
    const evicted = await engine.evictOldest(toEvict);
    state.evicted += evicted;
    state.idbCount = Math.max(0, state.idbCount - evicted);
    log(`手动清理: 移除 ${evicted} 条最旧记录`, 'ok');
  } catch (err) {
    log(`清理失败: ${err.message}`, 'error');
  }
  updateStats();
  refreshQuota();
}

async function clearAll() {
  stopLoop();
  try {
    if (engine.db) await engine.clearRecords();
    memoryStore.clear();
    state.written = 0;
    state.nextSeq = 0;
    state.idbCount = 0;
    state.failedBatches = [];
    state.corruptIds = [];
    log('已清空全部数据(IDB + 内存)', 'ok');
  } catch (err) {
    log(`清空失败: ${err.message}`, 'error');
  }
  updateStats();
  refreshQuota();
}

async function resetDatabase() {
  stopLoop();
  try {
    await engine.deleteDatabase();
    await engine.open();
    memoryStore.clear();
    Object.assign(state, {
      mode: 'idb', target: 0, nextSeq: 0, written: 0, idbCount: 0,
      failedBatches: [], retryCount: 0, evicted: 0, corruptIds: [],
    });
    setBanner(null);
    log('数据库已重置', 'ok');
  } catch (err) {
    setBanner('IndexedDB 不可用,仅内存模式', 'warn');
    log(`重置数据库失败,保持内存模式: ${err.message}`, 'warn');
  }
  updateStats();
  refreshQuota();
}

function stopLoop() {
  state.running = false;
  state.paused = false;
  ui.btnStart.disabled = false;
  ui.btnPause.disabled = true;
  ui.btnPause.textContent = '暂停';
}

async function checkRecovery() {
  try {
    const job = await engine.getMeta('job');
    if (job && job.target > 0 && job.committed < job.target - 1) {
      const remaining = job.target - job.committed - 1;
      ui.btnResume.hidden = false;
      ui.btnResume.textContent = `恢复未完成任务(剩余 ${remaining} 条)`;
      setBanner(`检测到未完成的写入任务: 已提交 ${job.committed + 1}/${job.target},可断点恢复`, 'warn');
      ui.btnResume.onclick = async () => {
        state.target = job.target;
        ui.recordCount.value = job.target;
        setBanner(null);
        await startJob(job.committed + 1);
      };
      log(`检测到未完成任务,checkpoint=${job.committed}`, 'warn');
    }
  } catch { /* 无历史任务 */ }
}

async function init() {
  try {
    await engine.open();
    state.idbCount = await engine.count();
    log('IndexedDB 已就绪');
  } catch (err) {
    state.mode = 'memory';
    setBanner(`IndexedDB 不可用(${err.name}),已自动降级到内存存储 — 隐私模式下应用仍可运行`, 'error');
    log(`IndexedDB 打开失败: ${err.message},进入内存模式`, 'error');
  }

  ui.btnStart.onclick = () => startJob(0);
  ui.btnPause.onclick = () => {
    if (!state.running) return;
    state.paused = !state.paused;
    ui.btnPause.textContent = state.paused ? '继续' : '暂停';
    log(state.paused ? '已暂停' : '继续写入');
    if (!state.paused) runWriteLoop();
  };
  ui.btnRetryFailed.onclick = retryFailedBatches;
  ui.btnVerify.onclick = verifyIntegrity;
  ui.btnEvict.onclick = evictNow;
  ui.btnClear.onclick = clearAll;
  ui.btnReset.onclick = resetDatabase;
  ui.btnPersist.onclick = async () => {
    const granted = await requestPersistence();
    log(granted === null ? '当前环境不支持持久化请求' : granted ? '已获得持久化存储授权' : '持久化请求被拒绝', granted ? 'ok' : 'warn');
    refreshQuota();
  };
  ui.injectQuota.onchange = () => {
    engine.simulateQuota = ui.injectQuota.checked;
    if (ui.injectQuota.checked) log('故障注入: 已开启模拟配额不足', 'warn');
  };
  ui.btnCorrupt.onclick = async () => {
    try {
      const id = await engine.corruptRandomRecord();
      if (id) log(`故障注入: 已篡改记录 ${id}(运行校验可检测)`, 'warn');
      else log('没有可篡改的记录', 'warn');
    } catch (err) {
      log(`篡改失败: ${err.message}`, 'error');
    }
  };

  window.addEventListener('resize', () => refreshQuota());

  await checkRecovery();
  updateStats();
  refreshQuota();
  setInterval(refreshQuota, 2000);
}

init();
