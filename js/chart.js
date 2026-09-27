import { formatBytes } from './quota.js';

export function drawQuotaChart(canvas, { usage, quota, memoryBytes }) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 220;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 14;
  const lineWidth = 22;
  const start = -Math.PI / 2;

  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  ctx.strokeStyle = '#2a2f3a';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  const valid = Number.isFinite(usage) && Number.isFinite(quota) && quota > 0;
  const ratio = valid ? Math.min(1, usage / quota) : 0;

  if (valid && ratio > 0) {
    const hue = ratio < 0.6 ? 152 : ratio < 0.85 ? 38 : 4;
    ctx.strokeStyle = `hsl(${hue} 70% 55%)`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + ratio * Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#e8eaf0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(size / 9)}px system-ui, sans-serif`;
  ctx.fillText(valid ? `${(ratio * 100).toFixed(1)}%` : '不可用', cx, cy - 8);
  ctx.font = `${Math.round(size / 16)}px system-ui, sans-serif`;
  ctx.fillStyle = '#9aa3b2';
  ctx.fillText(valid ? `${formatBytes(usage)} / ${formatBytes(quota)}` : 'StorageManager 不可用', cx, cy + 14);

  if (memoryBytes > 0) {
    ctx.fillStyle = '#b07fff';
    ctx.font = `${Math.round(size / 18)}px system-ui, sans-serif`;
    ctx.fillText(`内存降级 ≈ ${formatBytes(memoryBytes)}`, cx, cy + 34);
  }
}
