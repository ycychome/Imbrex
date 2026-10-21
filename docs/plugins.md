# 插件开发契约与演示模板

统一开发基线 0.3；2026-10-20 增补 M2 目标契约。现有业务绑定 API 的类型见 src/host/plugin-api.ts，尚未独立发布 SDK 包。共享 HTTP 与协议插件已采用下文接口；管理注册与操作按第 11 节的 M2 契约实现。

## 1. 插件是什么

插件通过配置中的实例 ID、module、principal_id、enabled、required 和 config 装配。一个模块可配置多个实例，分别拥有身份、数据目录和注册资源。无需继承 Imbrex 基类，也不强制创建数据库。

配置实例 ID 在重启后保持；数据目录为 data/plugins/<instance_id>，不以 Cordis 临时运行编号命名。插件更换账号等不兼容身份时创建新实例，不把旧调用记录解释成新账号的动作。

Cordis 的 apply、inject、Context 与 effect 负责依赖和作用域。本方案不再创建另一套插件状态机来替代它；host 仅将 Cordis 状态和插件外部可用性映射到诊断。

## 2. 绑定的业务 API

宿主注册 imbrex 服务，并保存已装配插件上下文与配置实例/主体的对应关系。插件通过 `ctx.imbrex.forPlugin(ctx)` 获取绑定客户端；未登记的上下文拒绝绑定，子作用域继承同一实例身份。caller 和实例 ID 不来自插件传入的任意字符串。

| API | 本方案签名/行为 |
| --- | --- |
| `api.storeId` | 当前绑定存储的只读 string |
| `api.instanceId` / `api.dataDir` | 宿主分配的实例与私有目录 |
| `api.signal` | 停止时触发的 AbortSignal；不等于远端撤销 |
| `api.whenReady()` | 等待宿主启动完成；Agent 同时通过 mcp 服务依赖保证监听与协议路由已就绪，依赖卸载使其停止新投递 |
| `api.events.info()` | 返回 storeId 与 latestSeq: bigint |
| `api.events.append({event, parents?})` | 使用绑定主体与 storeId，返回接纳回执；seq 为 bigint |
| `api.events.read({afterSeq, limit?, sourcePrefix?, type?})` | 返回 records、throughSeq、nextAfterSeq、caughtUp |
| `api.events.lookup({source,id})` | 按读取授权返回当前记录 |
| `api.events.onAvailable(callback)` | 注册短小的唤醒函数，返回幂等注销函数；不交付业务正文 |
| `api.capabilities.register(definition)` | 绑定所属实例，生成完整能力 ID，返回幂等注销函数 |
| `api.capabilities.invoke(id, params, {callId?})` | 使用绑定主体；遵循能力契约中的只读/外部写规则 |
| `api.capabilities.getCall(callId)` | 查询本主体有权查看的记录 |
| `api.setAvailable(boolean, reason?)` | 更新该插件对外服务可用性，不伪造业务成功 |
| `api.events.readScope()` | 需要 events:read；返回绑定主体的 principalId 与 sources 副本，用于将本地进度绑定到实际读取范围；不返回凭据 |

所有公开对象使用 JSON 值与基本领域类型，只有内部位置使用 bigint。API 不暴露网关 SQL、全局 token、其他应用状态或任意主体 impersonation。需要恢复的插件启动后先核对自己保存的 store_id，再继续调用绑定客户端。

reason 可携带匹配 /^[a-z][a-z0-9_]{0,63}$/ 的常量 code，作为 setAvailable 的 last_error.code；其余对象回落为公共错误码。last_error.message 始终使用宿主固定文案，不输出远端响应、Token 或任意异常正文。插件不可在 code 中拼接私有数据。

依赖 MCP 的后台消费循环先等待 api.whenReady() 再投递输入。不要在插件 apply 的初始化返回前等待此方法，否则会阻塞宿主完成启动；Consumer 将等待放在受生命周期管理的后台任务中。停止或启动失败时等待者被唤醒并拒绝继续调用。

## 3. 一个最小只读工具插件

以下形式已由内置 mock 插件编译并运行；另有可直接复制的 [uppercase 模板](../examples/plugins/uppercase.ts)，通过实际配置加载及 HTTP 调用验证：

```typescript
import type { Context } from 'cordis';

export const name = 'demo-echo';
export const inject = ['imbrex'];

export function apply(ctx: Context) {
  const api = ctx.imbrex.forPlugin(ctx);

  ctx.effect(() => api.capabilities.register<{ text: string }, { text: string }>({
    localName: 'echo',
    description: '返回输入文本，用于检查工具调用链路。',
    schemaVersion: '1',
    isSideEffectful: false,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 2000 } },
      required: ['text'],
      additionalProperties: false
    },
    handler: async ({ text }) => ({ text })
  }));
}
```

配置实例 ID 为 mock 时，此工具的完整 ID 是 mock.echo。配置 principal_id 决定插件调用其他服务时的主体；工具被调用时，handler 的 caller 仍是实际调用方。泛型只提供开发时类型，运行时仍按 inputSchema 校验。

