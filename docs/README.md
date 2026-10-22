# Imbrex 开发文档

Imbrex 是基于 Cordis 的可扩展事件与能力网关。插件接入事实，内核保存可重读事件，独立应用按自己的节奏处理，需要产生动作时调用获授权的能力。

网关不绑定任何平台、Agent 或模型。v1 附带的 OneBot v11 连接器与 agent-chat 构成一条**参考闭环**，用来证明契约端到端可用；它们与任何第三方连接器或应用等价，可替换、可禁用、可删除。

本目录是唯一设计依据。全部文档按**变更频率**分四层，每层的修改规则不同：

| 层 | 目录 | 内容 | 修改规则 |
| --- | --- | --- | --- |
| **设计** | `design/` | 不变量、架构、外部契约、接入方式、决策记录 | 固化。改它必须新增一条[决策记录](design/decisions.md)，并在 PR 中单列 |
| **运维** | `ops/` | 安装、构建、配置、权限、启动关闭、恢复、技术依据 | 随部署环境与工具链变。改它不需要决策，但必须实测 |
| **进度** | `progress/` | 状态、阶段计划、验收用例、待决事项 | 随时变。[状态](progress/status.md)是唯一的状态来源 |
| **归档** | 本地私有，不入 Git | 历史运行记录、讨论逐字稿、个人运维材料 | 冻结，不改写 |

**状态的唯一来源是[项目状态](progress/status.md)。** 其他文档用现在时描述系统**是什么**，不写"已实现""待验证""当前"——后者必然腐坏。

---

## 索引

### 设计

| 文档 | 负责的内容 |
| --- | --- |
| [设计哲学与不变量](design/philosophy.md) | 长期成立的十条不变量，及违反它们的判定方式 |
| [架构设计](design/architecture.md) | 产品范围、组件、内核与宿主边界 |
| [HTTP 契约](design/contracts.md) | 请求/响应、字段、错误和统一限额 |
| [事件、存储与恢复](design/storage-and-recovery.md) | 事件身份、分页、SQLite 表与提交边界 |
| [能力调用](design/capabilities.md) | 注册、参数、授权、调用记录与 unknown |
| [插件开发](design/plugins.md) | Cordis 绑定、模板、生命周期及扩展入口 |
| [应用消费](design/applications.md) | 独立位置、ACP Consumer 未决输入与人工恢复 |
| [OneBot 与 Agent 接入](design/onebot-and-agent.md) | 参考闭环的协议层：OneBot v11 连接、实现差异、QQ 映射与回复链路 |
| [Agent 协议接入](design/agent-integration.md) | MCP 暴露与授权、ACP stdio、pi/pi-acp 接缝与生命周期 |
| [管理控制台](design/admin.md) | 管理 API、权限、面板登记、视图契约与静态挂载 |
| [决策记录](design/decisions.md) | 已采用选择、理由及代价 |

### 运维

| 文档 | 负责的内容 |
| --- | --- |
| [开发与工程基线](ops/development.md) | 安装、构建、运行、依赖版本与工具链 |
| [配置、权限与运维](ops/operations.md) | 配置来源、主体授权、启动关闭、诊断、备份恢复、首次接入 |
| [技术依据](ops/references.md) | 固定官方来源、协议和实现观察版本 |

### 进度

| 文档 | 负责的内容 |
| --- | --- |
| [项目状态](progress/status.md) | 里程碑完成情况、已知缺口、进行中工作 |
| [开发计划](progress/plan.md) | 各阶段的范围与退出条件 |
| [验证与验收](progress/validation.md) | T01—T09 用例、M2 退出检查、证据索引 |
| [待决事项](progress/open-questions.md) | 需要确认的信息类别与阻塞范围 |

---

## 阅读顺序

第一次接触：先读[设计哲学与不变量](design/philosophy.md)，再读[架构设计](design/architecture.md)，然后按需进入对应契约。

要动手开发：读[开发与工程基线](ops/development.md)与[插件开发](design/plugins.md)，对照[项目状态](progress/status.md)找当前任务。

事件与能力文档定义行为，HTTP 文档定义 REST 表达，Agent 接入文档定义 MCP/ACP 边界，插件文档定义进程内接入。发生矛盾应一起修复，不可从不同章节选择便利的解释。

`onebot-and-agent.md`、`applications.md` 与 `agent-integration.md` 描述的是参考闭环这条具体路径，不是网关的必要组成；读它们之前先读[设计哲学与不变量](design/philosophy.md)。

---

## 文档收录与脱敏

- **纳入 Git**：不变量与架构、外部接口契约、开发与运维手册、仍有效的决策、公开技术来源、阶段计划与验收用例、状态。
- **不纳入 Git**：历史运行记录、讨论逐字稿、重复或废弃方案、原始日志、真实消息、部署配置、账号与凭据。运行记录保存在本地私有归档，其覆盖范围登记在[证据索引](progress/validation.md#9-证据索引)。
- 待决事项只记录需要确认的信息类别与阻塞范围，不回填真实地址、账号、会话白名单或密钥。
- 公开材料使用一致的替代标识，避免通过事件引用还原真实身份。示例中的账号、会话、UUID、消息和端口均为虚构测试值；认证示例只引用环境变量名。
- 公开来源 URL 和固定版本可保留；个人路径、内网地址及带认证参数的 URL 不可提交。

正式文档不依赖本地私有资料，克隆仓库后即可独立阅读与开发。
