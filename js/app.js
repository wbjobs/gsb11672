/* 主控：UI 状态机、写入流水线、重试/恢复、配额可视化、日志 */
(function () {
  'use strict';

  const { formatBytes, formatRate, retry, isQuotaError, fnv1a, makePayload } = Util;

  const $ = (id) => document.getElementById(id);

  /* ---------------- 日志 ---------------- */

  function log(message, level = 'info') {
    const line = document.createElement('div');
    line.className = 'log-line log-' + level;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.innerHTML = '<span class="log-time">' + time + '</span>';
    line.appendChild(document.createTextNode(message));
    const box = $('log');
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- 运行状态 ---------------- */

  const state = {
    writing: false,
    paused: false,
    failed: false,
    failedRecords: null,
    runId: 0,
    seq: 0,
    target: 0,
    recordSize: 4096,
    batchSize: 50,
    startTime: 0,
    retries: 0,
    simQuota: false,
    workerDead: false
  };

  /* ---------------- 引擎与事件 ---------------- */

  const engine = new StorageEngine.HybridEngine((type, detail) => {
    switch (type) {
      case 'init-fallback':
        $('badge-privacy').classList.remove('hidden');
        $('badge-mode').textContent = '模式：内存（降级）';
        $('badge-mode').className = 'badge badge-mem';
        $('progress-bar').classList.add('degraded');
        log('IndexedDB 不可用（可能处于隐私模式），已自动降级为内存存储：' + ((detail && detail.message) || ''), 'warn');
        break;
      case 'quota-exceeded':
        log('配额不足，写入被拒绝（QuotaExceededError），开始执行清理策略…', 'warn');
        break;
      case 'cleanup':
        log('清理完成：驱逐最旧 ' + detail.removed + ' 条，释放 ' + formatBytes(detail.freedBytes), 'warn');
        break;
      case 'cleanup-recovered':
        log('清理后重试成功，继续使用 IndexedDB 写入', 'ok');
        break;
      case 'degraded':
        $('badge-mode').textContent = '模式：内存（降级中）';
        $('badge-mode').className = 'badge badge-mem';
        $('progress-bar').classList.add('degraded');
        log('清理后仍无法写入，新数据降级到内存存储，已有数据不丢失', 'error');
        break;
      case 'db-lost':
        log('数据库连接丢失（数据库可能被外部删除），尝试重建连接…', 'error');
        engine.reconnect().then((ok) => {
          if (ok) log('IndexedDB 连接已重建', 'ok');
        });
        break;
      case 'db-reconnected':
        log('IndexedDB 已重新连接', 'ok');
        break;
      case 'cleared':
        log('存储已清空（IndexedDB 与内存降级数据均已清除）', 'info');
        break;
    }
  });

  /* ---------------- 配额监控与 Canvas 可视化 ---------------- */

  const quotaMonitor = new QuotaMonitor();
  const ratioHistory = [];

  function setupCanvas(canvas) {
    const ratio = globalThis.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || canvas.width;
    const cssH = rect.height || canvas.height;
    canvas.width = Math.round(cssW * ratio);
    canvas.height = Math.round(cssH * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  function drawDonut(snapshot) {
    const canvas = $('quota-donut');
    const { ctx, w, h } = setupCanvas(canvas);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 14;
    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#232c40';
    ctx.lineWidth = 22;
    ctx.stroke();

    let ratio = snapshot ? snapshot.usageRatio : null;
    let label = 'N/A';
    if (ratio !== null) {
      ratio = Math.max(0, Math.min(1, ratio));
      label = (ratio * 100).toFixed(1) + '%';
      let color = '#5fe0b0';
      if (ratio >= 0.9) color = '#ff5d6c';
      else if (ratio >= 0.7) color = '#ffc46b';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
      ctx.strokeStyle = color;
      ctx.lineWidth = 22;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.fillStyle = ratio === null ? '#8596b5' : '#dfe6f3';
    ctx.font = '600 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy - 4);
    ctx.fillStyle = '#8596b5';
    ctx.font = '12px sans-serif';
    ctx.fillText(ratio === null ? '配额查询不可用' : '已用配额', cx, cy + 22);
  }

  function drawHistory() {
    const canvas = $('quota-history');
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#1c2536';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (ratioHistory.length < 2) return;
    ctx.beginPath();
    ratioHistory.forEach((ratio, i) => {
      const x = (i / 59) * w;
      const y = h - Math.max(0, Math.min(1, ratio)) * (h - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#5fe0b0';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function renderQuota(snapshot) {
    $('quota-usage').textContent = formatBytes(snapshot.usage);
    $('quota-total').textContent = snapshot.quota ? formatBytes(snapshot.quota) : '不限制/未知';
    $('quota-ratio').textContent = snapshot.usageRatio === null ? '—' : (snapshot.usageRatio * 100).toFixed(2) + '%';
    $('badge-quota').textContent = '配额：' + (snapshot.quota ? formatBytes(snapshot.quota) : '未知');
    ratioHistory.push(snapshot.usageRatio === null ? 0 : snapshot.usageRatio);
    if (ratioHistory.length > 60) ratioHistory.shift();
    drawDonut(snapshot);
    drawHistory();
  }

  quotaMonitor.onChange(renderQuota);

  /* ---------------- Worker 数据生成（失败则回退主线程） ---------------- */

  let worker = null;
  let batchSeq = 0;
  const pendingBatches = new Map();

  function ensureWorker() {
    if (worker || state.workerDead) return;
    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = (event) => {
        const { id, records } = event.data;
        const resolve = pendingBatches.get(id);
        if (resolve) {
          pendingBatches.delete(id);
          resolve(records);
        }
      };
      worker.onerror = () => {
        // Worker 加载失败时不崩溃：回退到主线程同步生成
        state.workerDead = true;
        pendingBatches.forEach((resolve) => resolve(null));
        pendingBatches.clear();
        log('Web Worker 不可用，已回退到主线程生成数据', 'warn');
      };
    } catch (_) {
      state.workerDead = true;
    }
  }

  function generateOnMain(startSeq, count) {
    const records = new Array(count);
    for (let i = 0; i < count; i++) {
      const seq = startSeq + i;
      const payload = makePayload(state.runId, seq, state.recordSize);
      records[i] = { seq, runId: state.runId, payload, checksum: fnv1a(payload), size: state.recordSize, createdAt: Date.now() };
    }
    return Promise.resolve(records);
  }

  function requestBatch(startSeq, count) {
    if (state.workerDead) return generateOnMain(startSeq, count);
    ensureWorker();
    if (state.workerDead) return generateOnMain(startSeq, count);
    const id = ++batchSeq;
    return new Promise((resolve) => {
      pendingBatches.set(id, resolve);
      worker.postMessage({ cmd: 'generate', id, startSeq, count, recordSize: state.recordSize, runId: state.runId });
    }).then((records) => records || generateOnMain(startSeq, count));
  }

  /* ---------------- 进度 UI ---------------- */

  function updateProgress(where) {
    const percent = state.target ? (state.seq / state.target) * 100 : 0;
    $('progress-bar').style.width = percent.toFixed(2) + '%';
    $('stat-percent').textContent = percent.toFixed(1) + '%';
    $('stat-records').textContent = state.seq + ' / ' + state.target;
    $('stat-bytes').textContent = formatBytes(state.seq * state.recordSize);
    const elapsed = (Date.now() - state.startTime) / 1000;
    $('stat-speed').textContent = elapsed > 0 ? formatRate((state.seq * state.recordSize) / elapsed) : '0 B/s';
    $('stat-retries').textContent = String(state.retries);
    $('stat-cleanup').textContent = engine.stats.cleanups + ' / ' + engine.stats.evicted + ' 条';
    if (where === 'memory') $('progress-bar').classList.add('degraded');
  }

  async function refreshCounts() {
    const counts = await engine.counts();
    $('stat-idb').textContent = String(counts.indexeddb);
    $('stat-mem').textContent = String(counts.memory);
  }

  /* ---------------- 写入流水线 ---------------- */

  function buildSession(status) {
    return {
      runId: state.runId,
      target: state.target,
      committed: state.seq,
      recordSize: state.recordSize,
      batchSize: state.batchSize,
      status: status || 'writing',
      updatedAt: Date.now()
    };
  }

  async function commitBatch(records, simulateQuota) {
    await retry(
      async () => {
        const where = await engine.writeBatch(records, buildSession('writing'), { simulateQuotaError: simulateQuota });
        state.seq += records.length;
        updateProgress(where);
      },
      {
        attempts: 3,
        baseDelay: 300,
        shouldRetry: (err) => !isQuotaError(err), // 配额错误引擎内部已处理，这里只重试普通写入失败
        onAttempt: (attempt, delay, err) => {
          state.retries++;
          updateProgress();
          log('第 ' + attempt + ' 次重试（' + delay + 'ms 后）：' + (err.message || err.name || err), 'warn');
        }
      }
    );
  }

  async function pump() {
    while (state.writing && !state.paused && state.seq < state.target) {
      const count = Math.min(state.batchSize, state.target - state.seq);
      const records = await requestBatch(state.seq, count);
      const simulate = state.simQuota;
      state.simQuota = false;
      $('btn-sim-quota').classList.remove('armed');
      try {
        await commitBatch(records, simulate);
        await quotaMonitor.refresh();
        if (state.seq % (state.batchSize * 10) === 0) refreshCounts();
      } catch (err) {
        // 自动重试 3 次仍失败：进入可手动重试的错误态（会话停在上一批提交点）
        state.writing = false;
        state.failed = true;
        state.failedRecords = records;
        state.paused = false;
        updateButtons();
        log('写入失败，已暂停等待手动重试：' + (err.message || err.name || err), 'error');
        return;
      }
    }
    if (state.seq >= state.target) {
      await finishRun();
    }
  }

  async function finishRun() {
    state.writing = false;
    state.paused = false;
    await engine.finishSession(buildSession('done'));
    await refreshCounts();
    updateButtons();
    updateProgress();
    log('全部 ' + state.target + ' 条（' + formatBytes(state.target * state.recordSize) + '）写入完成', 'ok');
  }

  function readOptions() {
    state.target = Math.round(Number($('opt-total').value) * 1024 * 1024 / state.recordSize);
    state.batchSize = Number($('opt-batch').value);
  }

  async function startRun({ resume = false } = {}) {
    state.recordSize = Number($('opt-record').value);
    state.batchSize = Number($('opt-batch').value);

    if (resume) {
      state.target = state.resumeSession.target;
      state.recordSize = state.resumeSession.recordSize;
      state.batchSize = state.resumeSession.batchSize || state.batchSize;
      state.runId = state.resumeSession.runId;
      state.seq = state.resumeSession.committed;
      $('resume-banner').classList.add('hidden');
      log('从提交点 seq=' + state.seq + ' 恢复，缺失批次将确定性重新生成，数据保持一致', 'ok');
    } else {
      readOptions();
      state.runId = (Math.random() * 0xffffffff) >>> 0;
      state.seq = 0;
      // 新任务前清空旧数据，避免与旧 seq 混淆
      await engine.clear();
      engine.stats = { cleanups: 0, evicted: 0, freedBytes: 0 };
    }

    state.retries = 0;
    state.failed = false;
    state.failedRecords = null;
    state.writing = true;
    state.paused = false;
    state.startTime = Date.now();
    $('progress-bar').classList.toggle('degraded', engine.degraded);
    updateProgress();
    updateButtons();
    log('开始写入：' + state.target + ' 条，每条 ' + formatBytes(state.recordSize) +
        '，批次 ' + state.batchSize + '，runId=' + state.runId, 'info');
    pump();
  }

  /* ---------------- 按钮状态 ---------------- */

  function updateButtons() {
    const busy = state.writing && !state.paused;
    $('btn-start').disabled = state.writing || state.failed;
    $('btn-pause').disabled = !state.writing && !state.paused;
    $('btn-pause').textContent = state.paused ? '继续' : '暂停';
    $('btn-retry').disabled = !state.failed;
    ['opt-total', 'opt-record', 'opt-batch'].forEach((id) => { $(id).disabled = state.writing || state.failed; });
    $('btn-sim-quota').disabled = !busy;
    $('btn-corrupt').disabled = false;
  }

  $('btn-start').addEventListener('click', () => startRun());

  $('btn-pause').addEventListener('click', () => {
    if (state.paused) {
      state.paused = false;
      updateButtons();
      log('继续写入', 'info');
      pump();
    } else {
      state.paused = true;
      updateButtons();
      log('已暂停（当前批次完成后停止，会话进度已持久化，可安全关闭页面）', 'info');
    }
  });

  $('btn-retry').addEventListener('click', () => {
    if (!state.failed) return;
    state.failed = false;
    state.writing = true;
    updateButtons();
    log('手动重试失败批次…', 'warn');
    pump();
  });

  $('btn-sim-quota').addEventListener('click', () => {
    if (!state.writing || state.paused) return;
    state.simQuota = true;
    $('btn-sim-quota').classList.add('armed');
    log('已注入：下一批将触发 QuotaExceededError，观察清理→重试→降级链路', 'warn');
  });

  $('btn-corrupt').addEventListener('click', async () => {
    const result = await engine.corruptOne();
    if (!result) { log('当前没有可损坏的数据', 'warn'); return; }
    log('已在 ' + result.store + ' 中损坏 seq=' + result.seq + '，点击「校验数据」可检出', 'warn');
  });

  $('btn-verify').addEventListener('click', async () => {
    log('开始校验全部记录（重算 FNV-1a 校验和）…', 'info');
    const result = await engine.verify((checked) => {
      $('stat-percent').textContent = '校验中 ' + checked;
    });
    if (result.corrupted.length === 0) {
      log('校验通过：' + result.checked + ' 条记录全部完整（含内存降级数据）', 'ok');
    } else {
      const list = result.corrupted.slice(0, 10).map((c) => 'seq=' + c.seq + '@' + c.store).join(', ');
      log('发现 ' + result.corrupted.length + ' 条损坏记录：' + list +
          (result.corrupted.length > 10 ? ' …' : ''), 'error');
    }
    updateProgress();
  });

  $('btn-clear').addEventListener('click', async () => {
    state.writing = false;
    state.paused = false;
    state.failed = false;
    await engine.clear();
    state.seq = 0;
    engine.stats = { cleanups: 0, evicted: 0, freedBytes: 0 };
    updateProgress();
    await refreshCounts();
    updateButtons();
  });

  $('btn-reset').addEventListener('click', async () => {
    state.writing = false;
    state.paused = false;
    state.failed = false;
    state.seq = 0;
    state.target = 0;
    state.retries = 0;
    state.startTime = 0;
    engine.stats = { cleanups: 0, evicted: 0, freedBytes: 0 };
    $('resume-banner').classList.add('hidden');
    $('badge-mode').textContent = engine.degraded ? '模式：内存（降级）' : '模式：IndexedDB';
    $('badge-mode').className = engine.degraded ? 'badge badge-mem' : 'badge badge-idb';
    $('badge-privacy').classList.toggle('hidden', engine.idbSupported);
    $('progress-bar').classList.remove('degraded');
    await engine.clear();
    updateProgress();
    await refreshCounts();
    updateButtons();
    log('已重置全部状态', 'info');
  });

  $('btn-resume').addEventListener('click', () => startRun({ resume: true }));
  $('btn-discard').addEventListener('click', async () => {
    $('resume-banner').classList.add('hidden');
    await engine.clear();
    state.resumeSession = null;
    log('已丢弃中断的会话并清空数据', 'info');
    refreshCounts();
  });

  /* ---------------- 事务中断恢复检测 ---------------- */

  async function detectInterruptedSession() {
    const session = await engine.getSession();
    if (session && session.status === 'writing' && session.committed < session.target) {
      state.resumeSession = session;
      $('resume-info').textContent = session.committed + ' / ' + session.target +
        ' 条（' + formatBytes(session.committed * session.recordSize) + ' / ' +
        formatBytes(session.target * session.recordSize) + '）';
      $('resume-banner').classList.remove('hidden');
      log('检测到未完成事务：committed=' + session.committed + '，可从该提交点精确恢复', 'warn');
    }
  }

  // 页面关闭时标记暂停；下次打开可恢复
  window.addEventListener('pagehide', () => {
    if (state.writing || state.paused) {
      // 最后一批的会话已在事务中提交，这里仅做尽力刷新
      if (engine.idbSupported && engine.idb.available) {
        engine.idb.saveSession(buildSession('writing')).catch(() => {});
      }
    }
  });

  /* ---------------- 启动 ---------------- */

  (async function init() {
    await engine.init();
    state.recordSize = Number($('opt-record').value);
    state.batchSize = Number($('opt-batch').value);

    if (!quotaMonitor.supported) {
      $('badge-quota').textContent = '配额：StorageManager 不可用';
      $('badge-quota').className = 'badge badge-warn';
      drawDonut(null);
      drawHistory();
      log('navigator.storage 不可用（隐私模式或旧浏览器），配额监控关闭，写入仍可进行并按异常降级', 'warn');
    } else {
      quotaMonitor.start(2000);
      quotaMonitor.isPersisted().then((persisted) => {
        $('quota-persisted').textContent = persisted ? '是' : '否';
      });
    }

    if (engine.degraded) {
      $('badge-mode').textContent = '模式：内存（降级）';
      $('badge-mode').className = 'badge badge-mem';
      $('badge-privacy').classList.remove('hidden');
      $('progress-bar').classList.add('degraded');
    }

    await detectInterruptedSession();
    await refreshCounts();
    updateButtons();
    updateProgress();
    log('应用已就绪', 'ok');
  })();
})();
