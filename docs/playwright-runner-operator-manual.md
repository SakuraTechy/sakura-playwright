# Playwright Runner 人工操作手册

本文档面向人工验证和日常使用，说明当前已实现的 CueCast Playwright Runner 如何准备环境、启动 mock lab、执行单用例和批量用例、查看产物、导出脚本，以及如何切换到真实环境。

当前状态：本地 mock 可验证能力已推进到 `M5-O`。生产级落地仍需要真实后端、真实账号、真实中台、对象存储和生产 CI 配合。

## 适用范围

本手册适用于以下场景：

- 在本机验证 Runner 是否可正常执行。
- 人工复跑已实现的 mock case。
- 查看成功或失败产物。
- 验证批量执行、报告、导出 Playwright/pytest 脚本。
- 为真实环境接入准备命令和参数。

不包含以下内容：

- 真实业务账号登录态的生成和授权。
- 真实中台权限、任务队列、对象存储上传。
- 生产 GitHub Actions 实际运行结果。

## 环境要求

在仓库根目录 `D:\King\sakura-playwright` 执行命令。

必需环境：

- Windows PowerShell。
- Node.js `20+`。
- npm。
- Chromium 浏览器，由 Playwright 安装。

可选环境：

- Python，用于检查导出的 pytest 文件。
- GitHub Actions runner，用于后续真实 CI 验证。
- 真实后端 API 地址和 token，用于真实环境执行。

首次安装：

```powershell
npm --prefix playwright-runner install
npm --prefix playwright-runner exec playwright install chromium
```

基础检查：

```powershell
npm --prefix playwright-runner run check
node --check test-lab/mock-server.js
node --check test-lab/app.js
```

通过标准：命令正常结束，没有 `SyntaxError`。

## 启动本地 Mock Lab

启动服务：

```powershell
node test-lab/mock-server.js --port 4173
```

打开页面：

```text
http://127.0.0.1:4173/test-lab/
```

用例详情页格式：

```text
http://127.0.0.1:4173/testcases/278
```

如果 `4173` 端口被占用，可以换一个端口，例如 `4180`，但后续所有命令里的 `--api-base` 也要改成对应端口：

```powershell
node test-lab/mock-server.js --port 4180
```

```text
--api-base http://127.0.0.1:4180/api
```

## 测试数据

mock server 会按 case ID 生成固定测试数据。每次人工验证前建议先 reset，保证数据回到初始状态。

