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

## admin 产品环境回放（2026-07-15）

admin 场景页的“扩展 CDP 回放”和“Playwright Runner 回放”共用新的单用例弹窗。弹窗要求先选择产品环境，并实时检查环境启用状态、执行节点在线状态和有效前端地址；任一条件不满足时不能开始回放。平台执行（Jenkins）的弹窗、请求 DTO 和执行链路未修改。

后端按以下顺序解析产品环境的目标 Origin：

1. 产品环境 `lastDomain`。
2. 服务器配置中的“前端域名”与“前端端口”。
3. 服务器 IP 与“前端端口”。

执行快照会将 `start_url/startUrl`、步骤的 `url/start_url/end_url` 和 `navigate.value` 中的绝对 HTTP(S) 地址替换为目标 Origin，同时保留原路径、查询参数和锚点。相对地址、`data:` 等非 HTTP(S) 地址保持不变。该转换只作用于接口响应副本，不会回写 admin 的 `caseList`、`playwright_step` 或 `locator_meta`。

CDP 弹窗可选择最大化、当前窗口或自定义窗口；自定义宽高范围为 `320–10000`。页面错误检测对应 `page_error_check_enabled`，“AI 深度分析”仅为预留说明。弹窗值优先于录制值，布尔值 `false` 和数值 `0` 也会作为有效覆盖值。

Runner 弹窗本次任务使用中文名称展示浏览器、显示浏览器窗口、忽略 HTTPS 证书错误、追踪文件保留策略、录屏保留策略、单步骤超时、用例总超时、操作慢放、执行结束停留和页面错误检测策略。页面错误检测为三态：`继承用例` 不传任务字段，`启用` 和 `禁用` 分别显式传 `true`、`false`。对应传输字段仍为 `browser`、`headed`、`ignoreHttpsErrors`、`trace`、`video`、`stepTimeoutMs`、`caseTimeoutMs`、`slowMoMs`、`finishDelayMs`、`pageErrorCheckEnabled`。admin 创建的 Runner Job 还会固定传入 `--locator-mode semantic-v1`，使录制的候选定位、上下文评分和可交互代理转换生效；手工 CLI 与 Jenkins 默认仍是 `legacy`。admin 仅把白名单字段转换为 CLI 参数，CLI 参数优先于 `.env`；`RUNNER_WORKERS`、artifact 目录、token 和 storage state 仍由服务端管理。总用例超时会关闭 context/browser，并按失败结果正常回传。`isolated` 和 `reuse-auth` 的有头 Chromium 保持真实窗口 viewport，仅固定原生视频输出尺寸；`reuse-browser` 使用共享 Context 的批次级原生录屏，批次结束按用例执行时间切片，不使用页面 screencast。运行环境必须可执行 `ffmpeg`。弹窗底部按 Jenkins 模板展示场景信息；当前单场景、单用例回放会使用详情页指定用例，场景入口则使用首个可执行用例。

CDP/Runner 执行链路中的开始时间、结束时间、诊断日志时间和响应快照时间统一为北京时间 `yyyy-MM-dd HH:mm:ss`。admin Runner 任务状态以及写入 `AutomationUiSceneDO.debugRecord` 的顶层和 `playwrightResult` 嵌套执行时间使用同一格式；后端会在入库前递归兼容并转换旧版客户端传入的 UTC ISO 时间。admin Runner 目录使用 `yyyyMMdd/executionId`，未传执行 ID 的手工命令仍使用 `yyyyMMdd/HHmmss`。

## 环境要求

在仓库根目录 `D:\King\sakura\sakura-playwright` 执行命令。

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
npm install
npm exec -- playwright install chromium
```

如果部署节点无法下载 Playwright 浏览器，可以在 Runner `.env` 中将 `RUNNER_BROWSER_EXECUTABLE_PATH` 设置为与 `RUNNER_BROWSER` 匹配的已安装浏览器绝对路径。Windows 系统 Chrome 可作为 `chromium` 的可执行文件；未配置时仍使用 Playwright 管理的浏览器。

基础检查：

```powershell
npm run check
node --check ../sakura-cuecast/test-lab/mock-server.js
node --check ../sakura-cuecast/test-lab/app.js
```

通过标准：命令正常结束，没有 `SyntaxError`。

## 启动本地 Mock Lab

启动服务：

```powershell
node ../sakura-cuecast/test-lab/mock-server.js --port 4173
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
node ../sakura-cuecast/test-lab/mock-server.js --port 4180
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
$ids = '278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297'
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
| `297` | 通过 | 录制语义定位、隐藏 checkbox 到可见组件代理转换 |