定义字段在 SDK 使用 camelCase，在 HTTP 描述中转换为 snake_case；两者指向同一注册定义，不维护两份业务 schema。插件不得直接返回函数、bigint 或其他非 JSON 结果。

## 4. 外部写 handler

外部写注册使用 isSideEffectful=true。handler 除参数外可获得受信 invocation 上下文：callerId、callId、storeId、停止信号、受限日志及 `readEvent({source,id})`。readEvent 使用实际调用者的读取权限和本次 storeId，而不是连接器自身的较大权限；因此回复工具可以核验调用者有权读取其引用的输入。上下文不能接受任意 caller 覆盖，也不能绕过网关自动重复发送同一请求。

handler 返回可分类结果：

- `succeeded` 与合法 JSON result：实际操作协议已返回确定成功。
- `failed` 与 reason：有足够证据表明本次明确失败，不能用普通 throw 代替所有判定。
- `unknown` 与 reason：可能发生效果，结果不明。

具体结果形状为 `{status: 'succeeded', result}` 或 `{status: 'failed' | 'unknown', reason: {code, message}}`。这三个类别是 handler 报告给内核的结果，最终调用状态还要持久保存。内核未能保存结果时不得向调用者返回“已记录成功”。普通异常默认按副作用不确定处理。

能力可用性来自插件的外部连接状态；断线时 setAvailable(false)，恢复后只接受新的获授权调用，不能扫描 unknown 自动补发。

## 5. 消费事件的插件

参考插件采用一个读取循环，不在通知回调内跑模型或网络重业务。启动时补读，周期补查，通知只触发唤醒。忙时合并提示，不重入。

插件保存自己的输入范围、store_id 和位置；涉及外部动作或非确定结果时，按实际恢复策略先保存必要责任状态。M1 的 acp-consumer 在提交 prompt 前保存未决输入，结果不确定时暂停；模型决定和历史交给现成 Agent。读取出来不等于处理完成，候选 nextAfterSeq 不能在业务责任尚未成立时整体提交，规则见[应用消费](applications.md)。

fixture-transform 是受控特例：只处理 fixture 的已知短 ID，按确定规则生成稳定派生身份和内容。重启后重试同一输出不会新增事件；不把这个样例宣称为任意应用通用的恰好一次变换器。

## 6. 资源登记与停止

注册、监听、定时器和连接的清理通过 ctx.effect 或等价 Cordis 作用域登记。使用外部库创建的 socket/Promise 循环不会自动成为可取消资源；插件必须响应 api.signal，并返回有意义的清理函数。

停止顺序通常为：不再接收/启动新工作 → 等待已有本地提交 → 结束或明确记录在途调用 → 注销能力和监听 → 关闭连接与自己的数据库。需要顺序的动作放入一个有序清理过程，不依赖一组并行 disposer 的注册顺序。

required 指插件模块与初始化必须成功，不保证外部平台一直在线。初始化若等待网络必须有界；运行时断开通过 available=false 表达。不能把 ACTIVE 等同为账号在线或数据完整。

host.startPlugin/stopPlugin 当前是受信内部控制入口，供生命周期测试和本地集成使用。M2 管理操作通过专属权限及宿主协调调用所需生命周期入口；不得把宿主对象直接暴露给远端或普通 Agent。停止未完成则报告失败，禁止同实例重复启动后台循环。

初次装配按配置顺序进行，提供被依赖服务的插件应排在消费者前；缺少服务时初始化失败。模块支持命名导出的 apply 或默认 apply 函数/对象，可带 Config（Cordis Standard Schema）与字符串数组 inject。内置三个演示插件的 config 为空对象。加载/停止期间的重复管理操作拒绝；生命周期等待默认上限 15 秒。运行中依赖卸载使用 Cordis 原生作用域，宿主同步撤销旧绑定与能力，依赖恢复后重新建立绑定。

## 7. 当前插件与 M2 目标清单

| 插件 | 输入与输出 | 验证价值 |
| --- | --- | --- |
| fixture | 有限可重复的 fixture.message.created 事件 | 无需账号验证事件发布与重复身份 |
| transform | 读取 fixture，发布稳定派生事件 | 验证应用可同时消费和生产 |
| mock | 注册 mock.echo；测试环境另配可控副作用提供者 | 验证发现、schema、授权与调用记录 |
| onebot-v11 | 通过标准 v11 接口接纳 QQ 事实与封装 reply | 验证不同服务实现可复用同一插件 |
| agent-chat | 读取入站事件，通过 ACP stdio 驱动现成 Agent | 保留会话、进度与未决语义，M2 增加管理描述和受控配置应用 |
| memory（Python 服务） | 复用 Graphiti 0.31.2 与 Neo4j 5.26 LTS 管理长期记忆 | 独立 FastAPI 服务；不属于 Cordis 插件。TS 插件只通过既有能力协议消费，不增加 MCP 入口 |
| server-http | 提供 ctx.http 共享监听与路由注册 | 路由随插件注销，统一请求预算和连接清理 |
| api-rest / adapter-mcp | 从 adapters 迁移现有 REST/MCP 入口 | 路径、授权和结果语义不变 |
| admin（M2） | 管理 API 与静态资产注册；前端源码在独立 `web/` 构建包，M2-02 消费宿主 AdminRegistry | Admin 晚启动、卸载和重启不影响业务实例 |

