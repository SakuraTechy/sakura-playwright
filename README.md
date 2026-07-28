# Sakura Playwright

这是 Sakura 自动化体系的独立 Playwright 项目，用于消费后端保存的 test case 和 steps，并提供 Playwright 回放、批量执行、报告和脚本导出能力。

按照 `docs/playwright-runner-hybrid-implementation.md` 的分阶段方案，Runner 作为独立执行通道推进，不替换现有 Chrome 扩展内的录制和 CDP 回放逻辑。每个阶段完成后，需要同步更新 `docs/playwright-runner-stage-completion.md`，记录计划项、完成情况、验证命令、验证结果、产物路径和遗留问题，方便与方案对比验收。

人工操作、环境准备、测试数据和验收流程请优先看 `docs/playwright-runner-operator-manual.md`。

## 项目结构

```text
sakura-playwright/
├─ src/
│  ├─ index.js                 # 单用例 CLI 入口
│  ├─ batch.js                 # 批量执行 CLI 入口
│  ├─ export-playwright.js     # Playwright 脚本导出入口
│  ├─ export-pytest.js         # pytest 脚本导出入口
│  ├─ api/                     # 后端 API 客户端
│  ├─ runner/                  # 用例规范化、定位和步骤执行
│  ├─ reporting/               # 结果组装、报告和执行产物
│  └─ shared/                  # CLI、环境变量和通用工具
├─ tests/                      # Playwright 导出端到端用例
├─ tools/focus-extension/      # 有头回放窗口聚焦辅助扩展
├─ docs/                       # 方案、操作手册和阶段记录
├─ package.json
└─ playwright.config.js
```

四个 `src/*.js` 文件是稳定的外部入口；业务实现进入对应分类目录，调用方不直接依赖内部模块路径。

## 安装

在仓库根目录执行：

```bash
npm install
npm exec -- playwright install chromium
```

## admin 平台单用例回放

admin 已提供 Playwright Runner 任务入口。进入 UI 自动化场景编辑页，选择一个用例，点击“Playwright Runner 回放”。admin 会在自身所在节点异步启动本目录的 `src/index.js`，页面轮询任务状态，Runner 完成后通过结果接口写入执行历史和步骤统计。

### admin 配置

在 admin 的环境变量中配置：

```text
SAKURA_PLAYWRIGHT_RUNNER_ENABLED=true
SAKURA_PLAYWRIGHT_RUNNER_ROOT=D:\\King\\sakura\\sakura-playwright
SAKURA_PLAYWRIGHT_NODE_COMMAND=node
SAKURA_PLAYWRIGHT_RUNNER_MAX_CONCURRENT=2
```

admin 仅负责定位并启动 Runner、限制并发、注入当前登录用户的短期 Bearer Token。服务地址、产物目录等节点参数配置在 `.env`；浏览器、无头模式、实时画面质量、HTTPS 证书策略、超时和 trace/video 策略由平台任务白名单参数覆盖。admin 服务节点需要满足 Node.js、Runner 依赖和 Playwright 浏览器已安装。

### 启动检查与故障定位

修改 admin 后端或前端代码后必须重启 admin 后端并重新发布前端；旧进程访问 `/api/automation/playwright/runner/jobs` 返回 `404`，说明 Runner Controller 尚未加载，不是 Playwright 用例动作失败。

执行期间可在 admin 执行历史中打开“日志”和“实时画面”：日志按任务轮询增量刷新，实时画面每秒读取受鉴权的最新 JPEG；任务结束后日志回退到 `execution-log.json` artifact，最后一帧仅在 Job 内存中短暂保留且不会写入场景 JSON。任务结束行的 `artifacts=` 是本次实际产物目录。

admin 单用例产物按 `runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/` 分层保存，例如 `artifacts/runs/AAS_P/V6.5B06D011/AAS_P_SMOKE_006/SCENE_CASE_001/20260717/20260717180409/`。末级目录与执行历史中的用例执行 ID 完全一致；未传 `--run-id` 的旧 CLI 仍使用 `yyyyMMdd/HHmmss`。各层目录都会过滤 Windows 非法文件名字符。

CDP/Runner 的执行开始、结束、诊断和快照时间统一使用北京时间 `yyyy-MM-dd HH:mm:ss`；admin 任务状态及写入场景 `debugRecord/playwrightResult` 的时间采用相同格式。历史 ISO 时间仍可读取并在展示、再次入库时转换；admin Runner 目录使用 `yyyyMMdd/executionId`。

