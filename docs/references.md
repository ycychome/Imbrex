# 固定版本、技术依据与证据范围

统一开发基线 0.3 · 核对日期：2026-10-18。以下区分官方来源观察与运行验证。**M0-01 已安装锁定依赖并运行前置探针；未连接真实 OneBot 服务。** 结果见[工程基线](development.md)。

<a id="r1"></a>

## R1 · Node 与 SQLite 绑定

参考 Node 版本为 24.22.0；读取了固定版本的 `doc/api/sqlite.md` 与 `globals.md`。SQLite 模块文档标为 Stability 1.2 / release candidate，提供同步数据库接口、BigInt 读取设置和 backup。同步调用放到专用 worker 是本方案的选择。

固定 Node SQLite 头文件版本为 3.53.4，source id 为 `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`；M0-01 查询官方 Linux x64 二进制绑定得到相同结果。不能只检查系统 sqlite 命令。

```text
https://github.com/nodejs/node/blob/v24.22.0/doc/api/sqlite.md
https://github.com/nodejs/node/blob/v24.22.0/doc/api/globals.md#queuemicrotaskcallback
https://github.com/nodejs/node/blob/v24.22.0/deps/sqlite/sqlite3.h
```

queueMicrotask 的异常不会自动被吞掉。通知需要处理同步错误和异步拒绝，不能只靠调度方式。

<a id="r2"></a>

## R2 · Cordis

源码观察提交：`5dac6953d2d993d345d1de9fb0a5926f6d78a7e7`，其 package.json 声明 4.0.0-rc.11。本次也核对 npm 中该版本存在；它是首个运行探针，不声称是最新版本或全部组合已兼容。

registry.ts 包含插件注册和依赖声明；fiber.ts 包含生命周期、effect 和清理；events.ts 的 emit 直接调用监听器，parallel 收集结果并报告错误。清理与副作用恢复是不同机制，Cordis 不替代调用表或应用状态。

```text
https://github.com/cordiverse/cordis/blob/5dac6953d2d993d345d1de9fb0a5926f6d78a7e7/packages/core/package.json
https://github.com/cordiverse/cordis/blob/5dac6953d2d993d345d1de9fb0a5926f6d78a7e7/packages/core/src/registry.ts
https://github.com/cordiverse/cordis/blob/5dac6953d2d993d345d1de9fb0a5926f6d78a7e7/packages/core/src/fiber.ts
https://github.com/cordiverse/cordis/blob/5dac6953d2d993d345d1de9fb0a5926f6d78a7e7/packages/core/src/events.ts
https://registry.npmjs.org/cordis/4.0.0-rc.11
```

npm 包与 Git 提交显示相同版本号，不证明包内每个字节对应此提交。package-lock.json 的 integrity 与实际安装结果是运行基线。M0-01 已验证加载/卸载及异步 effect 清理；发布声明的 NodeNext 扩展名问题与编译选择见[工程基线](development.md)。

<a id="r3"></a>

## R3 · SQLite 事务、序号和备份

官方文档支持 AUTOINCREMENT 的非复用与非连续语义、WAL 下的短事务读取视图、同步配置和一致备份机制。WAL 是持久状态的一部分，不能在活跃状态下只复制主库文件。在线文档观察日期为本文件日期。

```text
https://sqlite.org/autoinc.html
https://sqlite.org/isolation.html
https://sqlite.org/wal.html
https://sqlite.org/pragma.html#pragma_synchronous
https://sqlite.org/backup.html
```

这些资料不证明本机断电耐久，也不提供应用检查点或外部动作的共同事务。实际环境与测试记录必须另外保存。

<a id="r4"></a>

## R4 · CloudEvents

沿用规范 v1.0.2；线上 specversion=1.0。身份由 source+id 组合，time、subject、dataschema 等是事件属性。本方案自己的 JSON-only 子集、外层 parents、HTTP 回执和位置不属于 CloudEvents 自带投递协议。

```text
https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/formats/json-format.md
```

<a id="r5"></a>

## R5 · JSON Schema 与 Ajv

使用 Draft 2020-12 的受控子集。校验器锁定 Ajv 8.20.0，替代存在安全公告的原候选 8.17.1；removeAdditional/useDefaults/coerceTypes 显式关闭。M0-01 使用 Ajv2020 入口验证非法输入不会被强转、补默认值或删字段。无需使用 loadSchema 加载远端 schema。