重置单个 case：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
```

批量重置成功集合：

```powershell
$ids = '278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296'
foreach ($id in $ids.Split(',')) {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4173/api/testcases/$id/reset" | Out-Null
}
```

测试用例清单：

| Case | 预期 | 覆盖能力 |
| --- | --- | --- |
| `278` | 通过 | 基础点击、输入、提交、文本断言 |
| `279` | 通过 | 表格上下文定位、弹窗收敛、自定义 select |
| `280` | 失败 | 歧义定位失败，预期 `LOCATOR_AMBIGUOUS` |
| `281` | 通过 | iframe、文件上传、下载断言、JSON/API 断言 |
| `282` | 通过 | 类 Monaco 输入、树文本定位、基础 popup 切换 |
| `283` | 通过 | 网络 mock、POST API JSON 断言 |
| `284` | 通过 | 请求 URL、method、body 断言 |
| `285` | 通过 | 延迟 mock、请求数量断言 |
| `286` | 通过 | 响应断言、abort 失败注入专项 |
| `287` | 通过 | 响应快照文件化 |
| `288` | 通过 | 响应基线对比 |
| `289` | 通过 | 类 HAR 网络回放 |
| `290` | 通过 | 多文件上传、高级下载 MIME/大小/SHA256 |
| `291` | 通过 | 显式切换页面、关闭 popup、fallback |
| `292` | 通过 | 双 popup 按标题/URL 切换和关闭 fallback |
| `293` | 通过 | 展开树、checkbox tree item 定位 |
| `294` | 通过 | Monaco 多行输入、`Control+S` 快捷键反馈 |
| `295` | 通过 | 隐藏上传代理、二进制下载校验 |
| `296` | 通过 | Runner smoke、Playwright/pytest 导出、storage state 参数化 |

相关 fixture：

| 路径 | 用途 |
| --- | --- |
| `test-lab/upload-fixtures/m5-upload.txt` | 基础上传 |
| `test-lab/upload-fixtures/m5-upload-extra.txt` | 多文件上传 |
| `test-lab/downloads/m5-sample.txt` | 基础下载 |
| `test-lab/downloads/m5-advanced.txt` | 高级下载校验 |
| `test-lab/downloads/m5o-binary.bin` | 二进制下载校验 |
| `test-lab/network-fixtures/m5k-replay.json` | 类 HAR 网络回放 |
| `test-lab/response-baselines/m5j-profile.json` | 响应基线对比 |
| `test-lab/storage-states/m5o-storage-state.json` | 导出脚本 storage state 验证 |

## 执行单个用例

命令格式：

```powershell
node playwright-runner/src/index.js --case-id <caseId> --api-base http://127.0.0.1:4173/api --headed false
```

示例：执行基础用例 `278`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
node playwright-runner/src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

成功输出示例：

```text
[runner] passed case=278 duration=<耗时>ms artifacts=<产物目录>
```

执行高级下载用例 `290`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/290/reset
node playwright-runner/src/index.js --case-id 290 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

执行多 popup 用例 `292`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/292/reset
node playwright-runner/src/index.js --case-id 292 --api-base http://127.0.0.1:4173/api --headed false
```

执行预期失败用例 `280`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
node playwright-runner/src/index.js --case-id 280 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

验收点：

- `278`、`279`、`281-296` 应输出 `passed`。
- `280` 应输出 `failed`，退出码非 `0`。
- `280` 的 `result.json` 中应看到 `error_code` 或错误详情为 `LOCATOR_AMBIGUOUS`。

## 批量执行

命令格式：

```powershell
node playwright-runner/src/batch.js --case-ids <ids> --api-base http://127.0.0.1:4173/api --workers <workerCount>
```

执行完整成功集合：

```powershell
$ids = '278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296'
foreach ($id in $ids.Split(',')) {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4173/api/testcases/$id/reset" | Out-Null
}
node playwright-runner/src/batch.js --case-ids $ids --api-base http://127.0.0.1:4173/api --workers 2
```

通过标准：

```text
[batch] passed total=18 passed=18 failed=0 artifacts=<batchDir>
```

