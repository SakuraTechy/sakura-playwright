# Chrome 扩展录制 + Playwright Runner 回放落地方案

## 结论

建议采用“录制端保留 Chrome 扩展，执行端新增 Playwright Runner”的混合架构。

这条路线不推翻当前 CueCast 已有的低代码录制体验，也不强行把所有能力一次性迁移到 Playwright。扩展继续负责用户侧录制、步骤采集、截图和中台联动；新增 Playwright Runner 负责批量执行、CI 回归、trace/video、并发和稳定报告。

目标不是立刻替换现有 `../sakura-cuecast/modules/player-manager.js` 的 CDP 回放，而是形成两个执行通道：

- 浏览器回放：现有 Chrome Extension + CDP，适合录制后立即验证、复用当前浏览器状态。
- Runner 回放：新增 Playwright Runner，适合 CI、批量回归、异步任务、稳定报告。

## 背景

当前项目已经具备完整的录制和扩展内回放能力：

- `../sakura-cuecast/content/recorder.js` 采集用户操作。
- `../sakura-cuecast/content/selector-core.js` 生成 CSS/XPath。
- `locator_meta` 保存多候选定位器和上下文。
- `../sakura-cuecast/modules/recorder-manager.js` 管理录制生命周期和保存步骤。
- `../sakura-cuecast/modules/player-manager.js` 通过 Chrome Debugger Protocol 优先执行回放。
- `../sakura-cuecast/content/player.js` 提供 DOM 降级回放。

当前方案的强项是低代码产品体验和真实浏览器内录制。短板是长期维护自研执行引擎成本高，特别是等待策略、定位策略、报告、并发、trace、CI 接入、跨浏览器能力都需要自己补。

Playwright 的强项正好在执行侧：成熟的 locator、自动等待、trace、video、截图、并发、CI 生态和浏览器上下文管理。因此最务实的方案是：录制端继续复用现有扩展，执行端逐步引入 Playwright Runner。

## 目标架构

```text
Chrome Extension
  - 录制操作
  - 生成 target_selector / target_xpath / locator_meta
  - 上传步骤、截图、上下文
          |
          v
后端 Test Case / Step 存储
          |
          +---------------------------+
          |                           |
          v                           v
扩展内 CDP 回放              Playwright Runner 回放
  - 用户本地验证              - CI / 批量 / 定时任务
  - 复用当前 Chrome           - trace / video / 并发
  - 中台即时操作              - 标准化报告
```

## 适用场景划分

| 场景 | 推荐执行方式 | 原因 |
| --- | --- | --- |
| 录制后立即验证 | 扩展 CDP 回放 | 使用当前浏览器，反馈最快 |
| 用户机器上复现问题 | 扩展 CDP 回放 | 可复用真实登录态和本机环境 |
| 批量回归 | Playwright Runner | 并发、隔离、报告更成熟 |
| CI/CD | Playwright Runner | 无需人工浏览器，易接入流水线 |
| 需要 trace/video | Playwright Runner | Playwright 原生支持 |
| 需要跨浏览器验证 | Playwright Runner | 可跑 Chromium / Firefox / WebKit |
| 需要中台一键录制 | Chrome Extension | 产品体验更自然 |

## 实施原则

1. 不改录制入口：继续使用 Chrome 扩展录制。
2. 不废弃现有回放：扩展内 CDP 回放保留，作为本地即时验证能力。
3. 新增独立 Runner：Playwright Runner 作为新的执行器，不塞进扩展 Service Worker。
4. 复用现有 step 协议：不要另起一套用例格式，先消费当前后端 steps。
5. 优先解释执行：先做“读取 step 并执行”，后续再考虑导出 Playwright/pytest 脚本。
6. 定位能力逐步迁移：先支持基础 CSS/XPath/data-testid，再迁移表格、浮层、树等复杂策略。

## 第一阶段变更边界

M1 的目标是验证 Playwright Runner 这条执行通道是否可行，因此必须严格控制变更范围。

第一阶段允许：

- 在 `sakura-playwright` 仓库根目录建立独立 Node.js Playwright 项目。
- 修改 `docs/`：补充方案、运行说明和验证记录。
- 修改 `../sakura-cuecast/test-lab/`：补 mock API、mock case 或验证页面。

第一阶段不修改：

- `../sakura-cuecast/content/`
- `../sakura-cuecast/modules/`
- `../sakura-cuecast/popup/`
- `../sakura-cuecast/background.js`
- `../sakura-cuecast/manifest.json`

也就是说，M1 不改变现有 Chrome 扩展的录制和回放逻辑，不影响当前用户路径。只有当 Runner 在 mock 用例和少量真实用例上验证通过后，才进入后续阶段评估是否增强录制端 `locator_meta`、增加中台 Runner 入口，或调整扩展与后端的联动。

## 阶段 1：标准化 Step 执行协议

