# Chrome 扩展录制端与 Playwright Runner 回放端部署说明

本文档说明当前方案中两条链路的环境依赖、部署方式和部署注意事项：

- Chrome 扩展录制端：负责在用户浏览器中录制操作、采集定位信息和步骤。
- Playwright Runner 回放端：负责在 Node.js/Playwright 环境中自动执行用例、批量回归和生成报告产物。

两者建议独立部署、独立升级、独立排障。录制端解决“如何采集步骤”，Runner 端解决“如何稳定自动执行”。

## 总体架构

```text
用户 Chrome
  └─ cuecast/ Chrome 扩展
      ├─ 录制用户真实操作
      ├─ 采集 selector / xpath / locator_meta / 截图
      └─ 调用中台 API 保存用例步骤

中台 API
  ├─ 用例管理
  ├─ 步骤存储
  ├─ 执行结果接收
  └─ artifact 链接或对象存储集成

Runner 执行环境
  └─ playwright-runner/
      ├─ 拉取 case 和 steps
      ├─ 用 Playwright Chromium 自动回放
      ├─ 批量执行 / CI 执行
      └─ 生成 result.json / report.html / trace / video / screenshot
```

## 部署边界

| 模块 | 部署位置 | 主要用途 | 是否进入生产主链路 |
| --- | --- | --- | --- |
| `cuecast/` | 用户 Chrome 浏览器 | 录制、人工回放、采集步骤 | 是 |
| `playwright-runner/` | CI、测试服务器、Runner 机器 | 自动回放、批量执行、报告产物 | 是 |
| `test-lab/` | 开发机或测试环境 | mock API 和 mock 页面验证 | 否，生产只作参考 |
| `playwright-runner-artifacts/` | 本地磁盘、CI artifact、对象存储 | 执行结果和失败排查产物 | 是，需持久化或上传 |

## Chrome 扩展录制端

### 环境依赖

Chrome 扩展录制端依赖用户本机浏览器环境。

需要：

- Google Chrome 或兼容 Chromium 浏览器。
- 已加载 `cuecast/` 目录下的 Manifest V3 扩展。
- 可访问中台 API。
- 用户可访问目标业务系统。
- 用户具备目标业务系统登录态。
- 目标页面允许 content script 注入。

Chrome 扩展通常不依赖：

- Node.js。
- Playwright。
- CI runner。
- `playwright-runner-artifacts/`。

### 扩展权限

重点检查 `cuecast/manifest.json`：

- `tabs`
- `windows`
- `scripting`
- `storage`
- `activeTab`
- `debugger`
- 目标业务域名的 host 权限

`debugger` 权限用于 CDP 回放或高级能力。如果真实生产环境不允许该权限，需要提前确认哪些功能会降级。

### 本地或内网测试部署

1. 打开 Chrome。
2. 进入：

```text
chrome://extensions/
```

3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择仓库中的：

```text
cuecast/
```

6. 打开中台用例页面或 mock 页面，例如：

```text
http://127.0.0.1:4173/testcases/278
```

7. 确认页面右上角显示扩展桥接状态正常。

### 企业或生产部署

推荐方式：

- 通过企业 Chrome 策略分发扩展。
- 或通过内部扩展分发平台发布。
- 或通过 Chrome Web Store 私有发布。

生产部署时建议固定扩展 ID。扩展 ID 变化可能影响：

- Chrome storage 数据。
- 中台与扩展之间的消息通信。
- host 权限审批。
- 用户侧升级路径。

### API 配置

录制端需要把 API Base 指向真实中台，例如：

```text
https://your-domain.example.com/api
```

需要注意：

- 中台 API 必须支持 HTTPS。
- 扩展请求如果跨域，需要后端正确配置 CORS。
- token 不要硬编码在扩展代码中。
- 用户身份建议由中台页面登录态或显式 token 管理。

### 录制端注意事项

- 录制依赖用户当前 Chrome 登录态，建议录制前先人工登录目标系统。
- 不支持在 `chrome://`、`edge://`、`devtools://`、第三方扩展页面等受限页面录制。
- 扩展升级后，已打开的业务页面可能仍保留旧 content script，建议刷新业务页面。
- host 权限尽量按业务域名收敛，不建议生产环境长期使用过宽权限。
- 录制结果应保存 selector、xpath、`locator_meta`、截图和上下文信息，供 Runner 回放使用。

## Playwright Runner 回放端

### 环境依赖

Runner 端依赖 Node.js 和 Playwright 独立执行环境。

需要：

- Node.js `20+`。
- npm。
- Playwright Runner 依赖。
- Playwright Chromium。
- 可访问中台 API。
- 可访问目标页面。
- 可写 artifact 目录。

安装命令：

```powershell
npm --prefix playwright-runner install
npm --prefix playwright-runner exec playwright install chromium
```

基础检查：

```powershell
npm --prefix playwright-runner run check
```

### 本地部署

适合开发、人工验证、mock lab 调试。