执行失败行为验证：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
node playwright-runner/src/batch.js --case-ids 278,280 --api-base http://127.0.0.1:4173/api --workers 1
```

通过标准：

- 批量命令退出码非 `0`。
- `summary.json` 中 `280` 为 `failed`。
- `280` 的 run 目录中能看到失败截图、失败 HTML、result。

## 查看执行产物

单用例产物目录：

```text
playwright-runner-artifacts/runs/<caseId>-<timestamp>/
```

批量产物目录：

```text
playwright-runner-artifacts/batches/<batchId>/
```

常用文件：

| 文件 | 说明 |
| --- | --- |
| `result.json` | 单用例完整结果 |
| `report.html` | 单用例 HTML 报告 |
| `logs/console.json` | 浏览器 console 日志 |
| `screenshots/failure.png` | 失败截图 |
| `failure.html` | 失败时页面 HTML |
| `dom/failure-text.txt` | 失败时页面文本 |
| `trace.zip` | Playwright trace，开启并保留时生成 |
| `*.webm` | 失败视频，开启并保留时生成 |
| `summary.json` | 批量执行汇总 |

检查单用例结果：

```powershell
Get-Content -Raw playwright-runner-artifacts\runs\<caseId>-<timestamp>\result.json
```

重点字段：

| 字段 | 含义 |
| --- | --- |
| `status` | `passed` 或 `failed` |
| `success` | 布尔值 |
| `steps[].locator_source` | 实际定位来源，例如 `locator_meta.candidates[0]`、`table:...`、`overlay:...`、`tree:...` |
| `steps[].locator_type` | 定位类型 |
| `steps[].matched_count` | 命中元素数量 |
| `steps[].visible_count` | 可见元素数量 |
| `steps[].uploaded_files` | 上传文件路径 |
| `steps[].downloaded_file` | 下载文件保存路径 |
| `steps[].downloaded_sha256` | 下载文件 SHA256 |
| `steps[].request_count` | 请求数量断言结果 |
| `steps[].switched_page_url` | 页面切换目标 |
| `steps[].closed_page_url` | 被关闭页面 |

打开 HTML 报告：

```text
playwright-runner-artifacts/runs/<caseId>-<timestamp>/report.html
playwright-runner-artifacts/batches/<batchId>/report.html
```

## Mock 中台人工操作

启动 mock lab 后打开：

```text
http://127.0.0.1:4173/testcases/279
```

可人工操作：

1. 点击页面上的 `Runner 回放`。
2. 等待执行历史刷新。
3. 展开历史记录里的 `Runner report`。
4. 查看 `result.json`、`report.html`、`console.json` 等链接。

默认 Runner 使用无头浏览器执行。如果需要人工观察浏览器操作过程：

1. 打开右侧 `本地调试设置`。
2. 勾选 `Runner Headed`。
3. 设置 `Runner Slow Mo (ms)`，建议 `250` 到 `500`。
4. 设置 `Finish Delay (ms)`，建议 `5000` 到 `10000`。
5. 再点击页面顶部的 `Runner 回放`。

勾选后 mock 中台会把 `headed: true` 传给 `/api/runner/jobs`，后端启动 Runner 时会执行 `--headed true`。如果不设置慢速或结束停留，用例可能几秒内执行完并自动关闭浏览器，看起来会像“没有打开”。

### 配置执行窗口尺寸

在用例详情页顶部点击编辑按钮，打开 `编辑用例信息` 弹窗，可以配置 `执行窗口尺寸`：

| 选项 | 含义 |
| --- | --- |
| `默认最大化` | 有头执行时用 Chromium 最大化窗口启动；无头执行时使用默认 `1920 x 1080` viewport |
| `使用当前窗口尺寸` | 保存当前用例详情页的浏览器视口尺寸，Runner 后续按这个宽高执行 |
| `自定义尺寸` | 手动输入宽度和高度，最小建议 `320 x 320` |

保存后，Runner 会从 case 元数据中读取：

```text
window_size_mode
viewport_width
viewport_height
```

执行结果的 `result.json` 也会在 `raw` 中记录这些字段，便于排查：

```json
{
  "raw": {
    "window_size_mode": "custom",
    "viewport_width": 1366,
    "viewport_height": 768
  }
}
```

也可以用 API 创建 mock Runner job：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4173/api/runner/jobs `
  -ContentType 'application/json' `
  -Body '{"case_id":279,"api_base":"http://127.0.0.1:4173/api","headed":true,"slow_mo":300,"finish_delay":8000,"trace":"retain-on-failure","video":"retain-on-failure"}'
```

查询 job 状态：

```powershell
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:4173/api/runner/jobs/<jobId>
```

## 导出 Playwright 脚本

导出基础 spec：

```powershell
node playwright-runner/src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4173/api --output playwright-runner/tests/case-296-m5o-e2e.spec.js
node --check playwright-runner/tests/case-296-m5o-e2e.spec.js
npm --prefix playwright-runner exec playwright test case-296-m5o-e2e.spec.js --config playwright.config.js
```

导出带 storage state 的 spec：