当前 step 字段已经比较完整，但需要明确哪些字段是跨执行器稳定协议，哪些只是扩展内部辅助字段。

### 标准 Step 结构

```json
{
  "id": 22240,
  "test_case_id": 275,
  "step_index": 6,
  "action_type": "click",
  "target_selector": "button[data-testid=\"submit\"]",
  "target_xpath": "//*[@id='submit']",
  "value": "",
  "url": "https://example.com/login",
  "description": "点击提交",
  "wait_before": 0,
  "locator_meta": {
    "version": 1,
    "generated_at": 1783067038902,
    "candidates": [],
    "context": {}
  }
}
```

### 必须支持的 action_type

第一期建议支持：

- `navigate`
- `click`
- `double_click`
- `right_click`
- `input`
- `key`
- `hover`
- `scroll`
- `wait`
- `assert_text`

第二期再支持：

- `assert_json`
- `ai_natural`
- 文件上传
- 下载断言
- 网络断言
- 多窗口/新标签页
- iframe

### locator_meta 继续作为核心资产

Playwright Runner 不应该只消费 `target_selector` 和 `target_xpath`。当前录制器已经在 `locator_meta` 中记录了很多高价值信息：

- 多候选定位器。
- 表格行列信息。
- 行文本摘要。
- 树节点标题、父路径、层级。
- 浮层 reveal 触发信息。
- 控件类型。
- 元素 rect、容器文本、label 文本。

Runner 要复用这些信息，才能继承当前扩展定位策略的积累。

## 阶段 2：建立 Playwright 项目和最小执行器

当前在项目根目录使用：

```text
sakura-playwright/
  package.json
  playwright.config.js
  src/
    index.js
    batch.js
    export-playwright.js
    export-pytest.js
    api/
      api-client.js
    runner/
      case-loader.js
      step-runner.js
      locator-resolver.js
    reporting/
      result-reporter.js
      artifacts.js
    shared/
      utils.js
```

### 模块职责

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | CLI / 服务入口，解析参数，启动任务 |
| `src/api/api-client.js` | 调后端接口，读取用例，回传结果 |
| `src/runner/case-loader.js` | 规范化 test case 和 steps |
| `src/runner/step-runner.js` | 将 action_type 映射为 Playwright 操作 |
| `src/runner/locator-resolver.js` | 根据 step 和 locator_meta 找元素 |
| `src/reporting/result-reporter.js` | 组装执行结果并回传 |
| `src/reporting/artifacts.js` | 管理 screenshot / trace / video / log |
| `src/shared/utils.js` | 通用解析、等待、日志工具 |

### CLI 入口

第一期先做命令行，降低接入复杂度。以下命令默认从仓库根目录执行：

```bash
node src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

建议参数：

```text
--case-id          用例 ID
--api-base         后端 API 地址
--browser          chromium | firefox | webkit
--headed           是否显示浏览器
--trace            on | off | retain-on-failure
--video            on | off | retain-on-failure
--timeout          单步默认超时
--start-step       从第几步开始执行
--env              环境标识，例如 dev/test/stage
```

第二期再做 HTTP 服务：

```http
POST /runner/jobs
{
  "case_id": 278,
  "browser": "chromium",
  "headed": false,
  "trace": "retain-on-failure",
  "video": "retain-on-failure"
}
```

## 阶段 3：Runner 执行主流程

Runner 主流程如下：

```text
读取参数
  |
  v
调用后端获取 test case
  |
  v
启动 browser / context / page
  |
  v
开启 trace / video / console 采集
  |
  v
打开 start_url
  |
  v
按 step_index 遍历执行步骤
  |
  +--> 成功：记录 step result
  |
  +--> 失败：截图、保存 trace、采集 DOM 摘要、停止或按策略继续
  |
  v
关闭 context / browser
  |
  v