启动 mock lab：

```powershell
node test-lab/mock-server.js --port 4173
```

执行单个用例：

```powershell
node playwright-runner/src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

执行批量用例：

```powershell
node playwright-runner/src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

### CI 部署

适合每日回归和批量验证。

推荐步骤：

1. checkout 仓库。
2. 安装 Node.js `20+`。
3. 安装 Runner 依赖。
4. 安装 Chromium。
5. 启动 mock lab 或连接测试环境 API。
6. 执行批量命令。
7. 上传 `playwright-runner-artifacts/`。

参考 workflow：

```text
.github/workflows/cuecast-runner.yml
```

CI 默认建议无头执行：

```powershell
node playwright-runner/src/batch.js --case-ids 278,279 --api-base <API_BASE> --workers 2
```

### 服务器部署

适合接入真实中台批量任务、定时任务或队列任务。

服务器需要：

- Node.js `20+`。
- npm。
- Playwright Chromium。
- 稳定网络访问目标业务系统和中台 API。
- 足够磁盘保存 artifact。
- 可选对象存储上传能力。

建议环境变量：

```text
CUECAST_API_BASE=https://your-domain.example.com/api
CUECAST_TOKEN=<runner-token>
RUNNER_ARTIFACT_DIR=/data/playwright-runner-artifacts
RUNNER_TRACE=retain-on-failure
RUNNER_VIDEO=retain-on-failure
RUNNER_WORKERS=2
```

单用例执行：

```powershell
node playwright-runner/src/index.js --case-id <caseId> --api-base <API_BASE> --headed false
```

批量执行：

```powershell
node playwright-runner/src/batch.js --case-ids 278,279,281 --api-base <API_BASE> --workers 2
```

### Runner artifact

默认输出目录：

```text
playwright-runner-artifacts/
```

单用例产物：

```text
playwright-runner-artifacts/runs/<caseId>-<timestamp>/
```

批量产物：

```text
playwright-runner-artifacts/batches/<batchId>/
```

常用文件：

| 文件 | 用途 |
| --- | --- |
| `result.json` | 单用例完整执行结果 |
| `report.html` | 单用例 HTML 报告 |
| `summary.json` | 批量执行汇总 |
| `screenshots/failure.png` | 失败截图 |
| `failure.html` | 失败时页面 HTML |
| `dom/failure-text.txt` | 失败时页面文本 |
| `trace.zip` | Playwright trace |
| `*.webm` | 视频 |
| `logs/console.json` | 浏览器 console 和页面错误日志 |

生产部署时要注意：

- artifact 目录要持久化。
- CI 中要上传为构建产物。
- 服务器中建议定期清理或转存对象存储。
- 失败排查依赖这些产物，不建议执行结束立即删除。

## 登录态和真实环境

录制端和 Runner 端的登录态来源不同。

| 场景 | 登录态来源 |
| --- | --- |
| Chrome 扩展录制 | 用户当前 Chrome 会话 |
| Runner 本地人工验证 | Runner 独立 Chromium context，通常需要测试环境可直接访问或用例包含登录步骤 |
| Runner CI | 推荐 storage state、专用测试账号或前置登录流程 |
| Runner 服务器 | 推荐服务端安全保存账号凭据或定期刷新 storage state |

生产建议：

- 不要依赖人工临时登录态做 CI。
- 不要把账号密码写入用例明文。
- 如果必须保存 token 或 cookie，放入安全凭据系统或受控 storage state。
- 真实业务环境应准备专用测试账号，避免影响真实用户数据。

## Headed 与 Headless 策略

推荐策略：

- CI 和服务器默认使用 `--headed false`。
- 人工观察才使用 `--headed true`。
- `--headed true` 不应作为自动化验收的强依赖。

原因：

- Windows 下，后台进程启动的 Playwright Chromium 不保证能自动切到前台。
- 项目已加入多种 best-effort 聚焦方式，但系统前台锁可能仍会拦截。
- 有头模式可用于观察执行过程，但稳定回归应依赖无头结果、报告和 artifact。

有头人工观察建议参数：

```powershell
node playwright-runner/src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed true --slow-mo 300 --finish-delay 15000
```

如果 Chromium 出现在任务栏但没有切到前台，需要人工点击任务栏中的 Runner Chromium 图标。

## 配置优先级

Runner 配置建议保持：

```text
CLI 参数 > 环境变量 > 默认值
```

当前 Runner 已支持统一 `.env` 文件配置。默认会读取：

```text
<仓库根目录>/.env
playwright-runner/.env
```

如果两个文件都存在，后读取的 `playwright-runner/.env` 会覆盖仓库根目录 `.env` 中的同名配置。系统环境变量仍会覆盖 `.env`，CLI 参数仍然最高优先级。

推荐做法：

```powershell
Copy-Item playwright-runner/.env.example playwright-runner/.env
```

然后编辑：

```text
playwright-runner/.env
```

示例：