```powershell
node playwright-runner/src/export-playwright.js `
  --case-id 296 `
  --api-base http://127.0.0.1:4173/api `
  --storage-state test-lab/storage-states/m5o-storage-state.json `
  --output playwright-runner/tests/case-296-m5o-storage.spec.js

node --check playwright-runner/tests/case-296-m5o-storage.spec.js
npm --prefix playwright-runner exec playwright test case-296-m5o-storage.spec.js --config playwright.config.js
```

导出文件支持以下环境变量覆盖：

```text
CUECAST_START_URL
CUECAST_API_BASE
CUECAST_STORAGE_STATE
```

注意：要用当前 `playwright.config.js` 直接运行导出的 spec，建议输出到 `playwright-runner/tests/`，因为配置中的 `testDir` 指向该目录。

## 导出 Pytest 脚本

导出 pytest 文件：

```powershell
node playwright-runner/src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
```

导出带 storage state 的 pytest 文件：

```powershell
node playwright-runner/src/export-pytest.js `
  --case-id 296 `
  --api-base http://127.0.0.1:4173/api `
  --storage-state test-lab/storage-states/m5o-storage-state.json `
  --output playwright-runner-artifacts/exports/test_case_296_m5o_storage.py

python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_storage.py
```

当前本地验证只要求导出文件可编译；pytest 端到端运行需要本机安装 pytest 和 Playwright pytest 运行环境。

## 常用 CLI 参数

单用例入口：

```powershell
node playwright-runner/src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--case-id` | 单用例 ID | 必填 |
| `--api-base` | API 地址 | `http://127.0.0.1:4173/api` |
| `--browser` | `chromium`、`firefox`、`webkit` | `chromium` |
| `--headed` | 是否显示浏览器 | `false` |
| `--slow-mo` | Playwright 动作慢放毫秒数，便于人工观察 | `0` |
| `--finish-delay` | 执行结束后关闭浏览器前停留毫秒数 | `0` |
| `--trace` | `on`、`off`、`retain-on-failure` | `off` |
| `--video` | `on`、`off`、`retain-on-failure` | `off` |
| `--timeout` | 单步超时毫秒 | `6000` |
| `--start-step` | 从第几个 step 开始 | `0` |
| `--artifact-dir` | 产物根目录 | `playwright-runner-artifacts` |

批量入口：

```powershell
node playwright-runner/src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 2
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--case-ids` | 逗号分隔 case ID | 可由 `CUECAST_CASE_IDS` 提供 |
| `--workers` | case 级并发数 | `1` |
| `--api-base` | API 地址 | `http://127.0.0.1:4173/api` |
| `--artifact-dir` | 产物根目录 | `playwright-runner-artifacts` |

常用环境变量：

```text
CUECAST_CASE_IDS       批量 case ID，例如 278,279
CUECAST_API_BASE       后端 API 地址
CUECAST_TOKEN          后端鉴权 token
CUECAST_STORAGE_STATE  导出脚本或真实环境使用的 storage state 文件
RUNNER_WORKERS         批量 worker 数
RUNNER_BROWSER         chromium | firefox | webkit
RUNNER_HEADED          true | false
RUNNER_TRACE           on | off | retain-on-failure
RUNNER_VIDEO           on | off | retain-on-failure
RUNNER_ARTIFACT_DIR    产物根目录
RUNNER_STEP_TIMEOUT_MS 单步超时
RUNNER_CASE_TIMEOUT_MS 单 case 超时
```

优先级：CLI 参数 > 环境变量 > 默认值。

## 真实环境接入方式

当后端和中台准备好后，mock 命令中的 `--api-base` 替换为真实 API 地址：

```powershell
node playwright-runner/src/index.js `
  --case-id <真实caseId> `
  --api-base https://<真实后端>/api `
  --token <真实token> `
  --headed false `
  --trace retain-on-failure `
  --video retain-on-failure
```

也可以用环境变量：