回传执行结果和 artifacts
```

### 最小伪代码

```js
async function runCase(options) {
  const api = new ApiClient(options.apiBase);
  const testCase = await api.getTestCase(options.caseId);
  const artifacts = await createRunArtifacts({
    artifactDir: options.artifactDir || "playwright-runner-artifacts",
    caseId: options.caseId
  });
  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    viewport: resolveViewport(testCase),
    recordVideo: options.video ? { dir: artifacts.runDir } : undefined
  });

  if (options.trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  const page = await context.newPage();
  const result = createRunResult({ options, artifacts, testCase });

  try {
    await page.goto(resolveStartUrl(testCase), { waitUntil: "domcontentloaded" });
    for (const step of normalizeSteps(testCase.steps)) {
      await runStep(page, step, result);
    }
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = serializeError(error);
    await collectFailureArtifacts(page, artifacts, result);
  } finally {
    if (options.trace) {
      await context.tracing.stop({ path: `${artifacts.runDir}/trace.zip` });
    }
    await context.close();
    await browser.close();
    await api.reportResult(result);
  }
}
```

## 阶段 4：Locator Resolver 设计

这是整个方案最关键的部分。Runner 的 `resolveLocator(page, step)` 要复用扩展录制出的定位信息，并按优先级逐级兜底。

### 推荐定位优先级

1. `locator_meta.candidates` 高分候选。
2. 语义属性候选：`data-testid`、`data-test`、`name`、`aria-label`、`title`。
3. Playwright 语义 locator：`getByRole()`、`getByLabel()`、`getByText()`。
4. 表格上下文定位。
5. 树节点上下文定位。
6. 浮层和弹窗上下文定位。
7. `target_selector`。
8. `target_xpath`。
9. 文本 fallback。

### 候选类型映射

| candidate.type | Playwright 映射策略 |
| --- | --- |
| `css_attr_data-testid` | `page.getByTestId()` 或 `page.locator(css)` |
| `css_attr_data-test` | `page.locator(css)` |
| `css_attr_name` | `page.locator(css)` |
| `css_attr_aria-label` | 优先 `page.getByLabel()`，再 `page.locator(css)` |
| `css_attr_placeholder` | `page.getByPlaceholder()` |
| `css_id` | `page.locator(css)` |
| `css_fallback` | `page.locator(css)` |
| `xpath_fallback` | `page.locator("xpath=" + xpath)` |
| `table_cell_css` | 表格上下文优先，再 CSS |
| `table_cell_xpath` | 表格上下文优先，再 XPath |
| `text_exact` | `page.getByText(text, { exact: true })` |
| `text_exact_tag` | `page.locator(tag).filter({ hasText })` |
| `tree_interaction` | 树节点解析器 |
| `tree_node_text` | 树节点解析器 |

### Resolver 返回值

建议 `resolveLocator()` 不只返回 locator，还返回定位来源，方便失败分析：

```js
{
  locator,
  source: "locator_meta.candidates[0]",
  candidateType: "table_cell_xpath",
  value: "(//div[contains(@class,'el-table')])[1]//tbody/tr[3]/td[8]/div/span"
}
```

### 基础 Resolver 伪代码

```js
async function resolveLocator(page, step) {
  const meta = parseLocatorMeta(step.locator_meta);
  const candidates = sortCandidates(meta?.candidates || []);

  for (const candidate of candidates) {
    const resolved = await tryCandidate(page, step, candidate, meta?.context);
    if (await isUsable(resolved?.locator)) return resolved;
  }

  const bySelector = await tryCss(page, step.target_selector);
  if (await isUsable(bySelector?.locator)) return bySelector;

  const byXpath = await tryXpath(page, step.target_xpath);
  if (await isUsable(byXpath?.locator)) return byXpath;

  const byText = await tryTextFallback(page, step.value);
  if (await isUsable(byText?.locator)) return byText;

  throw new Error(formatLocatorNotFound(step));
}
```

### 可用性判断

不要仅判断 count 大于 0。建议判断：

- locator 是否存在。
- 是否可见。
- 是否未 disabled。
- 多个命中时是否能根据上下文收敛到一个。
- 对 click/hover 是否能通过 Playwright actionability 检查。

示例：

```js
async function isUsable(locator) {
  if (!locator) return false;
  const count = await locator.count().catch(() => 0);
  if (count < 1) return false;
  const first = locator.first();
  return await first.isVisible().catch(() => false);
}
```

## 阶段 5：Step Runner 动作映射

### 基础动作映射

```js
async function runStep(page, step) {
  if (step.wait_before > 0) {
    await page.waitForTimeout(step.wait_before);
  }

  switch (step.action_type) {
    case "navigate":
      await page.goto(step.value || step.url, { waitUntil: "domcontentloaded" });
      break;

    case "click":
      await (await resolveLocator(page, step)).locator.click();
      break;

    case "double_click":
      await (await resolveLocator(page, step)).locator.dblclick();
      break;

    case "right_click":
      await (await resolveLocator(page, step)).locator.click({ button: "right" });
      break;

    case "input":
      await fillInput(page, step);
      break;

    case "key":
      await (await resolveLocator(page, step)).locator.press(step.value || "Enter");
      break;

    case "hover":
      await (await resolveLocator(page, step)).locator.hover();
      break;

    case "scroll":
      await scrollStep(page, step);
      break;

    case "wait":
      await page.waitForTimeout(Number(step.value) || 1000);
      break;

    case "assert_text":
      await assertText(page, step);
      break;

    default:
      throw new Error(`Unsupported action_type: ${step.action_type}`);
  }
}
```

### input 处理

普通 input 可以用 `fill()`，但需要兼容不同控件：

| 控件 | 策略 |
| --- | --- |
| 原生 input/textarea | `locator.fill(value)` |
| 原生 select | `locator.selectOption(value)` 或按文本选择 |
| Ant Select / Element Select | click 打开，下拉按文本选择 |
| contenteditable | click 后 `keyboard.insertText(value)` |
| Monaco | 点击 editor，快捷键全选删除，再 `keyboard.insertText(value)` |

第一期可以先支持原生 input/textarea/select，复杂组件沿用 click + option 文本策略。

### assert_text 处理

建议支持三种目标：

- 整页断言：`page.locator("body")`
- 元素断言：通过 `resolveLocator()`
- 错误提示断言：扫描 toast/message/dialog

匹配方式建议支持：

- `contains`
- `equals`
- `not_contains`
- `regex`

可从 `locator_meta.context.assertion` 或后端新增字段读取。

## 阶段 6：表格、浮层、树的专项迁移

第一期只做基础定位后，复杂用例的稳定性不会立刻达到扩展 CDP 回放水平。需要分批迁移当前 `../sakura-cuecast/content/player.js` 中的定位经验。

### 表格定位

输入：

```json
{
  "table": {
    "framework": "el",
    "wrapper_index": 0,
    "section": "tbody",
    "row_index": 2,
    "col_index": 7,
    "row_text": "3 | 2026-04-17 ..."
  }
}
```

策略：

1. 先按 `framework` 找表格 wrapper，如 `.el-table`、`.ant-table`、`.ivu-table`、`table`。
2. wrapper 多个时按 `wrapper_index` 取目标。
3. 在 tbody 中找 row。
4. 如果 `row_text` 存在，优先用文本相似度校验。
5. 找到 `col_index` 对应 cell。
6. 在 cell 内按相对 CSS/XPath 或文本找目标。

### 浮层和弹窗定位

策略：

1. 优先查找可见 dialog/modal/popover/dropdown。
2. 在最高 z-index 的容器内找目标。
3. 对下拉选项优先按文本 exact 匹配。
4. 支持 reveal trigger：先 hover/click 触发菜单，再找目标。
5. 多个同名按钮时优先当前可见弹窗内的按钮。

### 树节点定位

输入：

```json
{
  "tree_interaction": {
    "framework": "ant-tree",
    "kind": "node_content",
    "title": "用户管理",
    "parentPath": ["系统设置"],
    "level": 1,
    "sameTitleIndex": 0
  }
}
```

策略：

1. 扫描当前可见树节点。
2. 提取节点标题。
3. 根据缩进或 aria-level 计算层级。
4. 计算父路径。
5. 按 title、parentPath、level、sameTitleIndex 打分。
6. 根据 kind 选择点击节点内容、展开按钮或操作图标。

## 阶段 7：结果回传协议

不管是扩展 CDP 回放还是 Playwright Runner，最终都应该回传统一结果。

### 执行结果结构

```json
{
  "case_id": 278,
  "run_id": "20260704-001",
  "executor": "playwright-runner",
  "status": "failed",
  "started_at": "2026-07-04 18:00:00",
  "finished_at": "2026-07-04 18:00:15",
  "duration_ms": 15000,
  "browser": "chromium",
  "headless": true,
  "failed_step_index": 3,
  "error": "locator not found",
  "steps": [
    {
      "step_index": 1,
      "status": "passed",
      "duration_ms": 500,
      "locator_source": "css_attr_data-testid",
      "screenshot": "..."
    }
  ],
  "artifacts": {
    "trace_url": "",
    "video_url": "",
    "screenshots": [],
    "logs": []
  }
}
```

### Artifact 建议

第一期本地落盘：

```text
playwright-runner-artifacts/
  runs/
    278-20260704-100000/
      result.json
      trace.zip
      <playwright-video>.webm
      failure.html
      screenshots/
        failure.png
      dom/
        failure-text.txt
