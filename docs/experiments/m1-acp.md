# M1-04 ACP Consumer 验证与运行

2026-10-19。实现 builtin:acp-consumer、官方 ACP SDK 1.9.0 的 v1 stdio 接入、持久消费状态和 Linux 进程清理。验证环境为 Node.js 24.22.0 / npm 11.19.1、tini 0.19.0、Linux、systemd 作为 PID 1。模型与真实 QQ 凭据仍缺，本文区分模拟 Agent、真实协议握手与尚未完成的模型轮次。

## 已验证范围

test/host/acp-consumer.test.ts 在真实 Host/SQLite/HTTP 上启动独立的逐行 JSON 模拟 Agent，使用不同于客户端 SDK 的字面量报文；不是内存中的方法替身。验证包括：

- 新实例保存当前 latest_seq，不触发已有历史；只消费可信来源中的入站原事件，跳过自发回流、旧输入、派生与其他类型。
- 模拟 Agent 收到 prompt 时读取实际状态文件，确认 in_flight 已保存；群聊与私聊使用不同 session，同一会话复用，重启后先成功 load。
- 不支持恢复、恢复失败、会话 ID 冲突、超过 32 个会话、范围/主体变更、损坏状态、错 store_id 和超前位置均暂停。
- prompt 超时、错误、进程退出、超限报文和非 end_turn 保留 in_flight；写入失败不提交新 prompt，完成检查点失败保留未决输入；重启不重放。
- 未支持的权限请求返回 cancelled，文件请求拒绝；合法的大型工具更新可通过，超限数据使输入保持未确认。
- OneBot 模拟服务 → 自动 ACP → MCP → reply Action 实际联通。成功、unknown 与回复后 Agent 崩溃三条路径均不自动补发；end_turn 与平台发送状态分别判断。
- 忽略 SIGTERM 的 Agent 及其后代被回收。公开 CLI 的实际宿主被 SIGKILL 后，监督进程继续清理；实例锁未传给后代，同一目录可以重启且原未决输入保持暂停。
- 独立审查后的回归：Agent 立即退出留下的 detached 后代由 tini 接管并回收；后续插件延迟初始化时首轮等待 MCP 监听；无效通知、报文和未知响应 ID 不进入 SDK 原始异常日志。

针对这些风险运行类型检查、构建和编译后的 ACP 集成测试。更新到包含 M1-03 的主线并修复独立审查问题后，npm run check 的类型检查、构建和90/90测试通过，其中 ACP 风险测试含子测试共30项。

另外实际启动公开 Imbrex CLI 与 OneBot 模拟器 CLI，使用 live-group 产生当前时间的新输入，经模拟 ACP Agent 和 MCP 得到一次 send_group_msg，call.status=succeeded、native_message_id=1001；退出时进程与连接正常清理。此证据仍是模拟 Agent 与模拟平台，不等于真实模型或 QQ 验收。

## 真实 pi 的准备验证

通过当前 AcpAgent 与监督进程启动 pi-acp 0.0.34，initialize 得到协议版本 1，正常关闭后退出与清理成功。单独运行隔离配置下的 pi 1.3.0 --mode rpc --no-themes，get_state、get_available_models 均成功，available_models=0；这证明所用基础 RPC 命令可用，同时确认本次环境没有可用模型。

没有实际执行 pi 的模型 prompt 或真实 QQ 发送。pi 的 MCP 配置与手动阶段见 [M1-03](m1-pi.md)。pi-acp 使用 pi 自己的 MCP 配置，ACP mcpServers 保持空数组。

## 启动配置

模板为 examples/agent/acp.json，默认禁止外部写。先确认 PATH 中有 tini 0.19.0，再按 M1-03 安装锁定的 pi/pi-acp，并设置同一个 IMBREX_QQ_AGENT_TOKEN、IMBREX_OPERATOR_TOKEN、PI_CODING_AGENT_DIR。在 PI_CODING_AGENT_DIR 对应的 pi 配置中完成模型配置与 Imbrex MCP 配置。

从仓库根目录生成本地配置与独立 Agent 工作目录：

    node --input-type=module <<'JS'
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { resolve } from 'node:path';
    const config = JSON.parse(await readFile('examples/agent/acp.json', 'utf8'));
    config.data_dir = resolve('data/acp');
    const consumer = config.plugins.find(plugin => plugin.id === 'agent');
    consumer.config.agent.cwd = resolve('data/agent-workspace');
    await mkdir(consumer.config.agent.cwd, { recursive: true });
    await writeFile('data/acp-config.json', JSON.stringify(config, null, 2), { mode: 0o600 });
    JS

终端一运行 node dist/examples/onebot/simulator.js。终端二运行 node dist/src/cli/start.js --config data/acp-config.json。先查询插件状态，确认 OneBot 连接与 ACP 握手成功；这不表示模型或发送已验证。模型缺失会在创建会话时使 Consumer 暂停，尚未提交 prompt 的输入仍可在配置修复并重启后继续处理。

只针对自己启动的模拟服务，将本地配置副本 external_writes_enabled 改为 true 并重启宿主。启动完成后在模拟器输入 live-group 或 live-private，以当前时间和单进程内递增的 ID 产生新输入；固定 group/private 夹具适合手动阶段和重复身份验证，可能因时间过旧被 Consumer 跳过。live ID 不提供跨模拟器重启的身份连续性，新实验使用明确的独立数据目录。

核对模拟器 actions、Agent 实际会话和对应主体的 calls 记录。记录 store_id、caller_id、实际 call_id 以及 Action；不能以 Agent end_turn、某条更新通知或界面显示可用替代发送证据。

## 暂停与恢复

本地状态位于 data_dir/plugins/<instance>/consumer-state.json，格式、绑定和故障规则见 [应用消费](../applications.md)。in_flight 非空时重启仍暂停，不启动 Agent 重投。诊断的 event_ref_hash 用于关联日志，完整引用只保存在受限的本地状态与已授权事件中。

人工处置前停止 Consumer/宿主，确认其 Agent 已退出，保留状态副本，用原 Agent 主体与真实 call_id 查询调用记录并核验平台证据。确认已处理或明确放弃后才可原子更新该输入的位置、清除 in_flight 并记录原因；恢复能力不足时显式选择新会话。unknown 不换 ID 自动补发。未经验证的真实服务、模型配置和人工恢复演示继续在 M1-05 记录。
