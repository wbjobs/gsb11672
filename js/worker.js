/* 数据生成 Worker：把 CPU 密集的 payload 生成移出主线程。
   生成是确定性的（runId + seq 决定内容），事务中断后重发生成的数据与原来一致。 */
importScripts('util.js');

const { fnv1a, makePayload } = self.Util;

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.cmd !== 'generate') return;
  const { id, startSeq, count, recordSize, runId } = data;
  const records = new Array(count);
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const payload = makePayload(runId, seq, recordSize);
    records[i] = {
      seq,
      runId,
      payload,
      checksum: fnv1a(payload),
      size: recordSize,
      createdAt: Date.now()
    };
  }
  self.postMessage({ type: 'batch', id, records });
};