```

后续可以上传对象存储，并将 URL 回传后端。

## 阶段 8：后端和中台改造

### 后端新增能力

建议新增或扩展接口：

```http
GET /testcases/{id}
POST /testcases/{id}/runs
PATCH /runs/{run_id}
POST /runs/{run_id}/steps
POST /runs/{run_id}/artifacts
```

如果短期不想改后端，可以先让 Runner 复用现有结果回传接口，只要中台能看到 pass/fail、失败步骤和截图即可。

### 中台新增执行模式

用例执行按钮可以增加模式选择：

- 浏览器回放：调用现有扩展。
- Runner 回放：调用 Playwright Runner。
- CI 回放：创建后台异步任务。

用例详情页建议展示：

- executor：`extension-cdp` / `playwright-runner`
- browser：`chromium` / `firefox` / `webkit`
- headed/headless
- trace 链接
- video 链接
- 失败步骤截图
- locator_source
- error message

### 扩展 CDP 回放接入 admin（阶段 4 补充）

阶段 4 的“Runner 读取 admin 数据执行”不能只覆盖 Node Playwright Runner。扩展内回放仍是录制后即时验证和复用当前 Chrome 登录态的执行器，因此也必须从 admin 读取同一份可执行 case。实现采用共享接口、双执行器：

```text
admin-ui 选中场景用例
  -> window.postMessage(AT_PLATFORM_PLAY, adminCaseKey=sceneId:caseId)
  -> CueCast bridge/background
  -> GET /automation/playwright/testcases/{sceneId}/{caseId}
  -> PlayerManager 复用现有 CDP 优先 / DOM 降级执行
  -> POST /automation/playwright/testcases/{sceneId}/{caseId}/results
