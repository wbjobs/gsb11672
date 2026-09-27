import { crc32 } from './checksum.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function makePayload(seq, size) {
  const rand = mulberry32(seq * 2654435761);
  const head = `record-${seq}:`;
  const body = new Array(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) {
    body[i] = ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return head + body.join('');
}

self.onmessage = (event) => {
  const { startSeq, count, payloadSize } = event.data;
  const records = new Array(count);
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const payload = makePayload(seq, payloadSize);
    records[i] = { id: `rec-${seq}`, seq, ts: Date.now() + i, payload, crc: crc32(payload) };
  }
  self.postMessage({ type: 'batch', startSeq, records });
};
