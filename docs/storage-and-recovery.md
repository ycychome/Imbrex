# 事件、读取与网关存储

统一开发基线 0.3 · 2026-10-18。本文是事件与存储行为规范；HTTP 字段和限额集中在 [HTTP 契约](contracts.md)。

## 1. 信封与事件身份

发布封装为 `{ store_id, event, parents? }`。event 采用 JSON-only 的 CloudEvents 子集，必填 specversion=1.0、source、id、type、datacontenttype=application/json、data；可选 time、subject、dataschema。parents 是外层 EventRef 数组，默认空数组。[R4](references.md#r4)

source 是有效绝对 URI，id/type 为非空字符串；保留原字符串，不通过大小写转换、URI 重新序列化或 Unicode 规范化改变身份。dataschema 只作标识，不触发网络请求。data 可以是任意受限的 JSON 值；平台 ID 与精确大数使用字符串。来源 time 可省略，accepted_at 由网关生成，二者不互相代替。

身份为当前存储中的 `(source,id)`。同一原生对象的创建、编辑、撤回是不同发生，可引用同一对象 ID，但应有各自的事件身份。parents 表示生产者声明的因果关系，不证明真实性，也不要求父事件仍可读取。

## 2. First-write-wins

先检查授权、输入和 store_id，再在事务内针对 `(source,id)` 执行指定约束冲突处理：

- 未存在：写入事件，返回 created、原始接纳时间和新序号。
- 已存在：不覆盖、不合并、不重新广播，返回 duplicate_identity 和原序号。
- 其他约束或存储错误：按真实错误返回，不用宽泛的 INSERT OR IGNORE 掩盖。

duplicate_identity 不证明本次正文与旧正文相同，也不表示新正文已被保存。HTTP 发布只返回接纳回执；查旧正文走读取授权。连接器必须认真确定身份范围，first-write-wins 接受错误复用身份可能保留错误首条的代价。

本版不计算 JCS、事件全文指纹或删除后的身份目录。普通 JSON 解析后的值就是本版处理的数据：不承诺保留原 JSON 字节、重复键历史或已经被上游解析器舍入的数值。应用需精确保真的内容自行编码为字符串或外部材料。

## 3. store_id 与序号

建库时生成 UUID store_id 并持久保存。普通重启不改变它；同一进程不在线切换数据库。读取、查事件、发布、调用和查询调用记录均绑定预期 store_id；HTTP 显式携带，已绑定的进程内客户端使用创建时绑定的实例。

将同一个标识用于事件写入和工具调用，是本基线统一的存储绑定规则：旧客户端不能在网关重建后把旧发布或回复意图悄悄发送到新存储。无需再引入多种 epoch 或签名令牌。

事件 seq 使用 SQLite INTEGER PRIMARY KEY AUTOINCREMENT。内核为 bigint，HTTP 为非负十进制字符串；事件 seq 大于 0，初始读取边界为 0，上界为 2^63−1。序号不承诺连续，禁止插件指定 seq、回写旧位置或重置 SQLite 序号表。[R3](references.md#r3)

latest_seq 是当前事件表已提交最大序号，空表为 0。首版不删除事件，因此它在同一存储中不倒退。只有提交后的行能作为对外边界；回滚产生的空洞或未提交编号不对外发布。

## 4. 分页与过滤

读取传入 store_id、after_seq、limit，可附一个 source_prefix 和一个 type；两项过滤按 AND。source_prefix 为区分大小写的字面前缀，type 完全相等；不存在 SQL 通配或正则语义。服务端还必须施加当前来源读取授权。

单页在短事务中：核对 store_id → 取得 through_seq=latest_seq → 查询 `after_seq < seq <= through_seq` 范围内满足过滤与权限的记录，按 seq 升序，最多取 limit+1 条。

| 查询结果 | 返回记录 | next_after_seq | caught_up |
| --- | --- | --- | --- |
| 多于 limit | 前 limit 条 | 最后一条返回记录的位置 | false |
| 不多于 limit | 全部匹配记录 | through_seq | true |
| 没有匹配 | 空数组 | through_seq | true |

输入 after_seq 大于 through_seq 返回 position_ahead；store_id 不匹配返回 store_mismatch。任何错误都不生成可以自动保存的新进度。

through_seq 只对本页有效，下一页会获得新的短事务视图。caught_up 只说明本页上界下已没有更多获授权匹配项，不说明来源完整或业务完成。这里没有跨页长事务或通用 snapshot 会话。

客户端在完成相应应用责任后，才把 next_after_seq 保存为自己的进度。改过滤或授权范围时，应用显式决定补读或新起点，不能默认旧子集位置代表新范围都处理过。

<a id="database-schema"></a>

## 5. 表与索引的最小职责

网关只有一个数据库文件，初始 schema_version=1，由内核拥有。当前实现结构如下；验证范围见[存储验证](experiments/m0-storage.md)：

```sql
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  parents_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE(source, event_id)
);
CREATE INDEX events_type_seq ON events(event_type, seq);

CREATE TABLE calls (
  caller_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','succeeded','failed','unknown')),
  result_json TEXT,
  reason_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(caller_id, call_id)
);
```

metadata 至少保存 store_id 和 schema_version；规范事件保存在 event_json，常用查询字段由内核一次写入并保持一致。前缀匹配应实现字面语义，不能直接依赖默认 LIKE 的大小写/通配行为。先用有限数据集检查查询计划，按测量再加索引，不建设多个物理分区。

calls 的状态与派发语义见[能力契约](capabilities.md)。配置和插件实例来自本地配置文件，首版不建立配置控制面数据库。应用自己的决策/检查点不写进网关表。

## 6. 数据库 worker 与事务纪律

管理员调用列表复用 calls 主键，按 (caller_id,call_id) 字典序及可选主体/状态过滤，最多读取 limit+1 条判断下一页；无新增审计副本表。状态可在分页间变化，列表不承诺跨页快照或时间排序，权限由核心 admin:inspect 入口检查。

所有网关 SQL 由一个专用 worker 执行，完整命令串行，不允许两个业务命令的事务交错。命令队列有界，排队超限在入队前报 busy。HTTP 请求超时或断开不撤销已提交事务。

启动设置并读回 WAL、synchronous=FULL、foreign_keys=ON、busy_timeout=5000ms；关闭扩展加载，读取实际 SQLite 版本/source id。所有可能返回 seq 的语句启用 BigInt 读取控制。参考 API 与实验门槛见 [技术依据](references.md#r1)。

每个写命令在短事务中完成，不跨网络请求或任意插件 await 持有事务。事件创建和它的字段一起提交；调用占位记录和状态更新分别是短事务；不把远端操作放在 SQLite 事务中。

迁移由内核启动时独占执行，版本高于程序支持范围时拒绝启动。一个数据目录只允许一个网关实例；由数据目录进程锁实现，不能把 SQLite 单写者误当宿主唯一实例锁。锁获取、拒绝竞争及进程退出后释放由 M0 在目标平台验证，异常时明确拒绝而不是猜测接管。

## 7. 提交后的通知

COMMIT 成功即确定本次接纳结果。通知随后尝试触发，仅 created 产生“有新事件”的提示；重复身份不产生新业务输入。通知的同步错误与异步拒绝都被处理并记录，不推翻接纳结果。

优先复用 Cordis 的受控并发通知机制；具体行为按锁定版本验证。可靠消费者收到提示后从本地位置读取；也在启动、重连和低频定时器中补查。通知无 ACK、无持久队列，可以合并或丢失。[R2](references.md#r2)

每个参考消费者只运行一个读取循环；循环忙时把新提示合并为一个 pending 标记，不对每条提示创建无界 Promise。重业务不在通知回调同步执行。

## 8. 空间与恢复边界

首版不自动 GC，也不推荐外部脚本在线逐条 DELETE。达到实际存储限制或写入失败时，返回 storage_unavailable，保留已有数据；通知和日志不冒充接纳成功。占用增长是本方案接受的首版限制。

开发数据可停机后整体重建并生成新 store_id。真实数据若需要自动保留策略，须先增加最早可读边界、旧位置错误和调用去重期限，再实现删除。

恢复旧备份需显式更新 store_id 并处置客户端状态与旧调用意图；备份副本自动带着旧标识，普通启动无法猜出它被回滚了。具体步骤与不承诺的故障域见 [运维说明](operations.md)。