```dotenv
CUECAST_API_BASE=https://your-domain.example.com/api
CUECAST_TOKEN=<runner-token>
CUECAST_CASE_IDS=278,279
RUNNER_ARTIFACT_DIR=/data/playwright-runner-artifacts
RUNNER_TRACE=retain-on-failure
RUNNER_VIDEO=retain-on-failure
RUNNER_WORKERS=2
RUNNER_HEADED=false
```

也可以指定自定义 env 文件：

```powershell
node playwright-runner/src/batch.js --env-file .\config\runner.prod.env
```

或通过环境变量指定：

```powershell
$env:CUECAST_ENV_FILE = ".\config\runner.prod.env"
node playwright-runner/src/batch.js
```

真实 `.env` 不应提交到 Git；仓库只提交 `playwright-runner/.env.example` 作为模板。

常用 CLI 参数：

| 参数 | 说明 |
| --- | --- |
| `--case-id` | 单用例 ID |
| `--case-ids` | 批量用例 ID 列表 |
| `--api-base` | 中台 API Base |
| `--headed` | 是否有头执行 |
| `--workers` | 批量并发 worker 数 |
| `--trace` | trace 策略 |
| `--video` | video 策略 |
| `--artifact-dir` | artifact 输出目录 |
| `--slow-mo` | 有头观察时动作慢放 |
| `--finish-delay` | 执行结束后延迟关闭浏览器 |

常用环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `CUECAST_API_BASE` | API Base |
| `CUECAST_TOKEN` | API token |
| `CUECAST_CASE_ID` | 单用例 ID |
| `CUECAST_CASE_IDS` | 批量用例 ID |
| `RUNNER_WORKERS` | 批量 worker 数 |
| `RUNNER_TRACE` | trace 策略 |
| `RUNNER_VIDEO` | video 策略 |
| `RUNNER_ARTIFACT_DIR` | artifact 目录 |
| `RUNNER_SLOW_MO_MS` | 慢放毫秒数 |
| `RUNNER_FINISH_DELAY_MS` | 结束延迟毫秒数 |

## 安全注意事项

- 不提交真实 token、账号密码、私有 API 地址。
- 不提交本地浏览器 profile。
- 不提交 `playwright-runner-artifacts/`。
- 扩展 host 权限尽量收敛到业务域名。
- Runner token 使用最小权限，只允许读取用例、提交结果和上传产物。
- artifact 中可能包含页面截图、HTML、接口响应和业务数据，上传对象存储时要设置访问控制。

## 推荐生产拓扑

```text
用户侧
  Chrome + cuecast 扩展
    -> 录制步骤
    -> 保存到中台 API

中台侧
  Test Case 管理
  Runner Job 管理
  Result 管理
  Artifact 索引

执行侧
  Runner 服务器或 CI
    -> 拉取待执行 case
    -> Playwright headless 执行
    -> 上传 result 和 artifact
    -> 回写中台状态
```

推荐把生产执行链路设计为：

1. 用户在 Chrome 扩展中录制。
2. 中台保存和维护 case。
3. Runner 服务器或 CI 定时/手动拉取 case。
4. Runner 无头执行。
5. 执行结果和 artifact 回写中台。
6. 中台页面展示报告和失败分析入口。

## 部署检查清单

Chrome 扩展录制端：

- [ ] 扩展已加载或企业分发成功。
- [ ] 扩展 ID 稳定。
- [ ] `manifest.json` host 权限覆盖目标业务域名。
- [ ] 中台 API Base 配置正确。
- [ ] 用户可访问目标系统并已登录。
- [ ] 页面扩展桥接状态正常。
- [ ] 录制后步骤能保存到中台。

Playwright Runner 回放端：

- [ ] Node.js 版本为 `20+`。
- [ ] `npm --prefix playwright-runner install` 已执行。
- [ ] `npm --prefix playwright-runner exec playwright install chromium` 已执行。
- [ ] `npm --prefix playwright-runner run check` 通过。
- [ ] Runner 可访问中台 API。
- [ ] Runner 可访问目标业务页面。
- [ ] artifact 目录可写且可持久化。
- [ ] CI/服务器默认使用 headless。
- [ ] 失败时能生成 `result.json`、`report.html` 和失败截图。

真实环境接入：

- [ ] 准备测试账号或 storage state。
- [ ] 准备 token/secrets 管理方案。
- [ ] 确认对象存储或 artifact 上传方案。
- [ ] 确认任务触发方式：手动、定时、队列或中台 job。
- [ ] 确认失败通知和排查入口。

## 结论

Chrome 扩展录制端应部署在用户浏览器中，依赖用户登录态和 Chrome 扩展能力；Playwright Runner 回放端应部署在 CI 或服务器中，依赖 Node.js、Playwright Chromium、中台 API 和 artifact 存储。

生产推荐路径是：

```text
Chrome 扩展负责录制，Playwright Runner 负责无头批量执行。
```

有头 Runner 只作为人工观察手段，不应作为生产自动化链路的稳定性前提。