Runner 访问 admin 用例时使用 `/testcases/{sceneId}/{caseId}` 双路径形式，避免 `sceneId:caseId` 的冒号经过网关编码后无法匹配 Spring 路由。

### 内部 HTTPS 自签名证书

在 `.env` 配置 `RUNNER_IGNORE_HTTPS_ERRORS=true` 后，Runner 可访问使用自签名证书的内部测试站点。该选项只跳过浏览器证书校验，不改变请求地址和登录逻辑；生产公网环境应修复证书链并将该值设为 `false`。

独立命令行回放如确有内部测试需要，可显式使用：

```bash
node src/index.js --case-id <caseId> --api-base <apiBase> --ignore-https-errors true
```

当前 admin 的 Spring API 没有 `/api` context-path，前端的 `/api` 只是开发代理前缀。如果 Runner 与 admin 不在同一节点，必须在 Runner `.env` 中把 `CUECAST_API_BASE` 设置为 Runner 节点可访问的 admin 后端地址，不能使用错误的 `127.0.0.1`。

### 执行边界

- Runner 启动独立 Playwright 浏览器，不复用当前 Chrome 扩展窗口或登录态。
- 任务按单个业务 `sceneId:caseId` 执行，结果写入该场景最近一次 `debugRecord`。
- 页面关闭或点击“取消”会终止 Runner 子进程；已经上传的结果仍按已上传内容保留。
- 原有“执行/执行全部”继续走 Jenkins，不会被 Runner 入口替换。

## 静态检查

```bash
npm run check
node --check ../sakura-cuecast/test-lab/mock-server.js
```

通过标准：命令执行成功，没有 `SyntaxError`。

## 单用例执行

先启动 mock lab：

```bash
node ../sakura-cuecast/test-lab/mock-server.js --port 4173
```

重置并执行基础 mock case：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
node src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

成功时会输出：

```text
[runner] passed case=278 duration=<耗时>ms artifacts=<产物目录>
```

产物默认生成在：

```text
playwright-runner-artifacts/runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/
```

重点查看：

```text
result.json
report.html
logs/console.json
screenshots/failure.png
failure.html
```

成功用例的 `result.json` 应包含 `status: "passed"`、`success: true`、每个 step 的 `status: "passed"`。交互步骤会记录 `locator_source`、`locator_type`、`matched_count`、`visible_count`，用于定位来源分析。

失败用例应至少生成 `result.json`、失败截图和失败 HTML 快照；启用 `--trace retain-on-failure --video retain-on-failure` 时还会保留 trace/video。

## M2 Mock 验证

M2 新增两个本地 mock case：

- `279`：预期通过，覆盖表格上下文定位、弹窗/浮层收敛、Ant 风格自定义 select 输入。
- `280`：预期失败，覆盖多个可见同名元素无法收敛时返回 `LOCATOR_AMBIGUOUS`，并生成失败产物。

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/279/reset
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
```

```bash
node src/index.js --case-id 279 --api-base http://127.0.0.1:4173/api --headed false
node src/index.js --case-id 280 --api-base http://127.0.0.1:4173/api --headed false
```

验收标准：

- `279` 输出 `passed`，退出码为 `0`。
- `280` 输出 `failed`，退出码非 `0`。
- `280` 的 `result.json` 中能看到 `error_code: "LOCATOR_AMBIGUOUS"`。

## M3 报告和 Mock 中台验证

M3 增加本地报告和 mock 中台 Runner 回放能力：

- 每次 Runner 执行都会生成 `report.html`、浏览器控制台事件 `logs/console.json` 和平台执行日志 `logs/execution-log.json`。
- 失败用例在 `--trace retain-on-failure --video retain-on-failure` 下会保留 `trace.zip`、`.webm`、`failure.png`、`failure.html` 和 DOM 文本快照。
- test-lab 页面提供 `Runner 回放` 按钮，通过 mock API 创建异步 Runner job。
- 执行历史可展开 `Runner report`，查看失败步骤、定位来源和 artifact 链接。

CLI 验证失败报告：

```bash
node src/index.js --case-id 280 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

