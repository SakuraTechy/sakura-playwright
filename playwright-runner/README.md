# CueCast Playwright Runner

这是 CueCast 的独立 Playwright Runner，用于消费后端保存的 test case 和 steps，并通过 Playwright 执行自动回放。

按照 `docs/playwright-runner-hybrid-implementation.md` 的分阶段方案，Runner 作为独立执行通道推进，不替换现有 Chrome 扩展内的录制和 CDP 回放逻辑。每个阶段完成后，需要同步更新 `docs/playwright-runner-stage-completion.md`，记录计划项、完成情况、验证命令、验证结果、产物路径和遗留问题，方便与方案对比验收。

人工操作、环境准备、测试数据和验收流程请优先看 `docs/playwright-runner-operator-manual.md`。

## 安装

在仓库根目录执行：

```bash
npm --prefix playwright-runner install
npm --prefix playwright-runner exec playwright install chromium
```

## 静态检查

```bash
npm --prefix playwright-runner run check
node --check test-lab/mock-server.js
```

通过标准：命令执行成功，没有 `SyntaxError`。

## 单用例执行

先启动 mock lab：

```bash
node test-lab/mock-server.js --port 4173
```

重置并执行基础 mock case：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
node playwright-runner/src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

成功时会输出：

```text
[runner] passed case=278 duration=<耗时>ms artifacts=<产物目录>
```

产物默认生成在：

```text
playwright-runner-artifacts/runs/<caseId>-<timestamp>/
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
node playwright-runner/src/index.js --case-id 279 --api-base http://127.0.0.1:4173/api --headed false
node playwright-runner/src/index.js --case-id 280 --api-base http://127.0.0.1:4173/api --headed false
```

验收标准：

- `279` 输出 `passed`，退出码为 `0`。
- `280` 输出 `failed`，退出码非 `0`。
- `280` 的 `result.json` 中能看到 `error_code: "LOCATOR_AMBIGUOUS"`。

## M3 报告和 Mock 中台验证

M3 增加本地报告和 mock 中台 Runner 回放能力：

- 每次 Runner 执行都会生成 `report.html` 和 `logs/console.json`。
- 失败用例在 `--trace retain-on-failure --video retain-on-failure` 下会保留 `trace.zip`、`.webm`、`failure.png`、`failure.html` 和 DOM 文本快照。
- test-lab 页面提供 `Runner 回放` 按钮，通过 mock API 创建异步 Runner job。
- 执行历史可展开 `Runner report`，查看失败步骤、定位来源和 artifact 链接。

CLI 验证失败报告：

```bash
node playwright-runner/src/index.js --case-id 280 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
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
node playwright-runner/src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

也可以通过 npm script 执行：

```bash
npm --prefix playwright-runner run run:batch -- --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

批量执行规则：

- `--case-ids` 支持逗号分隔的多个 case，例如 `278,279,280`。
- `--workers` 默认 `1`，表示串行执行；大于 `1` 时按 case 级别有限并发。
- 每个 case 仍复用单用例 Runner 流程，并独立生成 `playwright-runner-artifacts/runs/<caseId>-<timestamp>/`。
- 批量汇总生成在 `playwright-runner-artifacts/batches/<batchId>/`。
- 批量产物包含 `summary.json` 和 `report.html`。
- 全部通过时退出码为 `0`；任意失败时退出码非 `0`。

本地成功批量验证：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/279/reset
node playwright-runner/src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 1
```

本地失败批量验证：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
node playwright-runner/src/batch.js --case-ids 278,280 --api-base http://127.0.0.1:4173/api --workers 1
```

并发验证：

```bash
node playwright-runner/src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 281 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 282 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282 --api-base http://127.0.0.1:4173/api --workers 2
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
- Playwright 脚本导出：新增 `playwright-runner/src/export-playwright.js` 和 npm script `export:playwright`。

新增 mock case：

- `283`：预期通过，覆盖网络 mock、页面 fetch 渲染、POST API JSON 子集断言。

重置并执行：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/283/reset
node playwright-runner/src/index.js --case-id 283 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283 --api-base http://127.0.0.1:4173/api --workers 2
```

导出 Playwright 脚本：