onebot-v11、agent-chat 与三个演示插件使用绑定业务 API。observer 已移除；旧实验记录保留原名称和当时的验证范围。所有业务入口继续按绑定身份使用核心；协议插件按实际远端主体执行授权，管理操作另受 admin 权限约束。不向演示插件开放绕过权限或事务的测试捷径。

`web/` 是管理前端的构建包，不是 Cordis 插件，不通过 `PluginApi` 注册或读取服务。admin 插件是唯一的管理运行时插件：它提供管理 API 与静态资产注册；AdminRegistry 在 M2-02 接入，届时由 admin 消费。admin 默认解析 `@imbrex/admin-web/dist` 后调用 server-http 静态挂载；`assets_dir` 仅作外部构建目录覆盖。

## 8. 插件开发完成条件

模板能编译并被配置加载；类型与 schema 一致；非法配置有明确错误；start/stop/start 不重复注册或泄漏循环；拥有实际运行命令和最小配置；所声明恢复行为有对应测试。新增插件应修改自己的代码与配置，正常情况下无需修改内核业务逻辑。

## 9. 协议插件的兼容边界

实现品牌不是插件角色。onebot-v11 的通信、事件映射和工具 schema 不依赖 NapCat 或 SnowLuma SDK；差异处理放入该插件内部的显式兼容适配，默认 generic，未知 profile 拒绝启用。不要为了兼容多种实现预先创建空的适配框架或多份连接器副本。

账号、身份命名空间与稳定实例 ID 属于持久绑定；切换实现不能把旧 native_message_id 或未决调用直接交给新服务，具体规则见 [OneBot 接入](onebot-and-agent.md)。

## 10. M2 共享 HTTP 服务与就绪

server-http 监听成功后向 Cordis 提供 ctx.http。协议插件声明 http 依赖，通过 ctx.http.scope(ctx) 取得 HttpScope：register(method, pattern, handler): () => void；static(prefix, rootDir): Promise<() => void>。注销同时绑定调用插件的生命周期，接口类型位于 src/plugins/server-http/server.ts。支持字面路径、:参数段及末尾 *资产路径；不含 * 的具体路由优先于通配路由，:参数段不接受空段；请求路径不做点段归一化，保留不透明 call_id。静态资源按文件大小与 mtime 生成弱 ETag，对匹配的 If-None-Match 返回 304。

Handler 收到 request/response、requestId、origin、params、query、queryText（原始查询串），以及 readBody()/send()/ensureActive()。readBody 按公共 JSON 限额读取且在返回前确认路由仍有效；鉴权由协议插件根据真实请求主体执行；api-rest 对未匹配的 /v1 路径先认证再返回 404，避免未认证请求枚举路由。宿主 protocol 服务只向内置协议实例提供请求侧接口，不加入普通 PluginApi。REST DTO 位于 src/plugins/api-rest/dto.ts，MCP 与其共享。

插件卸载后移除对应路由与静态映射，不留可执行旧回调。重复路由不能静默覆盖其他实例；统一处理请求体大小、JSON 边界、并发预算与连接关闭，协议业务鉴权不由通用路由器猜测。协议 DTO 可复用，但 REST 不静态调用 MCP 的处理入口。

adapter-mcp 登记 /v1/mcp 后才提供 mcp 服务，agent-chat 声明 mcp 依赖。ready 同时要求监听成功和所需路由完成注册。后台消费不得在 apply 中等待只有全体初始化结束才会完成的屏障；依赖未就绪或卸载时停止新投递，恢复就绪后才继续。HTTP 服务停用会影响其依赖入口，Admin 停用只撤销管理路由。已派发外部调用仍按核心规则保存结果，不能因路由关闭当作撤销。

## 11. M2 管理描述登记与动作

宿主维护轻量 AdminRegistry，绑定 API 新增 registerAdminPanel(descriptor)。身份来自 api.instanceId；描述不允许冒充其他实例。描述包含标题、图标、状态/指标/详情读取函数以及可选的带输入 schema 的动作，返回注销入口并随实例释放。

Admin 只读取注册表并提供认证后的页面/API；业务插件不依赖 Admin 服务存在，因此不采用一次性的 ctx.admin?.register 而错过晚启动，也不因 Admin 卸载而卸载业务。需要停止/重启目标实例的动作由宿主协调，不继续调用已经注销的实例闭包。

读取和动作结果使用有界 JSON，序号转为十进制字符串；未知指标明确标为未提供。动作先检查 admin:operate、输入 schema 和当前状态，界面确认提示不替代这些检查。管理动作不会自动注册为 Agent MCP 工具。权限与字段语义见 [Admin 契约](admin.md)。