```

#### 接口和字段约束

| 项目 | 约定 |
| --- | --- |
| case key | 业务 `sceneId:caseId`，例如 `AAS_P_SMOKE_006:SCENE_CASE_001`；后端兼容数据库场景主键 |
| 执行事实来源 | 响应 `steps[]` 中的完整 `playwright_step` 反向提取结果 |
| 定位上下文 | `locator_meta` 原样返回并交给 CueCast 现有定位器 |
| 扩展结果 executor | `extension-cdp` |
| 结果接口 | 与 Playwright Runner 共用 `/results`，`raw.executor` 区分执行器 |
| 鉴权 | CueCast 从 admin-ui 当前登录 token 发送 Bearer token；后端读取/更新权限不放开匿名访问 |

扩展只负责请求、执行和回传，不在前端或 Service Worker 中重新拼装 `AutomationUiSceneDO -> CaseDO -> StepDO`。旧的 `GET /testcases/{id}` 和 `AT_PLATFORM_PLAY` 调用仍保留，只有携带 `adminCaseKey` 或 `dataSource=admin` 时切换到 admin API。

#### 与 test-lab CDP 回放的关系

`sakura-cuecast/test-lab` 继续作为扩展消息链路的本地验证入口：它通过 `AT_PLATFORM_PLAY` 触发 `background.js -> PlayerManager.start()`，验证 CDP attach、步骤执行、失败通知和停止逻辑。本次补充只是让同一个入口在 admin-ui 场景下把 `adminCaseKey` 传到扩展，并将结果改为回写 admin；不复制 test-lab 的 mock 数据结构，也不改变现有 `PlayerManager` 的复杂定位实现。

#### 失败和兼容策略

1. admin case 拉取失败时，扩展立即提示接口/权限错误，不回退到同名旧 case，避免执行错误数据。
2. CDP attach 或跨扩展页面受限时，继续使用现有 DOM 降级规则；需要 CDP 的 AI/JSON 步骤仍明确失败。
3. admin 结果回传失败不覆盖本地回放成功状态；扩展通知用户“执行完成但结果回传失败”，后续可通过本地日志排查。
4. 未携带 `adminCaseKey` 的旧调用继续使用 CueCast mock/旧 API，保证 test-lab 和历史入口不变。

## 阶段 9：CI/CD 接入

Runner 稳定后，可以加入 CI。

### GitHub Actions 示例

```yaml
name: CueCast Regression

on:
  workflow_dispatch:
  schedule:
    - cron: "0 18 * * *"

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm exec -- playwright install --with-deps chromium
      - run: node src/index.js --case-id 278 --api-base ${{ secrets.CUECAST_API_BASE }} --trace retain-on-failure