```text
https://json-schema.org/draft/2020-12
https://github.com/ajv-validator/ajv/blob/v8.20.0/docs/options.md
https://registry.npmjs.org/ajv/8.20.0
```

业务词汇子集、错误映射和工具接口兼容仍须 M0-03/M0-05 验证；schema 不是权限或语义正确性的证明。JSON Schema 链接作为规范入口，具体选项依据为 Ajv 固定源码；本次仅验证基础集成。

<a id="r6"></a>

## R6 · NapCat：OneBot 服务实现之一

源码观察提交：`810052c605feb5044a080adfe99ba2fa69b7b351`。本次读取 SendMsg.ts 与 SendGroupMsg.ts，能定位参数、目标选择、消息发送及 message_id 返回路径。

```text
https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-onebot/action/msg/SendMsg.ts
https://github.com/NapNeko/NapCatQQ/blob/810052c605feb5044a080adfe99ba2fa69b7b351/packages/napcat-onebot/action/group/SendGroupMsg.ts
```

这些路径说明该实现中可定位的发送行为，不是 Imbrex 的插件 API，也不要求引入其 SDK。M1 记录实际服务版本、客户端/账号模式、连接配置和覆盖范围；历史入口存在不证明断线消息已补回。

<a id="r7"></a>

## R7 · OneBot 11

参考提交：`d4456ee706f9ada9c2dfde56a2bcfc69752600e4`。已读取正向/反向 WS、认证及公开动作约定：正向通用连接提供动作与事件，认证可通过 Authorization 头，get_version_info/get_login_info 用于元数据与账号核对。WS echo 用于请求与响应对应；发送 API 返回 message_id，不提供“重复 echo 即去重发送”的保证。

```text
https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/ws.md
https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/ws-reverse.md
https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/authorization.md
https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md
```

<a id="r8"></a>

## R8 · M0-01 锁定依赖与替换依据

| 项 | 锁定版本 | 实际验证 |
| --- | --- | --- |
| Node / npm | 24.22.0 / 11.19.1 | 官方 Linux x64 发行版，下载 SHA256 已核验，运行探针通过 |
| Cordis | 4.0.0-rc.11 | 加载/卸载等待异步清理，重载不残留监听器 |
| TypeScript | 5.9.3 | ESNext/Bundler 下完整类型检查与编译通过 |
| Ajv | 8.20.0 | Ajv2020 入口与输入不变性验证通过 |
| ws | 8.22.0 | 超限帧拒绝验证通过，未连接真实 OneBot 服务 |
| @types/node / @types/ws | 24.19.2 / 8.18.2 | 与上述依赖共同通过类型检查 |

```text
https://registry.npmjs.org/typescript/5.9.3
https://registry.npmjs.org/ws/8.22.0
https://github.com/advisories/GHSA-2g4f-4pwh-qvx6
https://github.com/advisories/GHSA-58qx-3vcg-4xpx
https://github.com/advisories/GHSA-96hv-2xvq-fx4p
```

原候选 Ajv 8.17.1 命中 `$data` ReDoS 公告；ws 8.18.3 命中未初始化内存泄露与碎片内存耗尽公告，因此替换为表中的修复版本。完整传递依赖和 integrity 已锁定，核验日 `npm audit` 为 0 项漏洞。具体复现命令与有限测试范围见[工程基线](development.md)；引擎范围符合不等于所有业务集成都已兼容。

<a id="r9"></a>

## R9 · 证据范围

正式开发选择与取舍集中在[决策记录](decisions.md)。本文件保留支撑当前设计的公开来源及固定版本，不收录讨论记录或无关调研。

机制观察、官方声明和本项目运行验证是不同层次的证据，不能用其中一项冒充另一项。

<a id="r10"></a>

## R10 · Linux 单实例锁

读取 util-linux v2.40 的 flock 官方手册源码：nonblock 在无法取得锁时失败，no-fork 让被执行命令继续持锁；文件描述符关闭释放锁，需要避免后代进程意外持续持有。

```text
https://github.com/util-linux/util-linux/blob/v2.40/sys-utils/flock.1.adoc
```