相关 fixture：

| 路径 | 用途 |
| --- | --- |
| `../sakura-cuecast/test-lab/upload-fixtures/m5-upload.txt` | 基础上传 |
| `../sakura-cuecast/test-lab/upload-fixtures/m5-upload-extra.txt` | 多文件上传 |
| `../sakura-cuecast/test-lab/downloads/m5-sample.txt` | 基础下载 |
| `../sakura-cuecast/test-lab/downloads/m5-advanced.txt` | 高级下载校验 |
| `../sakura-cuecast/test-lab/downloads/m5o-binary.bin` | 二进制下载校验 |
| `../sakura-cuecast/test-lab/network-fixtures/m5k-replay.json` | 类 HAR 网络回放 |
| `../sakura-cuecast/test-lab/response-baselines/m5j-profile.json` | 响应基线对比 |
| `../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json` | 导出脚本 storage state 验证 |

## 执行单个用例

命令格式：

```powershell
node src/index.js --case-id <caseId> --api-base http://127.0.0.1:4173/api --headed false
```

示例：执行基础用例 `278`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
node src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

成功输出示例：

```text
[runner] passed case=278 duration=<耗时>ms artifacts=<产物目录>
```

执行高级下载用例 `290`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/290/reset
node src/index.js --case-id 290 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

执行多 popup 用例 `292`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/292/reset
node src/index.js --case-id 292 --api-base http://127.0.0.1:4173/api --headed false
```

执行预期失败用例 `280`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
node src/index.js --case-id 280 --api-base http://127.0.0.1:4173/api --headed false --trace retain-on-failure --video retain-on-failure
```

验收点：

- `278`、`279`、`281-296` 应输出 `passed`。
- `280` 应输出 `failed`，退出码非 `0`。
- `280` 的 `result.json` 中应看到 `error_code` 或错误详情为 `LOCATOR_AMBIGUOUS`。

## 批量执行

命令格式：

```powershell
node src/batch.js --case-ids <ids> --api-base http://127.0.0.1:4173/api --workers <workerCount>
```

执行完整成功集合：

```powershell
$ids = '278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296'
foreach ($id in $ids.Split(',')) {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4173/api/testcases/$id/reset" | Out-Null
}
node src/batch.js --case-ids $ids --api-base http://127.0.0.1:4173/api --workers 2
```

通过标准：

```text
[batch] passed total=18 passed=18 failed=0 artifacts=<batchDir>
```

执行失败行为验证：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/278/reset
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/280/reset
node src/batch.js --case-ids 278,280 --api-base http://127.0.0.1:4173/api --workers 1
```

通过标准：

- 批量命令退出码非 `0`。
- `summary.json` 中 `280` 为 `failed`。
- `280` 的 run 目录中能看到失败截图、失败 HTML、result。

同一浏览器窗口串行执行：

```powershell
node src/batch.js --case-ids <ids> --api-base <apiBase> --workers 1 --session-mode reuse-browser --video retain-on-failure --headed true
```

`reuse-browser` 只在同一批次内复用 Browser、Context、标签页、sessionStorage 和页面内存。首条用例打开录制起点；后续用例若仍在同源非登录业务页，则直接从当前页面继续。跨域、当前处于登录页、用例失败、取消或批次结束时不会沿用该页面状态。录屏可选 `on`、`off` 或 `retain-on-failure`；共享宿主先录制一段原生 WebM，批次完成后使用 `ffmpeg` 按用例时间边界生成各用例视频。`retain-on-failure` 只保留失败用例切片；`on` 保留所有用例切片。

## 在 admin 添加下载校验步骤

在 UI 自动化场景详情中新增步骤，选择：

- 操作类型：`检查操作`
- 操作方法：`点击并校验浏览器下载文件`

填写项：

| 字段 | 填写方式 |
| --- | --- |
| 下载按钮 | 必填。填写触发下载的元素，例如 `css=button.download` 或 `xpath=//button[normalize-space()='下载']` |
| 文件名包含 | 必填。填写浏览器建议文件名中必须包含的文本，例如 `report.xlsx` |
| MIME 类型包含 | 可选。例如 Excel 文件可填写 `spreadsheetml.sheet` |
| 文件内容包含 | 可选。仅适用于可按 UTF-8 读取的文本、CSV、JSON 等文件 |
| 最小字节数 / 最大字节数 | 可选。用于排除空文件或异常大小文件 |
| SHA256 | 可选。适用于内容固定的 Excel、PDF、压缩包等二进制文件 |