```

### 批量执行策略

第一期串行执行，保证稳定性。

第二期支持并发：

- 单机并发 worker 数量可配置。
- 每个用例独立 browser context。
- 失败不影响其他用例。
- 后端记录任务队列状态。

## 阶段 10：登录态和环境管理

Playwright Runner 不天然复用用户当前 Chrome 登录态，需要设计登录方案。

### 推荐方案

1. 测试账号登录：Runner 启动后自动执行登录步骤。
2. storageState：登录一次后保存 `storageState.json`。
3. 环境变量注入账号密码。
4. 后端按环境配置 start_url、账号和密钥引用。

### 不建议

不建议直接读取用户本机 Chrome profile 执行 CI。这样不可控、不可复现，也容易引入权限和隐私问题。

## 里程碑计划

### M1：最小 Runner 可用

周期：1 到 2 周。

交付：

- 在仓库根目录建立完整 Node.js Playwright 项目。
- 仅允许修改 `docs/` 和 `../sakura-cuecast/test-lab/`，不改现有扩展运行逻辑。
- CLI 可根据 case_id 拉取用例。
- 支持 Chromium headless 执行。
- 支持 `navigate/click/input/key/wait/assert_text`。
- 支持 CSS/XPath/data-testid 基础定位。
- 失败截图和 result.json。
- 可回传基础执行结果。

验收：

- 本地 mock case 278 可以通过 Runner 执行。
- 至少 5 条基础用例稳定通过。

### M2：定位能力增强

周期：2 到 3 周。

交付：

- `locator_meta.candidates` 完整优先级。
- 表格上下文定位。
- 弹窗/浮层定位。
- 文本 exact/tag 定位。
- Ant Select / Element Select 基础支持。
- locator_source 记录。

验收：

- 当前真实业务用例中 70% 以上步骤可由 Runner 执行。
- 失败时能明确给出定位来源和失败原因。

### M3：报告和中台集成

周期：2 周。

交付：

- Runner 执行模式接入中台。
- trace/video/screenshot artifact 管理。
- 执行结果统一展示。
- 支持异步任务状态。

验收：

- 中台可以选择 Runner 回放。
- 失败用例可查看截图、trace、失败步骤。

### M4：CI 和批量执行

周期：2 到 4 周。

交付：

- CI workflow。
- 批量用例执行。
- 并发 worker。
- 环境配置和账号管理。
- 定时回归。

验收：

- 每日定时跑核心用例。
- 报告自动回传中台。
- 失败可追踪到具体 step 和 artifact。

### M5：高级能力

周期：持续迭代。

候选能力：

- 树组件语义定位。
- Monaco 编辑器输入。
- iframe / 多窗口。
- 文件上传 / 下载断言。
- 网络 mock / API 断言。
- 导出 Playwright 脚本。
- 导出 pytest 测试套件。

## 风险和应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| locator_meta 过度依赖 DOM 结构 | 页面变化后仍失败 | 优先语义属性，逐步增强表格/树/浮层 resolver |
| 复杂组件 fill 不生效 | input 步骤失败 | 针对 Ant/Element/Monaco 增加专用 handler |
| 登录态不可复用 | CI 无法跑业务页面 | 建立测试账号和 storageState |
| 后端接口暂不支持 Runner 结果 | 中台看不到报告 | 先本地 artifact + 最小结果回传，后续扩展接口 |
| Playwright 与扩展 CDP 行为不一致 | 同一用例两边结果不同 | 在结果中记录 executor，允许用例标记推荐执行器 |
| 迁移范围过大 | 项目延期 | 分阶段交付，第一期只支持基础动作和基础定位 |

## 推荐技术选型

- Runner 语言：Node.js。
- 自动化框架：Playwright Test 或 Playwright Library。
- 第一阶段建议用 Playwright Library 解释执行 step，避免测试文件生成复杂度。
- 后续如果需要 CI 原生报告，再引入 Playwright Test runner。
- 不建议第一期直接引入 pytest，除非团队已有强 Python 测试基础。

## 为什么先解释执行，不先导出脚本

解释执行更适合当前项目：

- 当前后端已经保存结构化 steps。
- 中台需要即时触发和回传结果。
- 扩展录制生成的 `locator_meta` 很难自然表达成简洁脚本。
- 解释执行可以快速复用现有数据模型。
- 失败信息可以直接映射回 step_index。

导出脚本适合作为后续高级能力：

- 研发团队想把用例纳入代码仓库。
- 需要 code review。
- 需要手写增强 fixture。
- 需要 pytest/Playwright Test 原生生态。

## 最小可落地版本范围

第一版不要追求完全替代扩展回放，建议只承诺：

- 可以拉取后端用例。
- 可以执行基础 Web 表单和按钮流程。
- 可以使用 CSS/XPath/data-testid/text 定位。
- 可以截图和回传 pass/fail。
- 可以在本地和 CI 跑起来。

第一版明确不承诺：

- 完整支持所有组件库特殊控件。
- 完整复刻扩展 CDP 的所有定位兜底。
- 完整支持 AI 自然语言步骤。
- 完整支持 JSON 复杂断言。
- 完整支持多窗口、iframe、文件上传下载。

这样能让方案尽快落地，并且每一步都能产生实际收益。

## 实施细则附录

本节用于把方案从“方向可行”补充到“可以排期和拆任务”。第一版实现时，以下约定应优先固定，避免不同开发者对同一 step 产生不同解释。

### A. Runner 运行环境

建议第一版固定以下基线：

| 项 | 建议 |
| --- | --- |
| Node.js | 20 LTS |
| Playwright | 使用项目 lockfile 固定版本，不使用浮动 latest |
| 默认浏览器 | Chromium |
| 默认模式 | headless |
| 默认单步超时 | 6000 ms |
| 默认用例超时 | 10 分钟，可配置 |
| artifact 根目录 | `playwright-runner-artifacts/`（从仓库根目录执行时） |
| 并发策略 | 第一版串行，第二版 worker pool |

建议环境变量：

```text
CUECAST_API_BASE=http://127.0.0.1:4173/api
CUECAST_TOKEN=
CUECAST_ENV=test
RUNNER_ARTIFACT_DIR=playwright-runner-artifacts
RUNNER_HEADLESS=true
RUNNER_BROWSER=chromium
RUNNER_STEP_TIMEOUT_MS=6000
RUNNER_CASE_TIMEOUT_MS=600000
RUNNER_TRACE=retain-on-failure
RUNNER_VIDEO=retain-on-failure
```

启动时配置优先级：

```text
CLI 参数 > 环境变量 > 后端用例配置 > Runner 默认值
```

### B. API 契约建议

第一版可以复用已有 `GET /testcases/{id}`，但 Runner 需要约定最小返回结构：

```json
{
  "data": {
    "id": 278,
    "name": "登录流程",
    "start_url": "http://127.0.0.1:4173/test-lab/target.html",
    "viewport_mode": "maximized",
    "viewport_width": 1920,
    "viewport_height": 1080,
    "page_error_check_enabled": 1,
    "steps": [
      {
        "id": 1,
        "step_index": 0,
        "action_type": "click",
        "target_selector": "[data-testid=\"submit-login\"]",
        "target_xpath": "",
        "value": "",
        "wait_before": 0,
        "locator_meta": null
      }
    ]
  }
}
```

建议新增执行记录接口：

```http
POST /testcases/{id}/runs
Authorization: Bearer <token>
Content-Type: application/json

