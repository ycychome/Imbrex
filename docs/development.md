# 本地开发与工程基线

统一开发基线 0.3。M0 已提供可运行宿主、事件/能力服务、HTTP 和演示插件；OneBot 与 Agent 接入在 M1 完成。验收范围见[M0 运行记录](experiments/m0-runtime.md)。

## 1. 工具链与依赖锁

开发与 CI 使用 Linux、Node **24.22.0** 及该官方发行版附带的 npm **11.19.1**。按根目录 `.node-version` 安装 Node 并将其可执行目录加入 PATH；不使用系统上其他版本的 Node/npm 代替。

| 项 | 锁定版本 | 当前用途 |
| --- | --- | --- |
| Node / npm | 24.22.0 / 11.19.1 | ESM、内置测试运行器和 SQLite 绑定 |
| TypeScript | 5.9.3 | 严格类型检查与 ESM 编译 |
| Cordis | 4.0.0-rc.11 | 插件生命周期探针，后续宿主装配 |
| Ajv | 8.20.0 | Draft 2020-12 校验探针 |
| ws | 8.22.0 | 帧接收限额探针，后续 OneBot 传输 |
| @types/node / @types/ws | 24.19.2 / 8.18.2 | 与当前依赖一起通过类型检查的声明 |

`package.json` 使用精确版本，`package-lock.json` 保存完整依赖树、下载地址与 integrity。`.npmrc` 启用 `save-exact` 和 `engine-strict`；安装时拒绝不符合 `engines` 的工具链。`private: true` 防止误发布，许可证与分发方式仍按 Q05 待定。