`MIME 类型包含` 按下载请求的响应标头 `Content-Type` 填写，不是请求上传格式。动态文件名只出现在 `Content-Disposition` 时，Runner 也会据此匹配下载响应；例如响应标头为 `Content-Type: multipart/form-data`，该字段就填写 `multipart/form-data`。

该步骤会先监听 Playwright `download` 事件，再点击下载元素，等待下载完成后保存并执行断言。Playwright 不操作 Chromium 顶部工具栏或 Windows“另存为”窗口；`acceptDownloads` 会接管下载并保存到当前用例产物目录：

```text
artifacts/runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/downloads/<文件名>
```

平台模式会把下载文件与报告、日志、`result.json` 一起上传到 admin，并保留 `downloads/<原文件名>`、`logs/<日志名>` 等逻辑相对路径。空的 `dom/`、`screenshots/` 目录不会在 admin 端创建；步骤结果中的 `downloaded_file` 会替换为受鉴权的 admin 文件地址。

校验文件内容时，文本文件填写“文件内容包含”；Excel、PDF 等二进制文件使用 SHA256。执行成功后可在 `result.json` 的 `steps[].downloaded_file`、`downloaded_filename`、`downloaded_bytes`、`downloaded_mime` 和 `downloaded_sha256` 中查看结果。

## 查看执行产物

单用例产物目录：

```text
artifacts/runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/
```

例如：`artifacts/runs/AAS_P/V6.5B06D011/AAS_P_SMOKE_006/SCENE_CASE_001/20260717/20260717180409/`。目录各层来自 admin 用例执行快照，字符会按 Windows 路径规则进行安全处理；末级目录和 `runId` 均使用该用例的执行 ID。

批量产物目录：

```text
artifacts/batches/<batchId>/
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
Get-Content -Raw artifacts\runs\<projectShortName>\<versionName>\<sceneId>\<caseId>\<yyyyMMdd>\<executionId>\result.json
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
artifacts/runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/report.html
artifacts/batches/<batchId>/report.html
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

### 配置实时画面质量

在 admin 的 `Playwright Runner 配置` 中，通过浏览器右侧的 `实时画面质量` 选择质量档位：

| 档位 | 像素倍率 | JPEG 质量 | 截图间隔 | 单帧上限 | 适用场景 |
| --- | ---: | ---: | ---: | ---: | --- |
| `流畅（1080P，低带宽）` | 1 | 65 | 1000ms | 2MB | 弱网或并发任务 |
| `高清（推荐）` | 1.5 | 82 | 1000ms | 4MB | 日常执行观察，默认选项 |
| `超清（4K，高带宽）` | 2 | 85 | 1500ms | 8MB | 大屏查看文字和细节 |
| `8K（极高资源占用）` | 4 | 90 | 3000ms | 16MB | 临时精细排查，不建议长期启用 |

像素倍率只在 Runner 使用固定 viewport 时生效；有头模式配合 `默认最大化` 时，Playwright 不允许同时设置设备像素倍率，实时画面分辨率由实际浏览器窗口决定。JPEG 只保留在 admin Job 内存中，不写入场景 JSON。

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
node src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4173/api --output tests/case-296-m5o-e2e.spec.js
node --check tests/case-296-m5o-e2e.spec.js
npm exec -- playwright test case-296-m5o-e2e.spec.js --config playwright.config.js
```

导出带 storage state 的 spec：

```powershell
node src/export-playwright.js `
  --case-id 296 `
  --api-base http://127.0.0.1:4173/api `
  --storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json `
  --output tests/case-296-m5o-storage.spec.js

node --check tests/case-296-m5o-storage.spec.js
npm exec -- playwright test case-296-m5o-storage.spec.js --config playwright.config.js
```

导出文件支持以下环境变量覆盖：

```text
CUECAST_START_URL
CUECAST_API_BASE
CUECAST_STORAGE_STATE
```

注意：要用当前 `playwright.config.js` 直接运行导出的 spec，建议输出到 `tests/`，因为配置中的 `testDir` 指向该目录。

## 导出 Pytest 脚本

导出 pytest 文件：

```powershell
node src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4173/api --output playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py
```

导出带 storage state 的 pytest 文件：

```powershell
node src/export-pytest.js `
  --case-id 296 `
  --api-base http://127.0.0.1:4173/api `
  --storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json `
  --output playwright-runner-artifacts/exports/test_case_296_m5o_storage.py

python -m py_compile playwright-runner-artifacts/exports/test_case_296_m5o_storage.py
```

当前本地验证只要求导出文件可编译；pytest 端到端运行需要本机安装 pytest 和 Playwright pytest 运行环境。

## 常用 CLI 参数

单用例入口：