{
  "executor": "playwright-runner",
  "browser": "chromium",
  "headless": true,
  "env": "test",
  "start_step_index": 0
}
```

返回：

```json
{
  "data": {
    "run_id": "run_20260704_001",
    "status": "queued"
  }
}
```

步骤结果回传：

```http
POST /runs/{run_id}/steps
Content-Type: application/json

{
  "step_index": 3,
  "step_id": 22240,
  "status": "failed",
  "duration_ms": 1280,
  "action_type": "click",
  "locator_source": "locator_meta.candidates[0]",
  "locator_type": "table_cell_xpath",
  "error": "locator resolved to 0 visible elements",
  "screenshot_url": "..."
}
```

执行结束回传：

```http
PATCH /runs/{run_id}
Content-Type: application/json

{
  "status": "failed",
  "duration_ms": 15000,
  "failed_step_index": 3,
  "error": "locator not found",
  "trace_url": "...",
  "video_url": "..."
}
```

鉴权建议：

- 本地开发允许空 token 或 mock token。
- 测试/生产环境使用 Bearer token。
- Runner token 只授予读取用例、创建执行记录、上传结果和 artifact 的权限。

### C. Job 状态机

如果 Runner 以服务方式运行，建议使用以下状态机：

```text
queued -> running -> passed
                  -> failed
                  -> canceled
                  -> timeout
                  -> infrastructure_failed
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `queued` | 任务已创建，等待 worker 执行 |
| `running` | 已分配 worker，正在执行 |
| `passed` | 所有步骤通过 |
| `failed` | 用例步骤失败，例如定位失败、断言失败 |
| `canceled` | 用户或系统取消 |
| `timeout` | 用例总耗时超过限制 |
| `infrastructure_failed` | Runner、浏览器、网络、后端不可用等基础设施失败 |

取消任务建议：

```http
POST /runs/{run_id}/cancel
```

Runner 每步执行前检查 cancel flag；如果浏览器正在执行长操作，最多等待当前 step timeout 后退出。

### D. action_type 精确定义

第一版必须明确每种动作的行为：

| action_type | 语义 |
| --- | --- |
| `navigate` | 跳转到 `step.value || step.url || case.start_url` |
| `click` | 定位元素后执行普通左键点击 |
| `double_click` | 定位元素后执行双击 |
| `right_click` | 定位元素后执行右键点击 |
| `input` | 默认替换输入框内容，不是追加输入 |
| `key` | 有目标则先聚焦目标再按键；无目标则发给当前焦点 |
| `hover` | 鼠标移动到目标元素上 |
| `scroll` | 优先滚动目标元素到视口；无目标时按 `value` 滚动页面 Y 轴 |
| `wait` | 等待 `Number(value) || wait_before || 1000` 毫秒 |
| `assert_text` | 默认对目标元素做 contains；无目标时对整页 body 做 contains |

`input` 的细化规则：

- 原生 `input` / `textarea`：使用 `fill(value)`。
- 原生 `select`：优先 `selectOption({ value })`，失败后按 label/text 选择。
- `contenteditable`：聚焦后全选清空，再插入文本。
- 复杂组件第一版可先失败并给出明确错误：`unsupported input control`。

`assert_text` 建议新增或复用配置：

```json
{
  "assertion": {
    "target": "element",
    "match": "contains"
  }
}
```

支持值：

- `target`: `page` / `element` / `error`
- `match`: `contains` / `equals` / `not_contains` / `regex`

### E. 定位冲突处理规则

Playwright locator 命中多个元素时，禁止无条件 `.first()`。必须按以下规则处理：