原候选 Ajv 8.17.1 命中 GHSA-2g4f-4pwh-qvx6；ws 8.18.3 命中 GHSA-58qx-3vcg-4xpx、GHSA-96hv-2xvq-fx4p。因此使用上述修复版本，本次 `npm audit` 为 0 项漏洞。依赖审计结果仅代表核验日期。官方公告见[技术依据](references.md#r8)。

## 2. 从干净检出开始

```sh
node --version  # v24.22.0
npm --version   # 11.19.1
npm ci
npm run check
```

| 命令 | 行为 |
| --- | --- |
| `npm run typecheck` | 严格检查项目和依赖声明，不输出文件 |
| `npm run build` | 清理 dist 后编译 src 与 test 到 dist |
| `npm test` | 重新构建，再由 Node 执行编译后的测试；单测试超时 10 秒 |
| `npm run check` | 类型检查、构建和测试 |
| `npm run clean` | 删除生成的 dist |
| `npm start -- --config examples/demo.json` | 经 Linux flock 启动演示宿主；先完成构建和环境变量配置 |

当前代码包含核心、SQLite worker、HTTP、Cordis 宿主、演示插件和 CLI，构建也编译 examples/plugins 中的模板。安装、编译、测试和运行不依赖 `.private/`。node_modules、dist、coverage 和默认运行数据 data 均被 Git 忽略。

GitHub Actions 在 PR 和 main 提交上执行 `npm ci` 与 `npm run check`，使用固定的 Node 文件、Ubuntu 24.04 和按提交 SHA 锁定的官方 Actions。

## 3. ESM 编译选择

Cordis 4.0.0-rc.11 发布包的 `.d.ts` 使用无扩展名的相对导入。实际使用 TypeScript 5.9.3 的 NodeNext 模式会出现 TS2834 和 Context 无法导出的错误。

当前采用 `module: ESNext`、`moduleResolution: Bundler`，保留 `strict`、`noUncheckedIndexedAccess` 和完整声明检查，不使用 `skipLibCheck` 或修改 node_modules。这里只使用 TypeScript 的解析模式，没有添加打包器；编译产物由 Node 直接运行。

项目相对导入必须显式写 `.js`，确保输出在 Node ESM 下可解析。Bundler 模式不会替我们强制这条约定，代码审查及实际运行须检查；Cordis 修复发布声明后可重新核验 NodeNext。

## 4. M0-01 前置探针记录

环境：Linux x86_64、上述锁定工具链。命令：`npm ci`、`npm run check`、`npm audit`。类型检查与编译通过，4 个测试通过，审计 0 项漏洞。每个测试对应一个明确的集成风险：

| 风险 | 独立预期与结果 |
| --- | --- |
| SQLite 默认 number 读取无法容纳 64 位位置 | 写入 9007199254740993n；关闭重开后默认读取拒绝，setReadBigInts 后精确返回原值；WAL/FULL 实际读回 |
| Schema 方言或选项错误导致输入被修改 | Ajv2020 接纳合法输入；拒绝数值代文本、缺字段和多余字段，原输入不变 |
| Cordis 卸载未等待清理导致监听残留 | 连续两轮加载/卸载，每轮仅一个监听器，卸载完成后为零且不再消费事件 |
| ws 接收超限帧仍向消费者交付 | loopback 随机端口发送 17 字节帧；16 字节限额的客户端报 WS_ERR_UNSUPPORTED_MESSAGE_LENGTH，不交付消息 |

Node 实际绑定的 SQLite 为 **3.53.4**，source id：

```text
2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc
```

以上是工程初始化时的前置结果。后续完整 M0 实现和风险验证见[运行验收](experiments/m0-runtime.md)，真实平台行为仍属 M1。

<a id="m0-run"></a>

## 5. 运行 M0 演示

在使用锁定 Node/npm 的终端中执行：

```sh
npm ci
npm run check
export IMBREX_DEMO_AGENT_TOKEN="$(node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'))")"
export IMBREX_OPERATOR_TOKEN="$(node --input-type=module -e "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'))")"
npm start -- --config examples/demo.json
```

环境变量由调用终端提供，程序不自动加载 .env。示例默认监听 127.0.0.1:8080，数据保存在仓库 data/；需要临时端口时将配置中的 http.port 设为 0。就绪 JSON 会输出实际 port、pid、store_id、SQLite 版本和有效 PRAGMA；日志不输出令牌或消息正文。

预期首次启动：fixture 发布 message-001、message-002；transform 生成两条带 parents 的派生事件；observer 独立保存读取位置；mock 注册 mock.echo。正常重启保持 store_id 与这四条事件，重复来源身份不会产生新事件。

使用同样配置了环境变量的终端调用：

```sh
curl -sS -H "Authorization: Bearer $IMBREX_DEMO_AGENT_TOKEN" http://127.0.0.1:8080/v1/info
curl -sS -H "Authorization: Bearer $IMBREX_DEMO_AGENT_TOKEN" http://127.0.0.1:8080/v1/capabilities
curl -sS -H "Authorization: Bearer $IMBREX_OPERATOR_TOKEN" http://127.0.0.1:8080/v1/plugins
```

从 info 取得 store_id 后，按[HTTP 契约](contracts.md)读取事件和调用 mock.echo。示例 Agent 凭据只有读取和工具权限；HTTP 发布者需另外配置 events:write 及明确 write_sources，不可在请求体伪造主体。

Ctrl-C 或 SIGTERM 正常关闭；第二个进程使用同一数据目录会以 75 拒绝启动。进程崩溃后锁随实际宿主退出释放。不要直接运行内部 run.js 来跳过启动包装。

## 6. 添加插件

复制 [uppercase 模板](../examples/plugins/uppercase.ts)，使用绑定 API，实现实际需要的配置和资源清理。运行 npm run build 后，在配置中增加独立实例、主体和模块路径，例如从 examples/demo.json 引用 ../dist/examples/plugins/uppercase.js；同时为调用方授权该实例的完整能力 ID。初次启动按配置顺序装配，服务提供者须在依赖它的插件之前。

M0 的 observer 只完成独立读取与位置保存；M2 的事件副本、M1 的 OneBot/MCP/ACP Consumer 和事件订阅 SSE 均不在当前演示范围内。下一阶段从 [M1 的协议连接器与模拟验证](development-plan.md#m1)开始，Agent 复用 pi/pi-acp。