实际目标环境的 util-linux 版本、锁竞争、崩溃释放及启动包装在 M0 记录并验证；手册观察不等于运行测试通过。

<a id="r11"></a>

## R11 · SnowLuma：OneBot 服务实现之一

核对官方仓库 `SnowLuma/SnowLuma` 提交 `38fc636088b98aa35a969b2aabe240d57b04dbf0` 的 README。项目说明它把 QQ 会话转换为 OneBot v11 动作与事件，并提供 WebSocket 服务端/客户端、HTTP 等入口。

```text
https://github.com/SnowLuma/SnowLuma/blob/38fc636088b98aa35a969b2aabe240d57b04dbf0/README.md
```

这支持把 SnowLuma 纳入同一个 onebot-v11 插件的候选服务，不证明其全部行为与 NapCat 相同，也不构成两者成熟度或可靠性的排名。未在本项目安装、登录或运行兼容测试；实际服务版本与支持项在 T09 记录。

<a id="r12"></a>

## R12 · MCP Streamable HTTP

M1 补充核对日期：2026-10-19。读取 MCP 2025-11-25 的传输规范：Streamable HTTP 使用 MCP 端点，包含初始化与可选会话管理；本地部署应限制监听地址，验证 Origin 并认证连接。MCP 的传输流不提供 Imbrex 事件 ACK 或消费检查点。

```text
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
```

M1-02 锁定官方 @modelcontextprotocol/sdk 1.32.1；核对其 stateless Streamable HTTP 示例、Node 传输、初始化与协议版本处理源码，并用同版本 SDK Client 对实际监听端口验证。既有监听上的 /v1/mcp 直接复用内核授权、事件与调用服务，具体工具和结果见[MCP 记录](experiments/m1-mcp.md)。pi 的真实工具调用仍按 M1-03 验证，不能由 SDK 互通代替。

<a id="r13"></a>

## R13 · Agent Client Protocol

观察日期：2026-10-19。官方传输文档规定 stdio 的客户端启动子进程、按行交换 JSON-RPC，stderr 可以承载日志；Streamable HTTP 仍标为讨论草案。因此 M1 选 stdio，不假定存在通用远程 ACP URL。

会话与轮次文档规定 session/new 分配 sessionId、session/prompt 接收内容块数组、session/update 报告过程更新，正常最终响应使用 stopReason=end_turn。session/load、resume 及客户端文件/终端能力需按实际协商结果使用；一轮结束不证明外部工具产生了成功效果。

```text
https://agentclientprotocol.com/protocol/transports
https://agentclientprotocol.com/protocol/session-setup
https://agentclientprotocol.com/protocol/prompt-turn
```

M1-04 使用官方 @agentclientprotocol/sdk 1.9.0 的 ACP v1 stdio 接口，并用独立逐行 JSON Agent 核验协议、持久状态与生命周期。真实 pi-acp 握手、基础 pi RPC 和验证范围见[运行记录](experiments/m1-acp.md)；模型轮次仍待配置，未将草案或可选能力算作已实现。

<a id="r14"></a>

## R14 · pi 与 pi-acp

观察日期：2026-10-19。读取 pi-acp 的官方 README：它通过 ACP stdio 对接客户端并启动 pi --mode rpc，利用 pi 的会话文件和自身映射支持恢复。该 README 同时说明 ACP mcpServers 参数没有接通到 pi，且 pi 直接访问本地文件和执行命令，不通过 ACP 文件/终端委托。

读取 pi 官方 MCP 文档：原生支持 stdio 与 Streamable HTTP，用户级配置为 ~/.pi/agent/mcp.json，项目级为 .pi/mcp.json，项目配置受信任设置约束。M1 首接使用 pi 自己的 MCP 配置，记录有效连接与工具调用结果，不把 ACP 参数中出现一个服务器条目视作联通。

```text
https://github.com/svkozak/pi-acp/blob/main/README.md
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md
```

这些链接是当日读取的上游入口，尚未成为 Imbrex 的锁定运行依赖。M1-03/M1-04 必须固定实际版本、验证 MCP/ACP 接缝、权限请求和后代进程清理；不由此承诺任意 ACP Agent 可直接替换或已有运行兼容。