mock 中台异步 Runner job：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/runner/jobs -ContentType 'application/json' -Body '{"case_id":279,"api_base":"http://127.0.0.1:4173/api","trace":"retain-on-failure","video":"retain-on-failure"}'
```

随后打开：

```text
http://127.0.0.1:4173/testcases/279
```

在执行历史中展开 `Runner report`，应能看到 report、result、console 等链接；失败用例还应看到 screenshot、trace、video 链接。

## M4 批量执行

M4 新增批量入口：

```bash
node src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

也可以通过 npm script 执行：

```bash
npm run run:batch -- --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

批量执行规则：

- `--case-ids` 支持逗号分隔的多个 case，例如 `278,279,280`。
- `--workers` 默认 `1`，表示串行执行；大于 `1` 时按 case 级别有限并发。
- `--session-mode isolated` 为默认隔离模式；`--session-mode reuse-auth` 会把上一条成功用例的 Cookie、localStorage、IndexedDB 和最终页面同源 sessionStorage 快照提供给下一条用例。
- `reuse-auth` 会记录上一条成功用例的最终同源业务页；下一条录制起点仍是 `/login`、`/login1`、`/signin` 等登录路由时，优先恢复该业务页，避免加载状态后又被固定起点覆盖回登录页面。
- `reuse-auth` 必须带批次标识且强制 `--workers 1`；失败或取消用例不覆盖上一份成功状态，批次退出时删除临时状态目录。
- `--storage-state`/`RUNNER_STORAGE_STATE`/`CUECAST_STORAGE_STATE` 可作为单用例只读初始状态；批次候选输出路径只应由平台后端传入。
- 每个 case 仍复用单用例 Runner 流程；admin 批次会独立生成 `playwright-runner-artifacts/runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/`。
- 批量汇总生成在 `playwright-runner-artifacts/batches/<batchId>/`。
- 批量产物包含 `summary.json` 和 `report.html`。
- 全部通过时退出码为 `0`；任意失败时退出码非 `0`。

Runner 会把脱敏结构化日志写入 `logs/<yyyyMMdd>/<jobId-or-runId-or-caseId>-<pid>.log`，服务端状态提交和清理写入同日期的 `session-audit.log`。日志只包含认证存储条目数量、sessionStorage 预加载数量、目标域匹配和导航/提交决策，不包含 Cookie、Token、存储键名/值、状态文件内容或路径。可用 `RUNNER_LOG_DIR` 或 `--log-dir` 修改目录。

本地成功批量验证：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/279/reset
node src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

本地失败批量验证：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
node src/batch.js --case-ids 278,280 --api-base http://127.0.0.1:4173/api --workers 1
```

并发验证：

```bash
node src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 2
```

Mock 批量 job API：

```powershell
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/runner/batches -ContentType 'application/json' -Body '{"case_ids":"278,279","api_base":"http://127.0.0.1:4173/api","workers":2}'
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:4173/api/runner/batches/$($job.data.id)"
```

## M4 CI 模板

已提供 GitHub Actions 模板：

```text
.github/workflows/cuecast-runner.yml
```

模板支持：

- `workflow_dispatch` 手动触发，默认执行 `278,279`。
- `schedule` 定时触发。
- checkout、setup-node、安装依赖、安装 Chromium。
- 启动 mock lab。
- 重置 mock case。
- 执行批量回归。
- 上传 `playwright-runner-artifacts`。

Mock CI 默认不需要 secrets。接真实环境时通常需要：

```text
CUECAST_API_BASE
CUECAST_TOKEN
```

## M5-A 高级能力 Mock 验证

M5 是持续迭代阶段。本轮先实现并验证一批可独立落地的高级能力：

- `iframe` 定位上下文：通过 `locator_meta.context.frame.selector` 在 iframe 内定位。
- `file_upload`：对文件输入框执行上传。
- `assert_download`：点击元素触发下载，校验文件名和下载内容，并保存到 run 产物目录。
- `assert_json`：支持页面 JSON 文本子集断言，以及 API JSON 子集断言。

新增 mock case：

- `281`：预期通过，覆盖 iframe、文件上传、下载断言、页面 JSON 断言和 API JSON 断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/281/reset
node src/index.js --case-id 281 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `281` 输出 `passed`。
- iframe 步骤的 `locator_source` 带有 `frame:` 前缀。
- `file_upload` 步骤记录 `uploaded_files`。
- `assert_download` 步骤记录 `downloaded_file` 和 `downloaded_filename`。
- API JSON 断言步骤记录 `locator_source: "api:assert_json"`。
- 批量回归 `278,279,281` 全部通过。