```bash
node playwright-runner/src/export-playwright.js --case-id 278 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-278.spec.js
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

- 新增 `playwright-runner/src/export-pytest.js`。
- 新增 npm script `export:pytest`。
- 输出 pytest + Playwright sync API 风格脚本。
- 基础动作支持 `navigate/click/double_click/right_click/input/key/hover/assert_text/file_upload/click_open_page`。
- 复杂动作和复杂 `locator_meta` 暂以 TODO 注释保留。

导出 pytest 脚本：

```bash
node playwright-runner/src/export-pytest.js --case-id 278 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_278.py
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
node playwright-runner/src/export-playwright.js --case-id 279 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-279.spec.js
node playwright-runner/src/export-playwright.js --case-id 281 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-281.spec.js
node playwright-runner/src/export-playwright.js --case-id 282 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-282.spec.js
node --check playwright-runner-artifacts/exports/case-279.spec.js
node --check playwright-runner-artifacts/exports/case-281.spec.js
node --check playwright-runner-artifacts/exports/case-282.spec.js
```

```bash
node playwright-runner/src/export-pytest.js --case-id 279 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_279.py
node playwright-runner/src/export-pytest.js --case-id 281 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_281.py
node playwright-runner/src/export-pytest.js --case-id 282 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_282.py
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
node playwright-runner/src/index.js --case-id 284 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 285 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 286 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 287 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286,287 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 288 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 289 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/index.js --case-id 290 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

批量回归：

```bash
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290 --api-base http://127.0.0.1:4173/api --workers 2
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
  node playwright-runner/src/export-playwright.js --case-id $caseId --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-$caseId-m5m.spec.js
  node --check playwright-runner-artifacts/exports/case-$caseId-m5m.spec.js
  node playwright-runner/src/export-pytest.js --case-id $caseId --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_${caseId}_m5m.py
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
node playwright-runner/src/index.js --case-id 291 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
node playwright-runner/src/export-playwright.js --case-id 291 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/case-291-m5n.spec.js
node --check playwright-runner-artifacts/exports/case-291-m5n.spec.js
node playwright-runner/src/export-pytest.js --case-id 291 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_291_m5n.py
python -m py_compile playwright-runner-artifacts/exports/test_case_291_m5n.py
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291 --api-base http://127.0.0.1:4173/api --workers 2
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
node playwright-runner/src/batch.js --case-ids 292,293,294,295,296 --api-base http://127.0.0.1:4173/api --workers 1
node playwright-runner/src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296 --api-base http://127.0.0.1:4173/api --workers 2
```

验证导出端到端：

```powershell
New-Item -ItemType Directory -Force playwright-runner\tests | Out-Null
node playwright-runner/src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4173/api --output playwright-runner/tests/case-296-m5o-e2e.spec.js
node --check playwright-runner/tests/case-296-m5o-e2e.spec.js
npm --prefix playwright-runner exec playwright test case-296-m5o-e2e.spec.js --config playwright.config.js
node playwright-runner/src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
```

验证 storage state 和环境参数化：

```powershell
node playwright-runner/src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4173/api --storage-state test-lab/storage-states/m5o-storage-state.json --output playwright-runner/tests/case-296-m5o-storage.spec.js
node --check playwright-runner/tests/case-296-m5o-storage.spec.js
npm --prefix playwright-runner exec playwright test case-296-m5o-storage.spec.js --config playwright.config.js
node playwright-runner/src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4173/api --storage-state test-lab/storage-states/m5o-storage-state.json --output playwright-runner-artifacts/exports/test_case_296_m5o_storage.py
python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_storage.py
```

验收标准：

- case `292-296` 全部 passed。
- 完整成功集合 `278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296` 全部 passed。
- 导出的 Playwright spec 可被当前项目依赖 `playwright/test` 加载并端到端执行。
- 导出的 pytest smoke 文件可通过 `python -m py_compile`。
- 导出文件包含 `CUECAST_START_URL`、`CUECAST_API_BASE`、`CUECAST_STORAGE_STATE` 参数入口。

## 环境变量

CLI 参数优先级高于环境变量，环境变量优先级高于默认值。

```text
CUECAST_CASE_IDS       批量 case ID，例如 278,279
CUECAST_API_BASE       后端 API 地址
CUECAST_TOKEN          后端鉴权 token
RUNNER_WORKERS         批量 worker 数，默认 1
RUNNER_BROWSER         chromium | firefox | webkit，默认 chromium
RUNNER_HEADED          true | false，默认 false
RUNNER_TRACE           on | off | retain-on-failure，批量默认 retain-on-failure
RUNNER_VIDEO           on | off | retain-on-failure，批量默认 retain-on-failure
RUNNER_ARTIFACT_DIR    产物根目录，默认 playwright-runner-artifacts
RUNNER_STEP_TIMEOUT_MS 单步超时
RUNNER_CASE_TIMEOUT_MS 单 case 超时
RUNNER_SLOW_MO_MS      有头模式人工观察时的动作慢放毫秒数
RUNNER_FINISH_DELAY_MS 执行结束后关闭浏览器前停留毫秒数
```

## 常用单用例参数

```text
--case-id       用例 ID，必填
--api-base      后端 API 地址，默认 http://127.0.0.1:4173/api
--browser       chromium | firefox | webkit，默认 chromium
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