1. 如果只有 1 个匹配且可见，直接使用。
2. 如果多个匹配，先过滤不可见元素。
3. 如果可见元素只剩 1 个，使用。
4. 如果存在 `locator_meta.context.table`，按表格上下文收敛。
5. 如果存在 `locator_meta.context.tree_interaction`，按树节点上下文收敛。
6. 如果目标处于弹窗/浮层场景，优先最高 z-index 的可见 dialog/modal/popover/dropdown。
7. 如果仍有多个候选，按文本、label、container_text、rect 距离打分。
8. 如果最高分和第二名差距不足阈值，直接失败，不静默点击。

建议失败信息包含候选摘要：

```json
{
  "error": "ambiguous locator",
  "candidate_count": 4,
  "visible_count": 3,
  "locator_type": "text_exact",
  "locator_value": "确定",
  "candidates": [
    { "index": 0, "text": "确定", "visible": true, "inDialog": false },
    { "index": 1, "text": "确定", "visible": true, "inDialog": true }
  ]
}
```

这条规则比“点第一个”更保守，但能显著减少误操作。

### F. 等待和页面稳定策略

Playwright 自带 actionability 和 auto-wait，但 Runner 仍需要统一页面稳定策略：

1. `page.goto()` 使用 `domcontentloaded`，再按需要等待业务 loading 消失。
2. 每个交互动作后默认等待 200 到 300 ms，让前端状态刷新。
3. 如果检测到常见 loading UI，等待其消失，最多不超过单步 timeout。
4. 不默认使用 `networkidle` 作为全局策略，因为现代页面可能存在长连接、轮询或埋点请求。

建议内置 loading 选择器：

```text
[aria-busy="true"]
.ant-spin-spinning
.el-loading-mask
.ivu-spin-fix
.n-spin
.v-loading
[data-loading="true"]
```

### G. Artifact 和日志治理

第一版 artifact 保存在本地，第二版上传对象存储。

建议保留策略：

| 类型 | 成功用例 | 失败用例 |
| --- | --- | --- |
| step screenshot | 可关闭 | 保留 |
| failure screenshot | 不适用 | 保留 |
| trace | 默认不保留 | 保留 |
| video | 默认不保留 | 保留 |
| DOM 快照 | 默认不保留 | 保留 |
| console log | 可保留摘要 | 保留 |

敏感信息处理：

- `value_masked`、`value_encrypted`、`value_redacted` 为真时，不在日志中打印 `value`。
- 密码、token、cookie 不写入 result.json。
- trace/video 可能包含敏感页面内容，应设置访问权限和过期时间。
- 上传 artifact 时只回传 URL，不在接口中传大体积 base64。

### H. 错误分类

建议 Runner 将错误归类，方便中台统计：

| code | 含义 |
| --- | --- |
| `LOCATOR_NOT_FOUND` | 找不到目标元素 |
| `LOCATOR_AMBIGUOUS` | 命中多个元素且无法收敛 |
| `ACTION_TIMEOUT` | 操作超时 |
| `ASSERTION_FAILED` | 断言失败 |
| `UNSUPPORTED_STEP` | 不支持的 action_type |
| `UNSUPPORTED_CONTROL` | 不支持的控件类型 |
| `PAGE_ERROR_DETECTED` | 页面出现错误提示 |
| `AUTH_FAILED` | 登录或鉴权失败 |
| `INFRA_BROWSER_FAILED` | 浏览器启动或崩溃 |
| `INFRA_API_FAILED` | 后端 API 失败 |

中台展示时优先显示 code + 人类可读 message + step_index + locator_source。

### I. 第一版任务拆分建议

M1 可以拆成以下开发任务：

1. 创建仓库根级 Node 项目，接入 Playwright。
2. 实现 CLI 参数解析和配置合并。
3. 实现 `ApiClient.getTestCase()`。
4. 实现 `runCase()` 主流程。
5. 实现 `runStep()` 支持 `navigate/click/input/key/wait/assert_text`。
6. 实现基础 `resolveLocator()`：CSS、XPath、data-testid、text。
7. 实现本地 artifact：failure screenshot、result.json。
8. 实现最小结果回传。
9. 用 `test-lab` mock case 做端到端验证。

M1 验收标准：

- 一条包含导航、输入、点击、断言的 mock 用例可以稳定通过 5 次。
- 定位失败时不会误点其他元素。
- 失败时生成 `result.json` 和 `failure.png`。
- CLI exit code：成功为 0，失败为非 0。
- README 或文档中有本地启动命令。

## 建议下一步

1. 在仓库根目录创建最小 Node + Playwright 项目。
2. 实现 `ApiClient.getTestCase(caseId)`。
3. 实现 `runCase()` 和 `runStep()`。
4. 实现基础 `resolveLocator()`。
5. 用 `test-lab` 的 mock case 验证。
6. 跑 3 到 5 条真实业务用例，收集失败类型。
7. 根据失败类型补表格、浮层、复杂组件 resolver。
