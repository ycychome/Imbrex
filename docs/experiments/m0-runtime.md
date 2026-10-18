# M0 运行验收与覆盖范围

基线：0.3。工具链：Linux、Node 24.22.0、npm 11.19.1；SQLite 3.53.4，WAL/FULL、foreign_keys=ON、busy_timeout=5000。源代码和锁文件随对应 PR 保存，运行结果不构成 M1/M2 验收。

## 1. 复现命令与预期

在不含 node_modules、dist 或 .private 的干净检出中执行 npm ci、npm run check；设置两个演示环境变量后，运行 npm start -- --config examples/demo.json。完整步骤见[开发指南](../development.md#m0-run)。

独立预期为两条原事件、两条派生事件及固定父引用，GET /v1/info 的 latest_seq 为 4，mock.echo 返回原文字，插件状态可查看，observer 保存自己的位置。关闭重启后 store_id 和事件总数不变。HTTP 请求必须携带对应权限凭据。

实际干净检出结果：npm ci 后锁文件未变化；类型检查、构建与 40 项风险测试通过；npm audit 为 0 项漏洞。用 npm start 连续启动两次，均验证四条事件、echo 结果、插件状态与 observer 位置，第二次 store_id 保持，两个进程都正常关闭。文档的 85 处本地链接及 JSON/SQL 示例检查通过。

## 2. 任务与证据映射

| 任务 | 实现与验证证据 |
| --- | --- |
| M0-01 | 精确版本、lockfile、严格类型检查、构建与 CI；[前置探针](../development.md) |
| M0-02 | host/config 与 cli/start/run；配置/凭据错误拒绝、实际宿主持锁、第二实例退出 75、SIGKILL 后可重启、SIGTERM 正常关闭 |
| M0-03 | core/validation/schema 与 HTTP DTO；[基础验证](m0-foundation.md)，含精度、Unicode、schema 与查询边界 |
| M0-04 | storage worker 和 core/events；[存储验证](m0-storage.md)，含提交/通知隔离、去重、分页及故障 |
| M0-05 | core/capabilities；[调用验证](m0-capabilities.md)，含稳定意图、未知结果、持久化失败与真实执行限额 |
| M0-06 | host/host、plugin-api 与编译模板；required/optional、Config、绑定/子作用域、启停、依赖卸载、清理异常和旧 API 撤销 |
| M0-07 | adapters/http/server；接口真实读写与工具/调用查询，401/403/400/409/413/429、UTF-8、压缩拒绝、未完成请求上限、响应丢失 |
| M0-08 | examples/demo.json、fixture/transform/observer/mock；四条预期事件、独立进度、重启去重与实际 mock.echo 调用 |

关键自动化证据为 test/core、test/storage、test/host、test/prerequisites。测试仅针对可复现问题和有依据的风险，不以数量或覆盖率作为完成条件。

## 3. 宿主与协议故障边界

- 插件卸载等待本实例调用响应被确定或记录为 unknown；未知操作仍可能在外部执行，不能自动重发。底层句柄由插件响应 signal 并显式释放。
- Cordis 的 thenable 包装与实际 fiber 分开处理；清理异常虽被 Cordis 收集，也会被宿主报告为 stop_failed，并禁止该实例重新启动。
- 依赖卸载使用 Cordis 自身作用域，撤销旧 API 的 signal、能力及通知；恢复时重新绑定。并不实现热安装或远程插件管理平台。
- worker 终止后队列失败，HTTP 宿主关闭并通知启动监督代码；内部异常和插件状态不携带凭据或消息正文。
- HTTP 首次响应丢失时，原 call_id 的调用继续持久化；重试只查询 in_progress/已完成记录，不再派发。不同主体不能查询该记录。

## 4. 查询计划检查

在临时数据库写入 64 条受控事件后，执行 EXPLAIN QUERY PLAN：按 event_type 和 seq 范围读取使用 events_type_seq 索引；仅按 seq 范围读取使用 INTEGER PRIMARY KEY。没有为首版增加额外索引或分区。这是有限数据集下的查询计划检查，不是吞吐或长期容量验收。

## 5. 未覆盖的后续范围

M0 完成 G01—G03 与 T01—T03、T05/T06 的公共部分。T04 仅覆盖模拟来源；真实 QQ/OneBot、Agent、协议实现兼容性由 M1 验证。observer 完整事件副本和第二消费者交付属于 M2。断电、主机毁损、附件、自动 GC、任意来源完整采集及平台端恰好一次均未由这些结果证明。