```powershell
node src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--case-id` | 单用例 ID | 必填 |
| `--project-environment-id` | admin 产品环境 ID；admin 单用例任务必填 | 无 |
| `--api-base` | API 地址 | `http://127.0.0.1:4173/api` |
| `--browser` | `chromium`、`firefox`、`webkit` | `chromium` |
| `--browser-executable-path` | 可选浏览器可执行文件绝对路径 | 空 |
| `--locator-mode` | `legacy` 保持历史行为；`semantic-v1` 对齐录制定位语义 | `legacy` |
| `--page-error-check-enabled` | 留空继承用例；`true`、`false` 显式覆盖 | 继承用例 |
| `--headed` | 是否显示浏览器 | `false` |
| `--ignore-https-errors` | 是否忽略 HTTPS 证书错误 | `false` |
| `--slow-mo` | Playwright 动作慢放毫秒数，便于人工观察 | `0` |
| `--finish-delay` | 执行结束后关闭浏览器前停留毫秒数 | `0` |
| `--trace` | `on`、`off`、`retain-on-failure` | `off` |
| `--video` | `on`、`off`、`retain-on-failure` | `off` |
| `--timeout` | 单步超时毫秒 | `6000` |
| `--case-timeout` | 总用例超时毫秒；超时会关闭 context/browser 并回传失败 | `600000` |
| `--start-step` | 从第几个 step 开始 | `0` |
| `--artifact-dir` | 产物根目录 | `artifacts` |

批量入口：

```powershell
node src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4173/api --workers 2
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--case-ids` | 逗号分隔 case ID | 可由 `CUECAST_CASE_IDS` 提供 |
| `--workers` | case 级并发数 | `1` |
| `--session-mode` | `isolated` 隔离执行；`reuse-auth` 串行复用认证状态；`reuse-browser` 串行复用同一浏览器窗口 | `isolated` |
| `--storage-state` | 单用例或批次的只读初始 storage state | 空 |
| `--api-base` | API 地址 | `http://127.0.0.1:4173/api` |
| `--artifact-dir` | 产物根目录 | `artifacts` |
| `--log-dir` | 本机脱敏结构化诊断日志目录 | `logs` |

常用环境变量：

```text
CUECAST_CASE_IDS       批量 case ID，例如 278,279
CUECAST_API_BASE       后端 API 地址
CUECAST_TOKEN          后端鉴权 token
CUECAST_PROJECT_ENVIRONMENT_ID admin 产品环境 ID
CUECAST_STORAGE_STATE  导出脚本或真实环境使用的 storage state 文件
RUNNER_WORKERS         批量 worker 数
RUNNER_SESSION_MODE    isolated | reuse-auth | reuse-browser
RUNNER_STORAGE_STATE   单用例或批次的只读初始 storage state 文件
RUNNER_BROWSER         chromium | firefox | webkit
RUNNER_BROWSER_EXECUTABLE_PATH 可选浏览器可执行文件绝对路径
RUNNER_LOCATOR_MODE    legacy | semantic-v1
RUNNER_PAGE_ERROR_CHECK_ENABLED 留空继承用例，true | false 为任务级覆盖
RUNNER_HEADED          true | false
RUNNER_TRACE           on | off | retain-on-failure
RUNNER_VIDEO           on | off | retain-on-failure
RUNNER_ARTIFACT_DIR    产物根目录
RUNNER_LOG_DIR         本机脱敏结构化诊断日志目录，默认 logs
RUNNER_STEP_TIMEOUT_MS 单步超时
RUNNER_CASE_TIMEOUT_MS 单 case 超时
```

优先级：CLI 参数 > 环境变量 > 默认值。

`reuse-auth` 仅允许串行批次（`workers=1`）。它复用 Cookie、localStorage、IndexedDB，以及最终页面同源的 sessionStorage 快照；不复用页面内存或 WebSocket 会话。平台批次的 `--storage-state-out` 只能由 admin 后端注入，认证文件不会进入 artifact、场景记录或前端请求；批次正常完成或取消后会被清理。

如果下一条用例的录制起点仍是 `/login`、`/login1`、`/signin` 等登录路由，Runner 会在同源且上一条成功用例已进入非登录页面时恢复上一条最终业务页。普通业务起点、跨域地址和 `isolated` 模式不应用该规则。

`reuse-browser` 同样仅允许串行批次（`workers=1`）。它由 admin 或批量 CLI 启动独立宿主，持有同一个 Browser、Context 和页面；每条用例仍使用独立 Runner 进程、Trace、截图、结果与取消状态。`video=on|off|retain-on-failure` 均受支持，宿主原生录制整批视频，批次结束后切出按用例分段的 WebM，不需要关闭 Context；切片依赖 `ffmpeg`。宿主连接端点仅绑定本机并通过子进程环境变量传递，不进入命令日志或前端响应。

