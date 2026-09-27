# IndexedDB 大数据写入与配额管理

零依赖、无框架的原生 Web 应用：向 IndexedDB 批量写入大量数据，实时监控存储配额，
配额不足时自动清理/降级，并覆盖完整的异常链路。

## 运行

需要通过 HTTP 访问（Web Worker 不支持 file://）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能与验收对照

| 能力 | 实现 |
| --- | --- |
| 大数据写入 | Web Worker 分批生成确定性数据，主线程批量事务写入（`js/worker.js`、`js/engine.js`） |
| 配额监控 | `navigator.storage.estimate()` 轮询 + 每批写入后刷新；Canvas 环形图 + 使用率历史曲线（`js/quota.js`、`js/app.js`） |
| 写入进度 | 按已提交批次更新进度条/记录数/字节数/速度，与实际提交严格一致 |
| 配额不足降级 | QuotaExceededError → 驱逐最旧 10%（至少 50 条）→ 重试一次 → 仍失败则降级内存存储，数据不丢 |
| 写入失败重试 | 非配额错误指数退避自动重试 3 次；仍失败进入错误态，可手动「重试」 |
| 事务中断恢复 | 会话进度与数据同事务提交；刷新/崩溃后从 `committed` 提交点精确恢复，数据确定性重生成保证一致 |
| 数据损坏检测 | 每条记录带 FNV-1a 校验和，「校验数据」全量重算并列出损坏记录（含内存降级数据） |
| 清理策略 | 按 seq 升序驱逐最旧记录（LRU 确定性近似），统计清理次数/驱逐条数/释放字节 |
| 降级一致性 | 内存后端与 IDB 后端同构 API，计数/校验/清空均合并两个存储 |
| 隐私模式 | IDB 打开失败或 StorageManager 不可用时自动整体降级内存并提示，不崩溃 |
| 数据库被删除 | 监听 `versionchange`，连接丢失后自动重建，失败则降级 |

## 异常演练

- 「下一批模拟配额不足」：注入 QuotaExceededError，观察 清理→重试→降级 链路。
- 「注入一条损坏数据」：篡改一条记录后用「校验数据」检出。
- 写入中途刷新页面：重新打开后出现恢复横幅，可从中断点无损继续。

## 文件结构

- `index.html` / `styles.css`：页面与样式
- `js/util.js`：校验和、确定性 PRNG、退避重试等纯函数（主线程与 Worker 共用）
- `js/engine.js`：IdbBackend / MemoryBackend / HybridEngine（清理、降级、恢复、校验）
- `js/quota.js`：StorageManager 封装（隐私模式安全降级）
- `js/worker.js`：确定性数据生成 Worker
- `js/app.js`：UI 状态机、写入流水线、Canvas 可视化、日志