## M5-B 高级能力 Mock 验证

M5-B 继续补充三类高级能力：

- Monaco/类 Monaco 编辑器输入：对 `.monaco-editor` 或 `data-control-kind="monaco"` 控件执行清空并插入文本。
- 树组件语义定位：新增 `tree_item_text` 候选类型，可在树容器内按节点文本定位。
- 多窗口/新标签页基础切换：新增 `click_open_page`，点击后等待 popup，并把后续步骤切换到新页面执行。

新增 mock case：

- `282`：预期通过，覆盖 Monaco 输入、树节点语义点击、新窗口打开和新窗口内交互。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/282/reset
node src/index.js --case-id 282 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `282` 输出 `passed`。
- 树节点步骤的 `locator_source` 带有 `tree:` 前缀。
- `click_open_page` 步骤记录 `opened_page_url`。
- 新窗口打开后，后续 `assert_text` 和 `click` 在新页面内执行。
- 批量回归 `278,279,281,282` 全部通过。

## M5-C 网络 Mock 和脚本导出验证

M5-C 继续补充两类能力：

- `network_mock`：注册 Playwright route，对指定 URL/pattern 返回 mock 响应。
- `assert_json` API 模式增强：支持 `method`、`headers`、`body/json`。
- Playwright 脚本导出：新增 `src/export-playwright.js` 和 npm script `export:playwright`。

新增 mock case：