Admin 托管执行必须同步部署 `sakura-playwright/src/browser-session-host.js`、`sakura-playwright/src/batch-video-finalizer.js` 和 Admin 的共享浏览器服务改动，并重启 Admin；旧宿主仍会在 Runner 日志中出现 `录屏尺寸=...`，表示走的是兼容 screencast 路径。

会话复用排查日志位于：

```text
<runnerRoot>/logs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>.log
<runnerRoot>/logs/<yyyyMMdd>/session-audit.log
```

重点检查：

1. `登录态加载=true`，以及 Cookie、localStorage、IndexedDB 条目数量。
2. `目标域匹配=是`。
3. 第二条用例出现 `起始页决策=resume-previous-page`。
4. 页面加载后没有“登录态已加载但页面仍处于登录地址”警告。
5. `session-audit.log` 出现“登录态候选已原子提升”。

日志不会保存 sessionStorage 键名/值、其他认证值、Token、storage state 内容或路径；URL 也会移除查询参数。第二条用例应先出现“待恢复 sessionStorage”和“已注册 sessionStorage 预加载”，随后导航日志中的 sessionStorage 数量应与候选一致。若数量一致仍回到登录页，目标系统可能依赖页面内存或服务端一次性会话，需要评估后续同一 Page 执行模式。

## 真实环境接入方式

当后端和中台准备好后，mock 命令中的 `--api-base` 替换为真实 API 地址：

```powershell
node src/index.js `
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
node src/batch.js
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
npm exec -- playwright install chromium
```

如果浏览器下载持续失败，确认节点已有与 `RUNNER_BROWSER` 匹配的浏览器，然后在 `.env` 配置其绝对路径：

```text
RUNNER_BROWSER=chromium
RUNNER_BROWSER_EXECUTABLE_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe
```

用例没有回到初始状态：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4173/api/testcases/<caseId>/reset
```

导出 Playwright spec 提示 `No tests found`：

- 将导出文件放到 `tests/`。
- 使用 `npm exec -- playwright test <fileName> --config playwright.config.js`。

pytest 编译失败：

- 确认本机 Python 可用。
- 先运行 `python --version`。

没有 trace 或 video：

- 成功用例在 `retain-on-failure` 下不会保留 trace/video。
- 需要强制保留时使用 `--trace on --video on`。

定位失败：

- 查看 `result.json` 中的 `locator_source`、`locator_type`、`matched_count`、`visible_count` 和 `details.locator_diagnostics`。诊断会列出每种候选的 DOM/可见匹配数、上下文评分、最高分差、归一化规则、loading 暂停时长和最近资源失败。
- `LOCATOR_NOT_FOUND` 表示所有候选均未命中；`LOCATOR_HIDDEN`、`LOCATOR_DISABLED`、`LOCATOR_COVERED` 分别表示命中但不可见、不可用或被遮挡；`LOCATOR_LOOKUP_ERROR` 表示候选表达式本身执行异常。
- `LOCATOR_AMBIGUOUS` 表示多个可见元素没有达到高置信自动收敛条件，需要补充更强的 `locator_meta.context` 或更精确 selector，Runner 不会静默选择第一个元素。
- admin Runner Job 默认使用 `semantic-v1`；手工复现录制定位问题时也要显式增加 `--locator-mode semantic-v1`，否则会走兼容用的 `legacy` 路径。

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
7. 执行完整成功集合 `278,279,281-297`。
8. 打开最新 batch 的 `report.html` 和 `summary.json`。
9. 导出并执行 case `296` 的 Playwright spec。
10. 导出并编译 case `296` 的 pytest 文件。
11. 打开 `http://127.0.0.1:4173/testcases/279`，人工点 `Runner 回放` 验证 mock 中台入口。
12. 单独执行 case `297` 并确认 `details.locator_diagnostics.normalization_rule` 为 `checkbox-visible-wrapper`。
13. 根据真实环境清单替换 API、token、storage state，再做小规模真实 case 验证。

## 当前边界

当前本地 mock 阶段可以告一段落。已完成能力见：

- `docs/playwright-runner-stage-completion.md`
- `README.md`

仍需真实环境配合的事项：

- 真实业务用例 70% 步骤通过率验证。
- 真实中台接入和权限控制。
- 真实账号、token、登录态管理。
- 对象存储 artifact URL。
- 生产 CI / 定时任务实跑。
- 真实复杂组件专项验证。