```powershell
$env:CUECAST_API_BASE = 'https://<真实后端>/api'
$env:CUECAST_TOKEN = '<真实token>'
$env:CUECAST_CASE_IDS = '1001,1002,1003'
$env:RUNNER_WORKERS = '2'
node playwright-runner/src/batch.js
```

真实环境需要确认：

- 后端接口能返回与 mock case 兼容的 test case / steps。
- 真实步骤中有稳定的 `target_selector`、`target_xpath` 或 `locator_meta`。
- 如果需要登录态，准备 Playwright `storageState` 文件。
- Runner 机器能访问业务系统地址。
- artifact 上传策略已确定。当前本地只生成文件路径，不负责上传对象存储。
- 中台能展示或链接 Runner 产物。

## CI 使用

GitHub Actions 模板位于：

```text
.github/workflows/cuecast-runner.yml
```

mock CI 默认适合跑通过集合，例如：

```text
278,279
```

`280` 是预期失败用例，不应放进每日成功回归集合；可以单独作为失败报告专项验证。

真实 CI 需要配置：

```text
CUECAST_API_BASE
CUECAST_TOKEN
```

如需登录态，还需要提供 storage state 文件或在 CI 中生成登录态。

## 故障排查

端口占用：

- 换一个端口启动 mock server。
- 同步修改所有命令里的 `--api-base`。

浏览器未安装：

```powershell
npm --prefix playwright-runner exec playwright install chromium
```

用例没有回到初始状态：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/<caseId>/reset
```

导出 Playwright spec 提示 `No tests found`：

- 将导出文件放到 `playwright-runner/tests/`。
- 使用 `npm --prefix playwright-runner exec playwright test <fileName> --config playwright.config.js`。

pytest 编译失败：

- 确认本机 Python 可用。
- 先运行 `python --version`。

没有 trace 或 video：

- 成功用例在 `retain-on-failure` 下不会保留 trace/video。
- 需要强制保留时使用 `--trace on --video on`。

定位失败：

- 查看 `result.json` 中的 `locator_source`、`locator_type`、`matched_count`、`visible_count`。
- 如果错误为 `LOCATOR_AMBIGUOUS`，说明多个可见元素无法收敛，需要补充更强的 `locator_meta.context` 或更精确 selector。

用例详情页显示成原生 HTML、图标巨大或样式混乱：

- 确认访问的是 `http://127.0.0.1:4173/testcases/<caseId>`。
- 强制刷新浏览器页面，Windows Chrome 可用 `Ctrl+F5`。
- 如果仍异常，确认 `http://127.0.0.1:4173/test-lab/styles.css` 和 `http://127.0.0.1:4173/test-lab/app.js` 能正常打开。

## 推荐人工验收顺序

1. 安装依赖和 Chromium。
2. 运行静态检查。
3. 启动 mock lab。
4. 打开 `http://127.0.0.1:4173/test-lab/` 确认页面可访问。
5. 执行单用例 `278`。
6. 执行失败用例 `280`，确认失败产物。
7. 执行完整成功集合 `278,279,281-296`。
8. 打开最新 batch 的 `report.html` 和 `summary.json`。
9. 导出并执行 case `296` 的 Playwright spec。
10. 导出并编译 case `296` 的 pytest 文件。
11. 打开 `http://127.0.0.1:4173/testcases/279`，人工点 `Runner 回放` 验证 mock 中台入口。
12. 根据真实环境清单替换 API、token、storage state，再做小规模真实 case 验证。

## 当前边界

当前本地 mock 阶段可以告一段落。已完成能力见：

- `docs/playwright-runner-stage-completion.md`
- `playwright-runner/README.md`

仍需真实环境配合的事项：

- 真实业务用例 70% 步骤通过率验证。
- 真实中台接入和权限控制。
- 真实账号、token、登录态管理。
- 对象存储 artifact URL。
- 生产 CI / 定时任务实跑。
- 真实复杂组件专项验证。