- `283`：预期通过，覆盖网络 mock、页面 fetch 渲染、POST API JSON 子集断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/283/reset
node src/index.js --case-id 283 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283 --api-base http://127.0.0.1:4173/api --workers 2
```

导出 Playwright 脚本：

```bash
node src/export-playwright.js --case-id 278 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-278.spec.js
node --check playwright-runner-artifacts/exports/case-278.spec.js
```

验收标准：

- case `283` 输出 `passed`。
- `network_mock` 步骤记录 `network_mock_url` 和 `network_mock_status`。
- API JSON 断言步骤记录 `locator_source: "api:assert_json"`。
- 批量回归 `278,279,281,282,283` 全部通过。
- 导出的 Playwright spec 通过 `node --check`。

## M5-D pytest 脚本导出验证

M5-D 新增 pytest 脚本导出：

- 新增 `src/export-pytest.js`。
- 新增 npm script `export:pytest`。
- 输出 pytest + Playwright sync API 风格脚本。
- 基础动作支持 `navigate/click/double_click/right_click/input/key/hover/assert_text/file_upload/click_open_page`。
- 复杂动作和复杂 `locator_meta` 暂以 TODO 注释保留。

导出 pytest 脚本：

```bash
node src/export-pytest.js --case-id 278 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_278.py
python -m py_compile playwright-runner-artifacts/exports/test_case_278.py
```

验收标准：

- 导出命令退出码为 `0`。
- 生成 `.py` 文件。
- 生成文件通过 `python -m py_compile`。

## M5-E 复杂定位导出验证

M5-E 增强 Playwright/pytest 导出的 locator 表达能力：

- 支持 `locator_meta.context.frame` 导出为 frame locator。
- 支持 `tree_item_text` 导出为树容器内节点文本定位。
- 支持 `table_cell_css` / `table_cell_xpath` 导出为表格 cell 内定位。
- 支持 `text_exact` / `text_exact_tag` / CSS / XPath candidate 导出。

验证复杂用例导出：

```bash
node src/export-playwright.js --case-id 279 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-279.spec.js
node src/export-playwright.js --case-id 281 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-281.spec.js
node src/export-playwright.js --case-id 282 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-282.spec.js
node --check playwright-runner-artifacts/exports/case-279.spec.js
node --check playwright-runner-artifacts/exports/case-281.spec.js
node --check playwright-runner-artifacts/exports/case-282.spec.js
```

```bash
node src/export-pytest.js --case-id 279 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_279.py
node src/export-pytest.js --case-id 281 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_281.py
node src/export-pytest.js --case-id 282 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_282.py
python -m py_compile playwright-runner-artifacts/exports/test_case_279.py
python -m py_compile playwright-runner-artifacts/exports/test_case_281.py
python -m py_compile playwright-runner-artifacts/exports/test_case_282.py
```

## M5-F 请求断言验证

M5-F 新增请求侧断言能力：

- 新增 `assert_request` action。
- 支持等待匹配 URL/pattern 的请求。
- 支持校验 `method`、请求体片段 `postDataContains` 和 headers。
- 如果 step 提供目标元素，Runner 会在点击目标元素的同时等待请求。

新增 mock case：

- `284`：预期通过，覆盖点击按钮触发 POST 请求，并断言 URL、method 和 body。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/284/reset
node src/index.js --case-id 284 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `284` 输出 `passed`。
- `assert_request` 步骤记录 `request_url` 和 `request_method`。
- 批量回归 `278,279,281,282,283,284` 全部通过。

## M5-G 网络延迟和请求数量验证

M5-G 继续增强网络能力：

- `network_mock` 支持 `delayMs`，可模拟延迟响应。
- `network_mock` 支持 `abort` 参数，作为失败注入基础能力。
- 新增 `assert_request_count` action，用于断言匹配请求的数量。

新增 mock case：

- `285`：预期通过，覆盖延迟 mock 响应和两次 POST 请求数量断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/285/reset
node src/index.js --case-id 285 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284,285 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `285` 输出 `passed`。
- 延迟 mock 步骤记录 `network_mock_url` 和 `network_mock_status`。
- 请求数量断言步骤记录 `request_count: 2`。
- 批量回归 `278,279,281,282,283,284,285` 全部通过。

## M5-H 响应断言和失败注入验证

M5-H 继续补强网络专项能力：

- 新增 `assert_response` action，可在点击目标元素的同时等待响应。
- 支持按 URL/pattern、method、status 匹配响应。
- 支持响应 body 文本片段断言和 JSON 子集断言。
- `network_mock` 的 `abort` 参数已有专项 mock case 验证，步骤结果会记录 `network_mock_abort`。

新增 mock case：

- `286`：预期通过，覆盖响应 JSON 断言和 abort 失败注入后的页面处理分支。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/286/reset
node src/index.js --case-id 286 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284,285,286 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `286` 输出 `passed`。
- 响应断言步骤记录 `response_url` 和 `response_status: 200`。
- 失败注入步骤记录 `network_mock_abort: "failed"`。
- 页面失败处理状态断言为 `Abort handled`。
- 批量回归 `278,279,281,282,283,284,285,286` 全部通过。

## M5-I 响应快照验证

M5-I 继续增强 `assert_response`：

- 支持 `snapshot: true` 保存响应 body。
- 支持 `snapshotName` 指定稳定快照文件名。
- 响应 body 保存到 `responses/<snapshotName>.json|txt`。
- 响应 metadata 保存到 `responses/<snapshotName>.meta.json`。
- 步骤结果记录 `response_snapshot`、`response_snapshot_meta` 和 `response_body_bytes`。

新增 mock case：

- `287`：预期通过，覆盖响应 JSON 子集断言、响应快照文件化和页面渲染断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/287/reset
node src/index.js --case-id 287 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `287` 输出 `passed`。
- `result.json` 中记录 `response_snapshot` 和 `response_snapshot_meta`。
- 产物目录中存在 `responses/m5i-profile.json` 和 `responses/m5i-profile.meta.json`。
- 批量回归 `278,279,281,282,283,284,285,286,287` 全部通过。

## M5-J 响应基线对比验证

M5-J 继续增强 `assert_response`：

- 支持 `baselinePath` 指定响应基线文件。
- 支持 `baselineMode`，当前可用 `exact`、`subset`、`text`。
- `exact` 会对 JSON 进行稳定排序后精确对比。
- 成功步骤记录 `response_baseline`、`response_baseline_mode` 和 `response_baseline_matched`。

新增 mock case：

- `288`：预期通过，覆盖响应 JSON 基线对比、响应快照文件化和页面渲染断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/288/reset
node src/index.js --case-id 288 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `288` 输出 `passed`。
- `result.json` 中记录 `response_baseline_matched: true`。
- `result.json` 中记录 `response_baseline_mode: "exact"`。
- 产物目录中存在 `responses/m5j-profile.json` 和 `responses/m5j-profile.meta.json`。
- 批量回归 `278,279,281,282,283,284,285,286,287,288` 全部通过。

## M5-K 类 HAR 网络回放验证

M5-K 新增 `network_replay`：

- 支持从 JSON fixture 读取多条回放 entry。
- entry 支持 URL/pattern、method、status、headers、json/body、delayMs 和 abort。
- 成功步骤记录 `network_replay_path` 和 `network_replay_entries`。

新增 mock case：

- `289`：预期通过，覆盖两条接口回放、页面渲染断言和请求数量断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/289/reset
node src/index.js --case-id 289 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `289` 输出 `passed`。
- `result.json` 中记录 `network_replay_entries: 2`。
- `result.json` 中记录 `request_count: 2`。
- 批量回归 `278,279,281,282,283,284,285,286,287,288,289` 全部通过。

## M5-L 高级上传下载验证

M5-L 收口文件上传和下载断言的增强场景：

- `file_upload` 支持通过 JSON `files` 数组一次上传多个文件。
- `assert_download` 支持校验文件名、内容片段、MIME、最小大小和 SHA256。
- 成功步骤记录 `uploaded_files`、`downloaded_mime`、`downloaded_bytes` 和 `downloaded_sha256`。

新增 mock case：

- `290`：预期通过，覆盖多文件上传和高级下载断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/290/reset
node src/index.js --case-id 290 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `290` 输出 `passed`。
- `result.json` 中 `uploaded_files` 包含两个文件。
- `result.json` 中记录 `downloaded_filename: "m5-advanced.txt"`。
- `result.json` 中记录 `downloaded_mime: "text/plain"`。
- `result.json` 中记录 `downloaded_bytes >= 80`。
- `result.json` 中记录匹配的 `downloaded_sha256`。
- 批量回归 `278,279,281,282,283,284,285,286,287,288,289,290` 全部通过。

## M5-M 高级动作导出验证

M5-M 补齐 Runner 高级动作的 Playwright/pytest 导出能力：

- Playwright 导出支持 `assert_download`、`assert_json`、`assert_request`、`assert_response`、`assert_request_count`、`network_mock` 和 `network_replay`。
- pytest 导出支持同一批高级动作，并生成内联 helper。
- `network_replay` 导出时会解析 fixture，将回放 entry 内联到导出脚本中。
- 导出脚本会记录请求事件，用于 `assert_request_count`。

验证高级动作导出：

```powershell
$caseIds = @(281,283,284,285,286,287,288,289,290)
foreach ($caseId in $caseIds) {
  node src/export-playwright.js --case-id $caseId --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-$caseId-m5m.spec.js
  node --check playwright-runner-artifacts/exports/case-$caseId-m5m.spec.js
  node src/export-pytest.js --case-id $caseId --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_${caseId}_m5m.py
  python -m py_compile playwright-runner-artifacts/exports/test_case_${caseId}_m5m.py
}
```

验收标准：

- case `281`、`283` 至 `290` 的 Playwright 导出文件通过 `node --check`。
- case `281`、`283` 至 `290` 的 pytest 导出文件通过 `python -m py_compile`。
- 导出文件中不再为上述高级动作生成 TODO。

## M5-N 多窗口增强验证

M5-N 补齐多窗口显式切换和关闭能力：

- `switch_page` 支持按 `target`、`index`、URL 片段和标题片段切换到已打开页面。
- `close_page` 支持关闭当前页面或匹配页面，并回退到主页面或仍打开页面。
- step 结果会记录 `switched_page_url`、`switched_page_title`、`closed_page_url` 和 `active_page_url` 等字段。
- Playwright/pytest 导出同步支持 `switch_page` 和 `close_page`。
- mock case `291` 覆盖打开 popup、切回主页面、按 URL 切回 popup、关闭 popup 后回主页面。

验证多窗口增强：

```powershell
node src/index.js --case-id 291 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
node src/export-playwright.js --case-id 291 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-291-m5n.spec.js
node --check playwright-runner-artifacts/exports/case-291-m5n.spec.js
node src/export-pytest.js --case-id 291 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_291_m5n.py
python -m py_compile playwright-runner-artifacts/exports/test_case_291_m5n.py
node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291 --api-base http://127.0.0.1:4173/api --workers 2
```

验收标准：

- case `291` 单用例通过，且 result 中能看到页面切换和关闭后的调试字段。
- case `291` 的 Playwright 导出文件通过 `node --check`。
- case `291` 的 pytest 导出文件通过 `python -m py_compile`。
- 批量回归 `278,279,281,282,283,284,285,286,287,288,289,290,291` 全部通过。

## M5-O 五类专项增强验证

M5-O 继续完成可本地验证的 5 类专项：

- 多窗口专项：case `292` 覆盖打开 Alpha/Beta 两个 popup，并按标题、URL 切换和关闭 fallback。
- 树组件专项：case `293` 覆盖展开树后按 `tree_item_text` 点击 checkbox tree item。
- Monaco 专项：case `294` 覆盖多行输入和 `Control+S` 快捷键反馈。
- 上传下载专项：case `295` 覆盖隐藏 `input[type=file]` 代理上传，以及 `.bin` 下载的 MIME、大小和 SHA256 校验。
- 导出脚本专项：case `296` 覆盖 Runner 单跑、Playwright 导出 spec 端到端执行、pytest 导出编译、storage state 和环境参数化。

验证新增专项：

```powershell
node src/batch.js --case-ids 292,293,294,295,296 --api-base http://127.0.0.1:4173/api --workers 1
node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296 --api-base http://127.0.0.1:4173/api --workers 2
```

验证导出端到端：

```powershell
New-Item -ItemType Directory -Force tests | Out-Null
node src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4173/api --output tests/case-296-m5o-e2e.spec.js
node --check tests/case-296-m5o-e2e.spec.js
npm exec -- playwright test case-296-m5o-e2e.spec.js --config playwright.config.js
node src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
```

验证 storage state 和环境参数化：

```powershell
node src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4173/api --storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json --output tests/case-296-m5o-storage.spec.js
node --check tests/case-296-m5o-storage.spec.js
npm exec -- playwright test case-296-m5o-storage.spec.js --config playwright.config.js
node src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4173/api --storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json --output playwright-runner-artifacts/exports/test_case_296_m5o_storage.py
python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_storage.py
```

验收标准：

- case `292-296` 全部 passed。
- 完整成功集合 `278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296` 全部 passed。
- 导出的 Playwright spec 可被当前项目依赖 `playwright/test` 加载并端到端执行。
- 导出的 pytest smoke 文件可通过 `python -m py_compile`。
- 导出文件包含 `CUECAST_START_URL`、`CUECAST_API_BASE`、`CUECAST_STORAGE_STATE` 参数入口。

## 录制定位语义对齐

Runner 提供两种定位模式：

- `legacy`：保持历史 CLI 和 Jenkins 默认行为，只使用既有 Playwright 定位链路。
- `semantic-v1`：按 CueCast 录制语义消费完整 `locator_meta.candidates` 和 `locator_meta.context`，轮询候选、按上下文评分收敛，并把隐藏 checkbox/radio、SVG、combobox 等原生节点规范化为可交互代理元素。admin 创建的 Runner Job 会显式使用该模式。

`semantic-v1` 只有在最高候选达到高置信阈值且与第二名有足够分差时才自动选择；否则返回 `LOCATOR_AMBIGUOUS`，不静默点击第一个元素。定位失败进一步区分 `LOCATOR_NOT_FOUND`、`LOCATOR_HIDDEN`、`LOCATOR_DISABLED`、`LOCATOR_COVERED` 和 `LOCATOR_LOOKUP_ERROR`。每一步的 `details.locator_diagnostics` 会记录候选尝试、DOM/可见匹配数、评分、归一化规则、等待时间和最近资源失败。

页面错误检测支持三态策略：任务不传值时继承用例的 `page_error_check_enabled`；任务显式传 `true` 或 `false` 时覆盖用例。加载态暂停逻辑超时计时，但保留 180 秒墙钟上限，避免页面永久 loading 导致任务不结束。

本地语义回归 case `297` 覆盖隐藏原生 checkbox 到可见组件代理的转换：

```powershell
node src/index.js --case-id 297 --api-base http://127.0.0.1:4173/api --headed false --locator-mode semantic-v1 --trace off --video off
```

## 环境变量

CLI 参数优先级高于环境变量，环境变量优先级高于默认值。

```text
CUECAST_CASE_IDS       批量 case ID，例如 278,279
CUECAST_API_BASE       后端 API 地址
CUECAST_TOKEN          后端鉴权 token
RUNNER_WORKERS         批量 worker 数，默认 1
RUNNER_SESSION_MODE    isolated | reuse-auth，默认 isolated
RUNNER_STORAGE_STATE   单用例或批次的只读初始 storage state 文件
RUNNER_BROWSER         chromium | firefox | webkit，默认 chromium
RUNNER_LOCATOR_MODE    legacy | semantic-v1，默认 legacy
RUNNER_PAGE_ERROR_CHECK_ENABLED 留空继承用例，true | false 为任务级覆盖
RUNNER_HEADED          true | false，默认 false
RUNNER_TRACE           on | off | retain-on-failure，批量默认 retain-on-failure
RUNNER_VIDEO           on | off | retain-on-failure，批量默认 retain-on-failure
RUNNER_ARTIFACT_DIR    产物根目录，默认 playwright-runner-artifacts
RUNNER_STEP_TIMEOUT_MS 单步超时
RUNNER_CASE_TIMEOUT_MS 单 case 超时
RUNNER_SLOW_MO_MS      有头模式人工观察时的动作慢放毫秒数
RUNNER_FINISH_DELAY_MS 执行结束后关闭浏览器前停留毫秒数
```

## admin 产物上传

当 `CUECAST_ADMIN_API=true` 时，单用例执行结束后会把以下本地产物逐项上传到 admin：

- `report`：HTML 执行报告。
- `console`：浏览器 console、pageerror 和 requestfailed 事件。
- `video`：按 `RUNNER_VIDEO` 保留策略生成的视频。
- `trace`：按 `RUNNER_TRACE` 保留策略生成的 Playwright trace。
- `screenshot`：失败截图。

上传使用当前 `CUECAST_TOKEN` 调用 `POST /automation/playwright/artifacts`。结果回传中的 `artifacts` 只保存 admin 返回的鉴权 URL，不包含 Runner 节点绝对路径。单个产物上传失败会记录在 `artifact_upload_errors` 中，但不会覆盖用例本身的通过或失败结果。

admin 默认允许单文件 200MB；视频超过限制时应缩短用例、改用 `retain-on-failure`，或按部署要求调整服务端上传限制。

## 常用单用例参数

```text
--case-id       用例 ID，必填
--api-base      后端 API 地址，默认 http://127.0.0.1:4173/api
--browser       chromium | firefox | webkit，默认 chromium
--locator-mode  legacy | semantic-v1，默认 legacy
--page-error-check-enabled 留空继承用例，true | false 为任务级覆盖
--headed        是否显示浏览器，默认 false
--slow-mo       Playwright 动作慢放毫秒数，默认 0
--finish-delay  执行结束后关闭浏览器前停留毫秒数，默认 0
--trace         on | off | retain-on-failure，默认 retain-on-failure
--video         on | off | retain-on-failure，默认 retain-on-failure
--timeout       单步超时时间，默认 6000 ms
--start-step    从第几个 step 开始执行，默认 0
--artifact-dir  产物根目录，默认 playwright-runner-artifacts
```

## 当前边界

M4 已提供可本地验证、可接入 CI 的批量执行基础能力。真实账号、真实后端密钥、对象存储上传、生产定时任务、真实中台权限控制仍属于后续真实集成项。

M5-A 已覆盖 iframe、文件上传、下载断言和 JSON/API 断言的基础场景。M5-B 已覆盖 Monaco/类 Monaco 输入、树组件文本语义定位、多窗口/新标签页基础切换。M5-C 已覆盖基础网络 mock、POST API JSON 断言和 Playwright 脚本导出。M5-D 已覆盖 pytest 脚本基础导出。M5-E 已增强 table/frame/tree/text 等复杂定位导出。M5-F 已覆盖基础请求断言。M5-G 已覆盖延迟 mock 和请求数量断言。M5-H 已覆盖响应断言和 abort 失败注入专项验证。M5-I 已覆盖响应内容快照文件化。M5-J 已覆盖响应基线对比。M5-K 已覆盖类 HAR 网络回放。M5-L 已覆盖多文件上传和高级下载校验的基础能力。M5-M 已覆盖高级动作的 Playwright/pytest 导出。M5-N 已覆盖多窗口显式切换、关闭和对应导出。M5-O 已覆盖双 popup 选择、展开/复选树、多行 Monaco 快捷键、隐藏上传代理、二进制下载校验、storage state、环境参数化和 Playwright 导出端到端 smoke。真实业务组件验证、跨 browser context 和更大范围导出脚本等价性仍保留到后续专项阶段。
