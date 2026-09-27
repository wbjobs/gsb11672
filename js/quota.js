export async function getEstimate() {
  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return null;
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

export async function requestPersistence() {
  if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
    return null;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function isPersisted() {
  if (!navigator.storage || typeof navigator.storage.persisted !== 'function') {
    return null;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / 2 ** (10 * i);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}
