import { crc32 } from './checksum.js';

export class MemoryStore {
  constructor() {
    this.records = new Map();
  }

  putAll(records) {
    for (const record of records) {
      this.records.set(record.id, record);
    }
    return records.length;
  }

  get(id) {
    return this.records.get(id);
  }

  clear() {
    this.records.clear();
  }

  get size() {
    return this.records.size;
  }

  bytesEstimate() {
    let bytes = 0;
    for (const record of this.records.values()) {
      bytes += record.payload.length * 2 + 64;
    }
    return bytes;
  }

  verify() {
    const corrupt = [];
    for (const record of this.records.values()) {
      if (typeof record.payload !== 'string' || crc32(record.payload) !== record.crc) {
        corrupt.push(record.id);
      }
    }
    return corrupt;
  }
}
