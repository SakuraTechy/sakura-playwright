# Playwright Runner 阶段完成情况

本文档用于记录 `docs/playwright-runner-hybrid-implementation.md` 中每个阶段的完成情况，方便把计划方案与实际落地逐项对比。

维护规则：

- 每个阶段完成后必须更新对应章节。
- 每个验收项都要写清楚状态、验证命令、验证结果和产物路径。
- 未完成或部分完成的能力要写入遗留问题，作为下一阶段输入。
- 不提交生成产物，只记录产物路径和关键结论。

状态说明：

| 状态 | 含义 |
| --- | --- |
| `未开始` | 尚未进入实现或验证 |
| `进行中` | 已开始实现，但未达到阶段验收标准 |
| `待验证` | 代码基本完成，等待端到端验证 |
| `通过` | 已满足该阶段验收标准 |
| `部分通过` | 分批目标已通过，完整阶段仍有缺口 |
| `阻塞` | 由于环境、依赖或设计问题暂时无法继续 |

## 总览

| 阶段 | 目标 | 当前状态 | 完成记录 |
| --- | --- | --- | --- |
| M1 | 最小 Runner 可用 | 通过 | 本地 mock case 278 已通过 |
| M2 | 定位能力增强 | 部分通过 | 分批能力已完成并通过 mock 验证 |
| M3 | 报告和中台集成 | 部分通过 | 本地报告、artifact 管理、mock 中台 Runner job 已通过 |
| M4 | CI 和批量执行 | 通过 | 批量入口、mock 批量 job API、CI 模板已实现并通过本地 mock 验收 |
| M5 | 高级能力 | 部分通过 | M5-A 至 M5-O 已完成 iframe、文件上传、多文件上传、隐藏上传代理、下载断言、高级下载校验、二进制下载校验、JSON/API、Monaco 输入、Monaco 快捷键、树定位、展开/复选树、多窗口基础切换、多窗口显式切换和关闭、多 popup 选择、网络 mock、类 HAR 回放、请求断言、响应断言、响应快照、快照基线对比、请求数量断言、失败注入专项 case、Playwright/pytest 脚本导出、复杂定位导出、高级动作导出和导出 Playwright 端到端执行并通过 mock 验收 |

## 2026-08-11：Element Message 断言定位一致性修复

### 完成情况

| 事项 | 结果 |
| --- | --- |
| Element UI 通知浮层识别 | Runner 与 CueCast 对直属 `body` 的 `fixed/absolute` 通知使用同一浮层规则，`el-message` 不再因 `overlay=true` 被错误过滤 |
| 录制 XPath 稳定性 | CueCast 计算绝对 XPath 时忽略自身 `__at_*` 工具栏和弹窗节点，避免录制页与回放页产生 `/div[6]` 与 `/div[5]` 的下标偏移 |
| 通知文本回退 | `p` 元素断言保存 `text_exact` 和 `text_exact_tag` 候选，CSS/XPath 变化时仍可按通知文本定位 |

### 验证

- CueCast `node --test tests/*.test.js`：31/31 通过。
- Runner `npm run check`：通过。
- Runner `npm run test:unit`：86/86 通过。
- Runner `npm run test:locator`：15/15 通过，新增固定 Element Message 浮层断言回归用例通过。
- 用户执行 Trace `data/file/automation/playwright/AAS_P/V6.5B06D011/AAS_P_SMOKE_001/SCENE_CASE_006/20260811/20260811150048` 已确认 CSS 首轮命中但被浮层语义过滤；修复后本地回归复现为 `1/1`。

### 遗留验证

- 独立 CLI 复跑真实用例时 Admin 返回 `401：您的登录状态已过期，请重新登录`，当前环境没有可控的已登录 Chrome 会话，尚未生成新的真实平台执行记录。

## 2026-08-07：同一浏览器窗口连续执行

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 新会话模式 | 新增 `reuse-browser`，同一批次的独立 Runner 进程连接同一个 Browser、Context 和当前页面 |
| 页面连续性 | 同源非登录业务页直接交给下一条用例，保留 sessionStorage、IndexedDB、页面内存和运行时 DOM 状态 |
| 生命周期 | 仅允许串行；失败、取消、批次终态或 admin 停止时关闭共享宿主，不影响默认 `isolated` 和 `reuse-auth` |
| 产物边界 | Trace、失败截图和结果仍按用例生成；`video=on|off|retain-on-failure` 均可用，共享宿主原生录制批次 WebM，批次结束后按用例时间切片，不关闭共享 Context |
| 安全边界 | WebSocket 端点只绑定 `127.0.0.1`，由服务端通过子进程环境变量传递，不写入日志、场景或接口响应 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过，72/72；覆盖 `reuse-browser` 保留所选录屏策略。
- `npm run test:session`：通过，3/3；新增用例验证两个独立 Runner 进程共享同一页面及仅存在于页面内存的 DOM 状态、每条成功用例生成非空 WebM，并验证失败后新宿主接管后续用例。
- Admin UI `npm run typecheck`：通过。
- Admin `mvn -pl continew-automation -am -DskipTests compile`：通过；`AutomationPlaywrightRunnerJobServiceImplTest` 通过，6/6。依赖仓库连接与证书告警不影响本次编译和测试结果。

## 2026-08-05：变量执行诊断与等待倒计时

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 全局变量详情 | 本地变量动作把变量名、来源及脱敏后的值预览写入 `step.details.variable`；不写原始对象或敏感值 |
| 引用变量详情 | 包含 `${...}` 的步骤把引用名和本次解析值写入 `step.details.variable_references`；根变量标记为敏感时仅保存 `value_masked=1` |
| 基础设施变量 | Agent 原始变量仍只在当前 Runner 内存中使用，写报告前通过 `VariableContext.describe()` 转为同一安全预览 |
| 等待日志 | `wait` 动作按剩余秒数输出结构化倒计时日志，并保持原配置总等待时长 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过，58/58；新增覆盖全局变量详情、引用实际值与敏感值隐藏、2500ms 等待产生 `<3s>/<2s>/<1s>` 日志且累计时长不变。
- Admin UI `pnpm typecheck` 和诊断组件 ESLint：通过；历史本地变量记录可从顶层 `variable_name/value_preview` 生成只读兼容详情。

### 边界

- 历史记录未持久化的引用实际值和等待倒计时不能事后还原；这些字段从新执行开始产生。
- 值预览最长 120 个字符；`value_masked=1` 时只展示 `******`，不在报告或日志中写入实际值。

## 2026-07-24：批次认证状态复用与取消联动

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 会话模式 | 新增 `isolated` 与 `reuse-auth`；旧命令默认保持隔离 |
| 状态范围 | 成功用例提交 Cookie、localStorage 和 IndexedDB；失败、取消、强杀不提交候选状态 |
| 串行约束 | `reuse-auth` 仅允许带批次标识的串行执行，`workers > 1` 明确报错 |
| 取消联动 | 批次取消终止活动 Node 进程并清理当前状态和候选状态；迟到结果不能覆盖 `cancelled` |
| 安全边界 | 状态路径由 admin 后端生成，命令日志脱敏，不写入 artifact、场景 JSON 或前端请求 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过。
- `npm run test:session`：通过；同一夹具下 `isolated` 的第二条受保护用例失败，`reuse-auth` 成功复用 Cookie、localStorage 和 IndexedDB。

## 2026-07-24：Element Select 回放与结果关联修复

### 完成情况

| 事项 | 结果 |
| --- | --- |
| Element/Ant Select 搜索语义 | Runner 识别“点击打开 → input 搜索词 → overlay 选项点击”的连续录制步骤；搜索输入只填充内部文本框，不再提前选择并关闭下拉层 |
| overlay 定位语义 | `semantic-v1` 补齐 CueCast/CDP 的 `is_overlay`、`normalize-space()` 和无 selector 值步骤识别；期望 overlay 时不回退到页面表格中的同名文本 |
| 步骤结果关联 | admin 回填优先使用唯一 `step_index`，重复 `step_id` 改为队列兜底；Runner 使用唯一执行 ID 并保留 `original_step_id`，避免结果覆盖或错位 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过，24 项；`npm run test:locator`：通过，9 项，新增 Element Select 搜索—选项回放和重复步骤 ID 回归用例。
- admin reactor 编译和定向测试通过；`AutomationPlaywrightStepExtractorTest` 验证管理端唯一步骤 ID 与录制原始 ID 分离，`AutomationPlaywrightCaseServiceImplTest` 验证重复录制 ID 按执行序号正确关联。

### 录制追加与替换的影响

| 操作 | 对原数据的影响 |
| --- | --- |
| `appendCase` | 保留原用例内容，但插入后会重排全部用例 ID、顺序及子步骤 `pid`；依赖旧用例 ID 的外部引用需要同步 |
| `appendStep` | 保留目标用例原步骤内容，但插入后会重排该用例全部步骤 ID；原始 `playwright_step` 不改写 |
| `replaceCase` | 仅替换目标用例全部内容和步骤，同时保留目标用例身份；其他用例不变 |
| `replaceCaseSteps` | 仅替换目标用例的完整步骤列表；原步骤不再保留在当前版本中，其他用例不变 |
| `replaceStep` | 仅删除并替换目标步骤，其他步骤内容保留；随后会重排该用例全部步骤 ID |

### 边界

- 只改变 Runner 对连续录制步骤的还原和 admin 结果关联，不改变 legacy 定位模式和 CDP 执行链路。
- 远程搜索、多选和虚拟列表仍需结合对应组件录制样本继续验收。

## 2026-07-19：录制定位语义对齐

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 双模式兼容 | 新增 `semantic-v1`，admin Runner Job 固定启用；手工 CLI/Jenkins 默认保持 `legacy`，不改变历史入口行为 |
| 录制候选 | 支持 CueCast 当前全部候选类型，并结合 control、label、container、sibling、table、rect 和 state class 上下文评分 |
| 高置信收敛 | 仅最高分和领先分差同时达标时自动选择；低置信多匹配返回 `LOCATOR_AMBIGUOUS` |
| 可交互代理 | 隐藏 checkbox/radio 转到 label 或组件包装器，SVG 转到可交互祖先，combobox 转到可见内部控件 |
| 等待与页面错误 | loading 期间暂停逻辑超时并保留 180 秒墙钟上限；页面错误检测支持用例继承和任务级 `true/false` 覆盖 |
| 诊断结果 | 步骤结果写入候选尝试、匹配数、评分、归一化、等待和资源失败，并区分未找到、歧义、隐藏、禁用、遮挡和查找异常 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过，共 20 项。
- `npm run test:locator`：通过，共 8 项，覆盖代理转换、上下文收敛、歧义、延迟出现、loading 暂停、页面错误、遮挡分类和后续等待错误保真。
- Mock case `297` 以 `--locator-mode semantic-v1` 执行通过；隐藏原生 checkbox 被转换为可见 `label`，诊断记录 `normalization_rule: checkbox-visible-wrapper`、最高分 `255`。
- `AutomationPlaywrightRunnerJobServiceImplTest`：通过，共 2 项，确认 admin 固定传 `semantic-v1`、显式 `false` 不丢失、继承模式不传覆盖参数。
- `pnpm typecheck`、`pnpm build`（`sakura-admin-ui`）：通过；构建仅保留现有 Sass `@import` 弃用告警。

### 边界

- `semantic-v1` 对齐的是 CueCast 录制步骤语义和失败分类，不复用 Chrome 扩展的 `chrome.debugger` 生命周期、当前 Chrome 登录态或扩展 UI。
- 真实 admin 录制场景、产品环境结果回写和失败 artifact 展示仍需现场验收。

## 2026-07-19：实时画面动作可视化

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 虚拟鼠标 | Runner 发送实际目标坐标，admin-ui 使用录屏同款透明 PNG 橙色鼠标独立覆盖显示，放大期间保持固定尺寸 |
| 聚焦放大 | 根据目标控件中心平滑放大完整原始帧约 1.75 倍；靠近边缘时自动限制位移，避免出现黑边 |
| 动作提示 | 实时画面底部显示步骤序号和 admin 用例步骤名称，目标元素显示半透明橙色高亮，点击波纹仅播放一次 |
| 页面兼容 | 可视化使用不接收指针事件的 Canvas，不写入可检索文本，不影响页面交互、文本断言或后续定位 |
| 短动作抓帧 | 定时截图之外增加动作前立即抓帧，避免步骤在两个截图周期之间完成而无法显示 |
| 原始画质 | 聚焦坐标和动画信息写入 JPEG 注释段，前端缩放完整帧，不裁剪或降低 4K/8K 原始分辨率 |
| 展示节奏 | admin 实时任务每步至少保留约 500ms；前端按画质使用 500ms 至 1000ms 拉取间隔 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过，共 15 项；覆盖动作前强制新帧、目标聚焦坐标、一次性波纹和 JPEG 聚焦信息。
- `pnpm typecheck`、`pnpm build`（`sakura-admin-ui`）：通过；构建仅保留现有 Sass `@import`、字体运行时解析和大分块告警。
- `录屏_20260719_030814.mp4` 以每秒 6 帧抽取过渡区间，确认参考效果约在 560ms 内由全景放大至目标区域，波纹仅短暂出现。
- 当前应用内浏览器未提供可用实例，完整组件动画的浏览器视觉对比待本地运行任务复验。

### 边界

- 当前实时通道仍传输 JPEG 动作帧，不是 20 FPS 视频流；效果为按真实步骤位置更新的操作回放，不会采集操作系统鼠标。
- iframe 内目标由所在 frame 自己绘制覆盖层，跨域 frame 不需要读取父页面 DOM。

## 2026-07-15：工程目录重构

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 项目根目录 | `package.json`、`package-lock.json`、`playwright.config.js`、`.env.example` 和 `README.md` 已提升到 `sakura-playwright/` 根目录 |
| CLI 入口 | 保留 `src/index.js`、`src/batch.js`、`src/export-playwright.js`、`src/export-pytest.js` 作为稳定入口 |
| 源码分类 | 内部模块按 `src/api/`、`src/runner/`、`src/reporting/`、`src/shared/` 分类 |
| 配套目录 | 测试提升到 `tests/`，窗口聚焦辅助扩展迁移到 `tools/focus-extension/` |
| 调用方 | admin 默认 Runner 根目录和 CueCast test-lab 启动路径已同步到新结构 |
| 文档与 CI | README、操作手册、方案、阶段记录、工作区接入文档和 GitHub Actions 路径已同步 |

### 验证

- `npm run check`：通过。
- `npm exec -- playwright test --list --config=playwright.config.js`：通过，识别 `tests/` 下 2 个用例。
- `node --check ../sakura-cuecast/test-lab/mock-server.js`：通过。
- `node --check ../sakura-cuecast/test-lab/app.js`：通过。
- `node src/index.js --case-id 278 --api-base http://127.0.0.1:4273/api --headed false --trace off --video off`：通过。
- CueCast test-lab Runner Job 与 Batch Job：均通过，实际命令分别指向 `src/index.js` 和 `src/batch.js`。
- CueCast test-lab 请求 `/artifacts/batches/<batchId>/report.html`：返回 HTTP `200`，新 artifact 映射可访问。
- `mvn -pl continew-automation -am -DskipTests compile`：通过。

## 2026-07-15：admin 产品环境回放配置

### 完成情况

| 事项 | 结果 |
| --- | --- |
| 共用弹窗 | CDP 与 Runner 使用 Jenkins 同款双卡片排版；产品环境必选，自动化环境已移除 |
| 环境快照 | admin 按产品环境生成临时执行快照，替换绝对 HTTP(S) 地址的 Origin 并保留路径、查询和锚点，不修改主数据 |
| CDP 配置 | 支持最大化、当前窗口、自定义宽高和页面错误检测；执行记录保存有效环境、地址和配置快照 |
| Runner 配置 | 单任务支持 browser、headed、HTTPS、trace/video、step/case timeout、slowMo 和 finishDelay 白名单参数 |
| Runner 总超时 | `RUNNER_CASE_TIMEOUT_MS`/`--case-timeout` 已实际包裹用例执行，超时会关闭 context/browser 并回传失败 |
| Jenkins 回归边界 | 未修改 `ExecuteSceneModal.vue`、Jenkins DTO、`AutomationUiSceneServiceImpl.exec()` 或参数构造 |

### 验证

- `npm run check`：通过。
- `npm run test:unit`：通过，覆盖 CLI 优先级、产品环境查询参数和总超时清理。
- admin 后端环境地址改写、环境归属、错误上下文和主数据不变测试：7 个测试通过。
- CueCast `background.js`、`modules/api-client.js`、`modules/player-manager.js`：`node --check` 通过。
- admin-ui `pnpm typecheck`：通过。
- 真实 `.45/.47` 环境、浏览器产物和 Jenkins 回归仍需按部署环境人工验收。

## M1：最小 Runner 可用

### 计划目标

M1 目标是验证 Playwright Runner 执行通道是否可行。第一阶段不修改现有 Chrome 扩展录制和回放逻辑。

### 完成情况

| 计划交付 | 实际完成情况 | 状态 | 说明 |
| --- | --- | --- | --- |
| 建立 Node.js Playwright 项目 | 已新增 Node ESM 项目、Playwright 配置和 Runner 源码 | 通过 | 包含 `package.json`、`playwright.config.js`、`src/` |
| 不修改现有扩展运行逻辑 | Runner 作为独立项目存在 | 通过 | 未替换 `cuecast` 内 CDP 回放 |
| CLI 可根据 `case_id` 拉取用例 | 已实现 `--case-id`、`--api-base` 等参数 | 通过 | 入口为 `src/index.js` |
| 支持 Chromium headless 执行 | 已通过本地 headless 验证 | 通过 | mock case 278 通过 |
| 支持基础动作 | 已支持 `navigate/click/input/key/wait/assert_text`，并额外支持 `double_click/right_click/hover/scroll` | 通过 | 见 `src/runner/step-runner.js` |
| 支持基础定位 | 已支持 CSS、XPath、text exact、部分 `locator_meta.candidates` | 通过 | 见 `src/runner/locator-resolver.js` |
| 失败截图和 `result.json` | 已实现 `result.json`、`failure.png`、`failure.html` | 通过 | case 280 验证了失败产物 |
| 回传基础执行结果 | 已实现 `POST /testcases/{id}/results` | 通过 | mock server 接收执行结果 |

### 已执行验证

| 时间 | 命令 | 结果 | 产物 |
| --- | --- | --- | --- |
| 2026-07-04 | `npm run check` | 通过 | 无 |
| 2026-07-04 | `node src/index.js --case-id 278 --api-base http://127.0.0.1:4174/api --headed false` | 通过 | `playwright-runner-artifacts/runs/278-20260704-165349/` |

### 阶段结论

结论：`通过`。

M1 已完成，可以进入后续定位能力增强。

## M2：定位能力增强

### 计划目标

- 优先使用 `locator_meta.candidates`。
- 增强表格上下文定位。
- 增强弹窗、浮层、下拉菜单定位。
- 支持 text exact/tag 定位。
- 支持 Ant Select / Element Select 基础选择。
- 在结果中记录 `locator_source`。

### 本轮分批目标

- 扩展候选类型：`css_attr_name`、`css_attr_aria-label`、`css_attr_placeholder`、`table_cell_css`、`table_cell_xpath`。
- 支持表格上下文定位，按 `wrapper_index`、`row_index`、`col_index` 收敛到 cell。
- 支持弹窗/浮层容器内收敛，避免点击页面外同名元素。
- 支持 Ant/Element 风格自定义 select 的基础输入。
- 成功 step 记录 `locator_source`、`locator_type`、`matched_count`、`visible_count`。
- 失败 step 记录 `error_code`、`locator_source`、`locator_type` 和候选摘要。

### 完成情况

| 计划交付 | 实际完成情况 | 状态 | 说明 |
| --- | --- | --- | --- |
| `locator_meta.candidates` 优先级扩展 | 已扩展本轮候选类型并保持高分优先 | 部分通过 | 树、Monaco、iframe 等候选仍待后续 |
| 表格上下文定位 | 已支持 mock 表格 cell 内定位 | 通过 | case 279 step 1 使用 `table:locator_meta.candidates[0]` |
| 弹窗/浮层定位 | 已支持可见 overlay 内收敛 | 通过 | case 279 step 4 使用 `overlay:locator_meta.candidates[0]` |
| 文本 exact/tag 定位 | 已支持 `text_exact` 和 `text_exact_tag` | 通过 | 歧义场景会明确失败 |
| Ant/Element Select 基础支持 | 已支持 Ant/Element 风格自定义下拉按文本选择 | 部分通过 | 已覆盖基础 mock，下游真实组件仍需验证 |
| `locator_source` 记录 | 成功和失败结果均已记录 | 通过 | case 279、280 已验证 |

### 已执行验证

| 时间 | 命令 | 结果 | 产物 |
| --- | --- | --- | --- |
| 2026-07-04 | `npm run check` | 通过 | 无 |
| 2026-07-04 | `node src/index.js --case-id 278 --api-base http://127.0.0.1:4174/api --headed false` | 通过，M1 回归未破坏 | `playwright-runner-artifacts/runs/278-20260704-165349/` |
| 2026-07-04 | `node src/index.js --case-id 279 --api-base http://127.0.0.1:4174/api --headed false` | 通过，覆盖表格、浮层、自定义 select | `playwright-runner-artifacts/runs/279-20260704-165405/` |
| 2026-07-04 | `node src/index.js --case-id 280 --api-base http://127.0.0.1:4174/api --headed false` | 按预期失败，返回 `LOCATOR_AMBIGUOUS` | `playwright-runner-artifacts/runs/280-20260704-165414/` |

### 遗留问题

- 真实业务用例 70% 步骤通过率尚未验证。
- 表格定位当前覆盖基础 row/col/cell 场景，复杂固定列、虚拟滚动、树形表格仍需后续补强。
- Ant/Element Select 当前覆盖基础可见下拉选项，远程搜索、多选、虚拟列表仍需后续补强。
- 树组件、Monaco、iframe、多窗口、文件上传下载仍按计划放到 M5 或专项阶段。

### 阶段结论

结论：`部分通过`。

M2 分批目标已完成并通过本地 mock 验证；完整 M2 仍需结合真实业务用例继续补齐。

## M3：报告和中台集成

### 计划目标

- Runner 执行模式接入中台。
- trace/video/screenshot artifact 管理。
- 执行结果统一展示。
- 支持异步任务状态。

### 完成情况

| 计划交付 | 实际完成情况 | 状态 | 说明 |
| --- | --- | --- | --- |
| 中台 Runner 回放入口 | test-lab 新增 `Runner 回放` 按钮，mock API 支持创建 Runner job | 部分通过 | 真实中台接入未做 |
| trace/video/screenshot 管理 | Runner 支持 `retain-on-failure`，失败时保留 trace、video、screenshot、HTML、DOM 文本 | 通过 | case 280 已验证 |
| 执行结果统一展示 | 执行历史可展开 `Runner report`，展示失败步骤、定位来源和 artifact 链接 | 部分通过 | mock 中台已完成，真实中台未接 |
| 异步任务状态 | mock API 支持 `/api/runner/jobs` 创建和查询 queued/running/passed/failed 状态 | 部分通过 | 当前为本地内存 job |

### 已执行验证

| 时间 | 命令 | 结果 | 产物 |
| --- | --- | --- | --- |
| 2026-07-04 | `npm run check` | 通过 | 无 |
| 2026-07-04 | `node --check ../sakura-cuecast/test-lab/mock-server.js` | 通过 | 无 |
| 2026-07-04 | `node --check ../sakura-cuecast/test-lab/app.js` | 通过 | 无 |
| 2026-07-04 | `node src/index.js --case-id 280 --api-base http://127.0.0.1:4175/api --headed false --trace retain-on-failure --video retain-on-failure` | 按预期失败，保留失败 artifact | `playwright-runner-artifacts/runs/280-20260704-172347/` |
| 2026-07-04 | `POST /api/runner/jobs` case 279 | 异步 job 通过，结果回写执行历史 | `playwright-runner-artifacts/runs/279-20260704-172315/` |

### 遗留问题

- 当前 Runner job 只在 `../sakura-cuecast/test-lab/mock-server.js` 内存中维护，服务重启后 job 状态不保留。
- 当前中台 artifact 链接为本地静态路径，真实环境仍需要对象存储或后端 artifact URL。
- 真实中台的执行模式选择、权限控制、任务取消、任务队列仍未接入。
- 成功用例在 `retain-on-failure` 下只保留 report 和 console log，不保留 trace/video；如需成功也保留，使用 `--trace on --video on`。

### 阶段结论

结论：`部分通过`。

M3 的本地报告、artifact 管理、mock 中台 Runner 回放和异步 job 状态已完成；真实中台集成仍待后续接入。

## M4：CI 和批量执行

### 计划目标

- 新增批量运行入口，支持一次运行多个 case。
- 支持串行和有限并发 worker。
- 支持 CLI/env 配置，并保持优先级：CLI 参数 > 环境变量 > 默认值。
- 每个 case 独立生成 artifact，批量结束后生成总览 `summary.json` 和 `report.html`。
- 批量退出码：全部通过为 `0`，任意失败为非 `0`。
- mock lab 支持保留 278、279、280 测试用例和历史结果。
- 增加 GitHub Actions workflow 模板。
- README 和阶段完成文档补充 M4 验证说明。

### 完成情况

| 计划交付 | 实际完成情况 | 状态 | 说明 |
| --- | --- | --- | --- |
| 批量运行入口 | 已新增 `src/batch.js` 和 `npm run run:batch` | 通过 | 支持 `--case-ids` |
| 并发 worker | 已支持 `--workers`，默认 `1` | 通过 | case 级有限并发已验证 |
| 独立 case artifact | 批量内每个 case 复用单 case Runner 流程 | 通过 | 产物位于 `runs/<caseId>-<timestamp>/` |
| 批量汇总报告 | 已实现 `summary.json` 和 `report.html` | 通过 | 产物位于 `batches/<batchId>/` |
| 环境变量配置 | 已支持 `CUECAST_CASE_IDS`、`RUNNER_WORKERS`、`RUNNER_TRACE`、`RUNNER_VIDEO`、`RUNNER_ARTIFACT_DIR` 等 | 通过 | 已验证 env 入口，CLI 参数优先由解析逻辑保证 |
| Mock 批量 job API | 已新增 `POST/GET /api/runner/batches` | 通过 | 已模拟中台批量触发 |
| CI 模板 | 已新增 `.github/workflows/cuecast-runner.yml` | 通过 | 默认跑 mock case `278,279`，本地检查命令路径 |
| README | 已补充 M4 批量执行和 CI 验证说明 | 通过 | `README.md` |

### 已执行验证

| 时间 | 命令 | 结果 | 产物 |
| --- | --- | --- | --- |
| 2026-07-04 | `npm run check` | 通过 | 无 |
| 2026-07-04 | `node --check ../sakura-cuecast/test-lab/mock-server.js` | 通过 | 无 |
| 2026-07-04 | `node --check ../sakura-cuecast/test-lab/app.js` | 通过 | 无 |
| 2026-07-04 | `node src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4176/api --workers 1` | 通过，退出码 `0`，两个 case passed | `playwright-runner-artifacts/batches/batch-20260704-175748/` |
| 2026-07-04 | `node src/batch.js --case-ids 278,280 --api-base http://127.0.0.1:4176/api --workers 1` | 按预期失败，退出码非 `0`，case 280 failed | `playwright-runner-artifacts/batches/batch-20260704-175801/` |
| 2026-07-04 | `node src/batch.js --case-ids 278,279 --api-base http://127.0.0.1:4176/api --workers 2` | 通过，两个 case 独立产物，summary 正确 | `playwright-runner-artifacts/batches/batch-20260704-175822/` |
| 2026-07-04 | `CUECAST_CASE_IDS=278,279 RUNNER_WORKERS=2 CUECAST_API_BASE=http://127.0.0.1:4176/api node src/batch.js` | 通过，env 入口生效，summary 显示 `workers: 2` | `playwright-runner-artifacts/batches/batch-20260704-175907/` |
| 2026-07-04 | `POST /api/runner/batches` | 通过，batch job 状态为 `passed`，退出码 `0` | `playwright-runner-artifacts/batches/batch-20260704-175835/` |

### 遗留问题

- M4 当前以 mock lab 和本地 artifact 验收为主，未接真实生产后端。
- CI workflow 模板尚未在远端 GitHub Actions 实际运行，本轮只做本地命令路径和 mock 验收。
- 真实环境 secrets、对象存储上传、生产定时任务仍待后续真实集成。
- `280` 是预期失败用例，仅用于失败报告验证，不纳入默认成功回归集合。

### 阶段结论

结论：`通过`。

M4 本轮要求的批量执行、有限并发、环境变量配置、批量汇总报告、mock 批量 job API 和 GitHub Actions 模板已完成，并通过本地 mock 验收。真实 CI 运行、真实后端 secrets 和对象存储上传仍作为后续真实集成项。

## M5：高级能力

### 候选能力

- 树组件语义定位。
- Monaco 编辑器输入。
- iframe / 多窗口。
- 文件上传 / 下载断言。
- 网络 mock / API 断言。
- 导出 Playwright 脚本。
- 导出 pytest 测试套件。

### M5-A 本轮分批目标

M5 是持续迭代阶段，本轮先实现可本地验证、可保留 mock 用例的第一批高级能力：

- `iframe` 定位上下文：读取 `locator_meta.context.frame.selector`，在 iframe 内执行候选定位。
- 文件上传：新增 `file_upload` action，对 `input[type=file]` 执行 `setInputFiles`。
- 下载断言：新增 `assert_download` action，点击触发下载，校验文件名和内容，并保存到 run 产物目录。
- JSON/API 断言：新增 `assert_json` action，支持页面 JSON 文本子集断言和 API JSON 子集断言。
- test-lab 新增 case `281`，覆盖上述能力。

### M5-B 本轮分批目标

- Monaco/类 Monaco 编辑器输入：识别 `.monaco-editor` 或 `data-control-kind="monaco"`，清空后插入文本。
- 树组件语义定位：新增 `tree_item_text` 候选类型，在树容器内按节点文本定位。
- 多窗口/新标签页基础切换：新增 `click_open_page`，点击后等待 popup，并将后续步骤切换到新页面执行。
- test-lab 新增 case `282`，覆盖上述能力。

### M5-C 本轮分批目标

- 网络 mock：新增 `network_mock` action，通过 Playwright route mock 指定 URL/pattern。
- API JSON 断言增强：`assert_json` API 模式支持 `method`、`headers`、`body/json`。
- Playwright 脚本导出：新增 `src/export-playwright.js` 和 npm script `export:playwright`。
- test-lab 新增 case `283`，覆盖网络 mock 和 POST API JSON 断言。

### M5-D 本轮分批目标

- pytest 脚本导出：新增 `src/export-pytest.js` 和 npm script `export:pytest`。
- 生成 pytest + Playwright sync API 风格脚本。
- 对导出文件执行 Python 语法编译检查。

### M5-E 本轮分批目标

- 增强 Playwright/pytest 导出的 locator 渲染。
- 支持 `frame`、`tree_item_text`、`table_cell_css`、`table_cell_xpath`、`text_exact`、`text_exact_tag`、CSS、XPath candidate。
- 验证复杂 mock case `279`、`281`、`282` 的 Playwright 和 pytest 导出语法。

### M5-F 本轮分批目标

- 新增 `assert_request` action。
- 支持校验请求 URL/pattern、method、body 片段和 headers。
- test-lab 新增 case `284`，覆盖点击按钮触发 POST 请求并断言请求。
- 修复长页面下 M2 自定义 select 下拉浮层可能开在视口外导致点击超时的问题。

### M5-G 本轮分批目标

- `network_mock` 支持 `delayMs` 延迟响应和 `abort` 失败注入参数。
- 新增 `assert_request_count` action。
- Runner 记录页面生命周期内的请求事件，支持按 URL/pattern、method、body 片段、headers 统计请求数量。
- test-lab 新增 case `285`，覆盖延迟 mock 和两次 POST 请求数量断言。

### M5-H 本轮分批目标

- 新增 `assert_response` action。
- 支持等待匹配 URL/pattern、method、status 的响应。
- 支持响应 body 文本片段断言和 JSON 子集断言。
- `network_mock` 的 abort 场景增加专项 mock case 验证，并在结果中记录 `network_mock_abort`。
- test-lab 新增 case `286`，覆盖响应 JSON 断言和失败注入后的页面处理分支。

### M5-I 本轮分批目标

- `assert_response` 支持 `snapshot` 和 `snapshotName` 配置。
- 命中响应后可保存响应 body 到 `responses/<snapshotName>.json|txt`。
- 同步保存响应 metadata 到 `responses/<snapshotName>.meta.json`。
- 成功 step 记录 `response_snapshot`、`response_snapshot_meta` 和 `response_body_bytes`。
- test-lab 新增 case `287`，覆盖响应快照文件化和页面渲染断言。

### M5-J 本轮分批目标

- `assert_response` 支持 `baselinePath` 和 `baselineMode` 配置。
- 支持 JSON 精确对比、JSON 子集对比和文本对比。
- 成功 step 记录 `response_baseline`、`response_baseline_mode` 和 `response_baseline_matched`。
- test-lab 新增响应基线文件 `../sakura-cuecast/test-lab/response-baselines/m5j-profile.json`。
- test-lab 新增 case `288`，覆盖响应基线对比、响应快照和页面渲染断言。

### M5-K 本轮分批目标

- 新增 `network_replay` action。
- 支持从 `../sakura-cuecast/test-lab/network-fixtures/*.json` 读取多条网络响应 fixture。
- 每条回放 entry 支持 URL/pattern、method、status、headers、json/body、delayMs 和 abort。
- 成功 step 记录 `network_replay_path` 和 `network_replay_entries`。
- test-lab 新增 case `289`，覆盖两条接口回放、页面渲染断言和请求数量断言。

### M5-L 本轮分批目标

- 复用已实现的 `file_upload`，覆盖一次上传多个 fixture 文件。
- 增强 `assert_download` 验收记录，覆盖下载文件名、内容片段、MIME、最小大小和 SHA256 校验。
- 成功 step 记录 `uploaded_files`、`downloaded_mime`、`downloaded_bytes` 和 `downloaded_sha256`。
- test-lab 新增 case `290`，覆盖多文件上传和高级下载断言。

### M5-M 本轮分批目标

- 增强 Playwright/pytest 导出，覆盖 `assert_download`、`assert_json`、`assert_request`、`assert_response`、`assert_request_count`、`network_mock` 和 `network_replay`。
- 导出的 Playwright spec 内置请求/响应匹配、JSON 子集断言、网络 mock/replay、下载校验、响应快照和响应基线 helper。
- 导出的 pytest 文件内置对应同步 API helper，并能生成 Python 语法有效的高级动作脚本。
- `network_replay` 导出时展开 fixture entries，避免导出脚本只保留无法执行的 TODO。
- 使用 mock case `281`、`283` 至 `290` 覆盖高级动作导出语法验收。

### M5-N 本轮分批目标

- 新增 `switch_page` action，支持按 `target: main/current/latest/popup`、`index`、URL 片段和标题片段在已打开页面间显式切换。
- 新增 `close_page` action，支持关闭当前或匹配页面，并按 fallback 切回主页面或其他仍打开页面。
- Runner step 结果记录 `switched_page_url`、`switched_page_title`、`closed_page_url`、`active_page_url` 等多窗口调试字段。
- Playwright/pytest 导出同步支持 `switch_page` 和 `close_page`，导出脚本维护页面列表并生成对应 helper。
- test-lab 新增 case `291`，覆盖打开 popup、回主页面、按 URL 切回 popup、关闭 popup 后回主页面。

### M5-O 本轮分批目标

- 多窗口专项：新增 case `292`，覆盖连续打开两个 popup，并按标题、URL 精确切换和关闭后 fallback。
- 树组件专项：新增 case `293`，覆盖展开树节点后按 `tree_item_text` 命中带 checkbox 的树节点。
- Monaco 专项：新增 case `294`，覆盖多行输入后触发 `Control+S` 快捷键反馈。
- 上传下载专项：`file_upload` 支持 `value.inputSelector`，覆盖按钮代理隐藏 `input[type=file]`；新增二进制下载 MIME、大小和 SHA256 校验 case `295`。
- 导出脚本专项：修正 Playwright 导出 import 为当前依赖可执行的 `playwright/test`；新增 case `296`，覆盖 Runner 单跑、Playwright 导出端到端执行、pytest 导出编译、`--storage-state` 和 `CUECAST_START_URL`/`CUECAST_API_BASE` 环境参数化。

### 完成情况

| 能力 | 实际完成情况 | 状态 | 说明 |
| --- | --- | --- | --- |
| 树组件语义定位 | 基础文本语义定位、展开后复选树节点选择已完成 | 部分通过 | case 282 覆盖 `tree_item_text`；case 293 覆盖展开树和 checkbox tree item |
| Monaco 编辑器输入 | 类 Monaco 基础输入、多行输入和快捷键反馈已完成 | 部分通过 | case 282 覆盖 `.monaco-editor` 输入；case 294 覆盖多行输入和 `Control+S` |
| iframe / 多窗口 | iframe 基础定位、popup 基础切换、显式切换、关闭页面和多 popup 选择已完成 | 部分通过 | case 281 覆盖 iframe；case 282 覆盖 `click_open_page`；case 291 覆盖 `switch_page` 和 `close_page`；case 292 覆盖双 popup 按标题/URL 切换与 fallback |
| 文件上传 / 下载断言 | 基础上传、下载断言、多文件上传、高级下载校验、隐藏上传代理和二进制下载校验已完成 | 部分通过 | case 281 覆盖基础 `file_upload` 和 `assert_download`；case 290 覆盖多文件上传、MIME、大小和 SHA256 校验；case 295 覆盖 `inputSelector` 代理上传和 `.bin` 下载 |
| 网络 mock / API 断言 | 基础网络 mock、类 HAR 回放、API JSON 子集断言、请求断言、响应断言、响应快照、快照基线对比、请求数量断言和 abort 失败注入专项 case 已完成 | 部分通过 | case 281 覆盖 GET；case 283 覆盖 `network_mock` 和 POST；case 284 覆盖 `assert_request`；case 285 覆盖 `assert_request_count`；case 286 覆盖 `assert_response` 和 `network_mock.abort`；case 287 覆盖响应快照；case 288 覆盖基线对比；case 289 覆盖 `network_replay` |
| 导出 Playwright 脚本 | 基础动作、复杂定位、高级动作、多窗口增强动作导出、storage state、环境参数化和导出脚本端到端执行已完成 | 部分通过 | case 279/281/282 覆盖复杂定位；case 281、283-290 覆盖高级动作导出；case 291 覆盖多窗口增强动作导出；case 296 覆盖导出 spec 端到端执行和 storage state |
| 导出 pytest 测试套件 | 基础动作、复杂定位、高级动作、多窗口增强动作导出、storage state 和环境参数化已完成，专项 smoke 可编译 | 部分通过 | case 279/281/282 覆盖复杂定位；case 281、283-290 覆盖高级动作导出；case 291 覆盖多窗口增强动作导出；case 296 覆盖 pytest 导出编译和 storage state 参数生成 |

### 已执行验证

| 时间 | 命令 | 结果 | 产物 |
| --- | --- | --- | --- |
| 2026-07-06 | `npm run check` | 通过 | 无 |
| 2026-07-06 | `node --check ../sakura-cuecast/test-lab/mock-server.js` | 通过 | 无 |
| 2026-07-06 | `node src/index.js --case-id 281 --api-base http://127.0.0.1:4177/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖 iframe、文件上传、下载断言、页面 JSON 和 API JSON 断言 | `playwright-runner-artifacts/runs/281-20260706-095906/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281 --api-base http://127.0.0.1:4177/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M1/M2/M5-A 批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-095957/` |
| 2026-07-06 | `node src/index.js --case-id 282 --api-base http://127.0.0.1:4178/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖 Monaco 输入、树语义定位、多窗口基础切换 | `playwright-runner-artifacts/runs/282-20260706-105759/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282 --api-base http://127.0.0.1:4178/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M1/M2/M5-A/M5-B 批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-105946/` |
| 2026-07-06 | `node src/index.js --case-id 283 --api-base http://127.0.0.1:4179/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖网络 mock 和 POST API JSON 断言 | `playwright-runner-artifacts/runs/283-20260706-111200/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283 --api-base http://127.0.0.1:4179/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M1/M2/M5-A/M5-B/M5-C 批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-111310/` |
| 2026-07-06 | `node src/export-playwright.js --case-id 278 --api-base http://127.0.0.1:4179/api --output playwright-runner-artifacts\exports\case-278-m5c.spec.js` | 通过，生成 Playwright spec | `playwright-runner-artifacts/exports/case-278-m5c.spec.js` |
| 2026-07-06 | `node --check playwright-runner-artifacts\exports\case-278-m5c.spec.js` | 通过 | `playwright-runner-artifacts/exports/case-278-m5c.spec.js` |
| 2026-07-06 | `node src/export-pytest.js --case-id 278 --api-base http://127.0.0.1:4180/api --output playwright-runner-artifacts\exports\test_case_278_m5d.py` | 通过，生成 pytest 脚本 | `playwright-runner-artifacts/exports/test_case_278_m5d.py` |
| 2026-07-06 | `python -m py_compile playwright-runner-artifacts\exports\test_case_278_m5d.py` | 通过 | `playwright-runner-artifacts/exports/test_case_278_m5d.py` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283 --api-base http://127.0.0.1:4180/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-D 后批量回归仍全部 passed | `playwright-runner-artifacts/batches/batch-20260706-112435/` |
| 2026-07-06 | `node src/export-playwright.js --case-id 279 --api-base http://127.0.0.1:4181/api --output playwright-runner-artifacts\exports\case-279-m5e.spec.js` | 通过，表格/浮层用例导出 | `playwright-runner-artifacts/exports/case-279-m5e.spec.js` |
| 2026-07-06 | `node src/export-playwright.js --case-id 281 --api-base http://127.0.0.1:4181/api --output playwright-runner-artifacts\exports\case-281-m5e.spec.js` | 通过，iframe 用例导出 | `playwright-runner-artifacts/exports/case-281-m5e.spec.js` |
| 2026-07-06 | `node src/export-playwright.js --case-id 282 --api-base http://127.0.0.1:4181/api --output playwright-runner-artifacts\exports\case-282-m5e.spec.js` | 通过，树/多窗口用例导出 | `playwright-runner-artifacts/exports/case-282-m5e.spec.js` |
| 2026-07-06 | `node --check playwright-runner-artifacts\exports\case-279-m5e.spec.js` / `case-281-m5e.spec.js` / `case-282-m5e.spec.js` | 通过 | 对应 Playwright 导出文件 |
| 2026-07-06 | `node src/export-pytest.js --case-id 279/281/282 --api-base http://127.0.0.1:4181/api --output ...` | 通过，复杂定位 pytest 文件生成 | `playwright-runner-artifacts/exports/test_case_279_m5e.py` 等 |
| 2026-07-06 | `python -m py_compile playwright-runner-artifacts\exports\test_case_279_m5e.py` / `test_case_281_m5e.py` / `test_case_282_m5e.py` | 通过 | 对应 pytest 导出文件 |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283 --api-base http://127.0.0.1:4181/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-E 后批量回归仍全部 passed | `playwright-runner-artifacts/batches/batch-20260706-113640/` |
| 2026-07-06 | `node src/index.js --case-id 284 --api-base http://127.0.0.1:4182/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖请求 URL、method、body 断言 | `playwright-runner-artifacts/runs/284-20260706-115223/` |
| 2026-07-06 | `node src/index.js --case-id 279 --api-base http://127.0.0.1:4182/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，验证自定义 select 长页面回归修复 | `playwright-runner-artifacts/runs/279-20260706-115614/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284 --api-base http://127.0.0.1:4182/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-F 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-115636/` |
| 2026-07-06 | `node src/index.js --case-id 285 --api-base http://127.0.0.1:4183/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖延迟 mock 和请求数量断言 | `playwright-runner-artifacts/runs/285-20260706-150446/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285 --api-base http://127.0.0.1:4183/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-G 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-150618/` |
| 2026-07-06 | `node src/index.js --case-id 286 --api-base http://127.0.0.1:4184/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖响应 JSON 断言和 abort 失败注入专项验证 | `playwright-runner-artifacts/runs/286-20260706-151419/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286 --api-base http://127.0.0.1:4184/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-H 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-151442/` |
| 2026-07-06 | `node src/index.js --case-id 287 --api-base http://127.0.0.1:4185/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖响应快照文件化和页面渲染断言 | `playwright-runner-artifacts/runs/287-20260706-153416/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287 --api-base http://127.0.0.1:4185/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-I 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-153501/` |
| 2026-07-06 | `node src/index.js --case-id 288 --api-base http://127.0.0.1:4186/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖响应基线对比、快照和页面渲染断言 | `playwright-runner-artifacts/runs/288-20260706-155300/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288 --api-base http://127.0.0.1:4186/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-J 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-155505/` |
| 2026-07-06 | `node src/index.js --case-id 289 --api-base http://127.0.0.1:4187/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖类 HAR 回放、页面渲染断言和请求数量断言 | `playwright-runner-artifacts/runs/289-20260706-161227/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289 --api-base http://127.0.0.1:4187/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-K 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-161316/` |
| 2026-07-06 | `node src/index.js --case-id 290 --api-base http://127.0.0.1:4192/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖多文件上传、下载 MIME、大小、内容和 SHA256 校验 | `playwright-runner-artifacts/runs/290-20260706-175200/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290 --api-base http://127.0.0.1:4194/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-L 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-175358/` |
| 2026-07-06 | `npm run check` | 通过，M5-M 导出器源码语法检查通过 | 无 |
| 2026-07-06 | `node src/export-playwright.js --case-id 281/283/284/285/286/287/288/289/290 --api-base http://127.0.0.1:4197/api --output <temp>\case-*-m5m.spec.js` + `node --check <temp>\case-*-m5m.spec.js` | 通过，高级动作 Playwright spec 均可生成并通过语法检查 | `%TEMP%\cuecast-export-m5m-2\` |
| 2026-07-06 | `node src/export-pytest.js --case-id 281/283/284/285/286/287/288/289/290 --api-base http://127.0.0.1:4197/api --output <temp>\test_case_*_m5m.py` + `python -m py_compile <temp>\test_case_*_m5m.py` | 通过，高级动作 pytest 文件均可生成并通过 Python 编译检查 | `%TEMP%\cuecast-export-m5m-2\` |
| 2026-07-06 | `npm run check` | 通过，M5-N Runner 和导出器源码语法检查通过 | 无 |
| 2026-07-06 | `node --check ../sakura-cuecast/test-lab/mock-server.js` | 通过，case 291 seed 语法检查通过 | 无 |
| 2026-07-06 | `node src/index.js --case-id 291 --api-base http://127.0.0.1:4195/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，覆盖打开 popup、显式切回主页面、按 URL 切回 popup、关闭 popup 并回主页面 | `playwright-runner-artifacts/runs/291-20260706-184309/` |
| 2026-07-06 | `node src/export-playwright.js --case-id 291 --api-base http://127.0.0.1:4196/api --output <temp>\case-291-m5n.spec.js` + `node --check <temp>\case-291-m5n.spec.js` | 通过，多窗口增强 Playwright spec 可生成并通过语法检查 | `%TEMP%\cuecast-export-m5n\case-291-m5n.spec.js` |
| 2026-07-06 | `node src/export-pytest.js --case-id 291 --api-base http://127.0.0.1:4196/api --output <temp>\test_case_291_m5n.py` + `python -m py_compile <temp>\test_case_291_m5n.py` | 通过，多窗口增强 pytest 文件可生成并通过 Python 编译检查 | `%TEMP%\cuecast-export-m5n\test_case_291_m5n.py` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291 --api-base http://127.0.0.1:4197/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-N 后批量回归全部 passed | `playwright-runner-artifacts/batches/batch-20260706-184430/` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291 --api-base http://127.0.0.1:4198/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，收口复验 13 个 mock case 全部 passed | `playwright-runner-artifacts/batches/batch-20260706-203704/` |
| 2026-07-06 | `node src/batch.js --case-ids 292,293,294,295,296 --api-base http://127.0.0.1:4199/api --workers 1 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-O 五类专项新增 case 全部 passed | `playwright-runner-artifacts/batches/batch-20260706-212433/` |
| 2026-07-06 | `node src/index.js --case-id 296 --api-base http://127.0.0.1:4205/api --headed false --trace retain-on-failure --video retain-on-failure` | 通过，导出 smoke case 的 Runner 单跑通过 | `playwright-runner-artifacts/runs/296-20260706-213816/` |
| 2026-07-06 | `node src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4205/api --output tests/case-296-m5o-e2e.spec.js` + `node --check ...` + `npm exec -- playwright test case-296-m5o-e2e.spec.js --config playwright.config.js` | 通过，导出 Playwright spec 在标准 Playwright Test 项目内端到端执行 passed | `tests/case-296-m5o-e2e.spec.js` |
| 2026-07-06 | `node src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4206/api --output playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py` + `python -m py_compile ...` | 通过，pytest 导出 smoke 文件可编译 | `playwright-runner-artifacts/exports/test_case_296_m5o_e2e.py` |
| 2026-07-06 | `node src/batch.js --case-ids 278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296 --api-base http://127.0.0.1:4206/api --workers 2 --artifact-dir D:\King\sakura\sakura-playwright-artifacts` | 通过，M5-O 后 18 个 mock 成功集合全部 passed | `playwright-runner-artifacts/batches/batch-20260706-214030/` |
| 2026-07-06 | `node src/export-playwright.js --case-id 296 --api-base http://127.0.0.1:4207/api --storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json --output tests/case-296-m5o-storage.spec.js` + `node --check ...` + `npm exec -- playwright test case-296-m5o-storage.spec.js --config playwright.config.js` | 通过，Playwright 导出支持 storage state 并端到端执行 passed；导出文件包含 `CUECAST_START_URL`、`CUECAST_API_BASE`、`CUECAST_STORAGE_STATE` 参数入口 | `tests/case-296-m5o-storage.spec.js` |
| 2026-07-06 | `node src/export-pytest.js --case-id 296 --api-base http://127.0.0.1:4207/api --storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json --output playwright-runner-artifacts/exports/test_case_296_m5o_storage.py` + `python -m py_compile ...` | 通过，pytest 导出支持 browser context storage state 和环境参数化并可编译 | `playwright-runner-artifacts/exports/test_case_296_m5o_storage.py` |

### 验收记录

| 验收项 | 结果 | 说明 |
| --- | --- | --- |
| iframe 内定位可执行 | 通过 | case 281 step 1/2 的 `locator_source` 为 `frame:locator_meta.candidates[0]` |
| 文件上传可执行 | 通过 | case 281 step 3 记录 `uploaded_files` |
| 下载断言可执行 | 通过 | case 281 step 5 记录 `downloaded_file` 和 `downloaded_filename` |
| 多文件上传可执行 | 通过 | case 290 step 1 记录两个 `uploaded_files` |
| 高级下载校验可执行 | 通过 | case 290 step 3 记录 `downloaded_filename: "m5-advanced.txt"`、`downloaded_mime: "text/plain"`、`downloaded_bytes: 104` 和匹配的 `downloaded_sha256` |
| 页面 JSON 子集断言可执行 | 通过 | case 281 step 6 断言 `json-payload` |
| API JSON 子集断言可执行 | 通过 | case 281 step 7 的 `locator_source` 为 `api:assert_json` |
| Monaco/类 Monaco 输入可执行 | 通过 | case 282 step 1 输入后，step 2 断言编辑器状态 |
| 树组件文本语义定位可执行 | 通过 | case 282 step 3 的 `locator_source` 为 `tree:locator_meta.candidates[0]` |
| 多窗口基础切换可执行 | 通过 | case 282 step 5 记录 `opened_page_url`，后续步骤在 popup 内执行 |
| 多窗口显式切换可执行 | 通过 | case 291 step 3 切回 `target.html`，step 5 按 URL 切回 `popup.html`，均记录 `switched_page_url` 和 `switched_page_title` |
| 多窗口关闭并回退可执行 | 通过 | case 291 step 8 记录 `closed_page_url: popup.html`，并记录 `active_page_url: target.html` |
| 多 popup 选择和 fallback 可执行 | 通过 | case 292 覆盖 Alpha/Beta 两个 popup，按标题和 URL 切换，关闭 Beta 后 fallback 到 Alpha，再关闭回主页面 |
| 展开/复选树节点可执行 | 通过 | case 293 覆盖展开树节点后通过 `tree_item_text` 点击 `Ops Alerts` checkbox tree item |
| Monaco 多行输入和快捷键可执行 | 通过 | case 294 覆盖多行编辑内容和 `Control+S` 保存反馈 |
| 隐藏上传代理可执行 | 通过 | case 295 step 1 使用 `value.inputSelector` 指向隐藏 `input[type=file]`，结果记录 `upload_via_proxy: true` |
| 二进制下载校验可执行 | 通过 | case 295 step 3 覆盖 `.bin` 文件 MIME、大小和 SHA256 校验 |
| 网络 mock 可执行 | 通过 | case 283 step 1 记录 `network_mock_url` 和 `network_mock_status` |
| 类 HAR 回放可执行 | 通过 | case 289 step 1 记录 `network_replay_entries: 2`，step 4 记录 `request_count: 2` |
| POST API JSON 子集断言可执行 | 通过 | case 283 step 4 的 `locator_source` 为 `api:assert_json` |
| 请求断言可执行 | 通过 | case 284 step 1 记录 `request_url` 和 `request_method` |
| 请求数量断言可执行 | 通过 | case 285 step 6 记录 `request_count: 2` |
| 响应断言可执行 | 通过 | case 286 step 1 记录 `response_url` 和 `response_status: 200` |
| 失败注入专项 case 可执行 | 通过 | case 286 step 3 记录 `network_mock_abort: "failed"`，后续页面状态断言为 `Abort handled` |
| 响应快照文件化可执行 | 通过 | case 287 step 1 记录 `response_snapshot`、`response_snapshot_meta` 和 `response_body_bytes` |
| 响应基线对比可执行 | 通过 | case 288 step 1 记录 `response_baseline`、`response_baseline_mode: "exact"` 和 `response_baseline_matched: true` |
| Playwright 脚本导出可执行 | 通过 | case 278 导出 spec 并通过 `node --check` |
| pytest 脚本导出可执行 | 通过 | case 278 导出 `.py` 并通过 `python -m py_compile` |
| 复杂定位导出可执行 | 通过 | case 279/281/282 覆盖 table、frame、tree、text candidate 导出 |
| 高级动作 Playwright 导出可生成 | 通过 | case 281、283、284、285、286、287、288、289、290 覆盖下载、JSON、请求/响应、网络 mock/replay 和请求数量断言导出 |
| 高级动作 pytest 导出可生成 | 通过 | case 281、283、284、285、286、287、288、289、290 覆盖同一批高级动作并通过 `py_compile` |
| 多窗口增强 Playwright 导出可生成 | 通过 | case 291 覆盖 `switch_page` 和 `close_page` 导出并通过 `node --check` |
| 多窗口增强 pytest 导出可生成 | 通过 | case 291 覆盖 `switch_page` 和 `close_page` 导出并通过 `python -m py_compile` |
| 导出 Playwright spec 端到端可执行 | 通过 | case 296 导出到 `tests/case-296-m5o-e2e.spec.js` 后通过 `npm exec -- playwright test` |
| 专项 pytest 导出可编译 | 通过 | case 296 导出 pytest 文件后通过 `python -m py_compile` |
| Playwright 导出 storage state 可执行 | 通过 | case 296 使用 `--storage-state ../sakura-cuecast/test-lab/storage-states/m5o-storage-state.json` 导出后端到端 passed |
| Playwright/pytest 导出环境参数化可生成 | 通过 | 导出文件包含 `CUECAST_START_URL`、`CUECAST_API_BASE` 和 `CUECAST_STORAGE_STATE` 参数入口 |
| 前序通过集合未回归 | 通过 | 批量执行 `278,279,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296` 全部 passed |

### M5 遗留问题

- 多窗口/新标签页已覆盖点击打开 popup、按主页面/latest/index/URL/title 显式切换、关闭页面并 fallback、双 popup 标题/URL 选择；跨 browser context、更多 popup 并发策略和真实业务多窗口流程仍待补强。
- Monaco 编辑器当前覆盖类 Monaco 基础输入、多行输入和快捷键反馈；真实 Monaco 的复杂 IME、格式化、真实快捷键副作用和多光标场景尚未验证。
- 树组件语义定位当前覆盖基础文本节点、展开后 checkbox 节点；懒加载、虚拟树、复杂父子路径和批量展开/折叠语义仍待补强。
- 网络 mock 当前覆盖基础 route fulfill、类 HAR 回放、响应延迟、abort 失败注入专项 case、请求断言、响应断言、响应快照文件化、响应基线对比和请求数量断言；复杂网络时序仍待补强。
- 文件上传/下载当前覆盖基础场景、多文件上传、隐藏控件代理上传、下载 MIME/大小/SHA256 校验和二进制下载；下载更多元数据、大文件和上传前端代理链路仍待补强。
- Playwright/pytest 脚本导出已覆盖部分复杂 `locator_meta`、高级动作、多窗口增强动作语法生成、storage state、环境参数化和 Playwright spec 端到端 smoke；更大范围导出脚本等价性仍待补强。

### M5 阶段结论

结论：`部分通过`。

M5-A 至 M5-O 十五批高级能力已完成并通过本地 mock 验收；完整 M5 仍需继续按真实业务和更复杂组件专项推进。

## M6：admin 平台单用例 Runner 入口

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| admin Runner Job 创建/查询/取消 API | 已实现 | admin 异步启动 `src/index.js`，受权限保护并限制并发数 |
| admin-ui Runner 回放入口 | 已实现 | 场景编辑页选择用例后点击“Playwright Runner 回放”，轮询任务并刷新执行历史 |
| admin 认证结果回传 | 已实现 | 后台将当前登录用户 Bearer Token 和批次短期 execution capability 注入 Runner；带批次的读取和回传使用 capability 限定当前执行范围 |
| 用例/步骤结果展示 | 已实现 | Runner `raw.steps`、扩展 `case_result.steps` 均写入 admin 执行记录 |
| 结构化实时日志 | 已实现 | Runner stdout 发送带时间、级别、阶段和详略标记的事件，admin-ui 支持简洁/详细切换和自动跟随 |
| Runner 实时画面 | 已实现 | Runner 每秒上传最新 JPEG，admin-ui 轮询 Job 内存中的最新帧；终态短暂保留最后一帧且不进入 `caseList/debugRecord` |
| 历史日志 artifact | 已实现 | 执行完成后上传 `execution-log.json`，服务重启后仍可回看 |

### M6 环境要求

- admin 服务所在节点安装 Node.js 和 Playwright 浏览器依赖。
- 配置 `SAKURA_PLAYWRIGHT_RUNNER_ROOT` 指向 `sakura-playwright` 仓库根目录。
- 在 `.env` 配置 `SAKURA_ADMIN_API_BASE`、`SAKURA_ADMIN_API=true` 和回放运行参数；旧版 `CUECAST_API_BASE`、`CUECAST_ADMIN_API` 仍兼容。
- 当前 M6 支持单用例回放；原有 Jenkins 场景/计划执行链路保持不变。

### M6 回放失败定位补充（2026-07-15）

- 修复 admin 从不同 `user.dir` 启动时 Runner 相对目录解析错误；默认会探测工作区根目录、模块目录及其上级目录，并校验 `src/index.js`。
- 平台入口默认使用 `headed=false`，避免后台服务或 Jenkins 节点没有桌面会话导致浏览器启动失败。
- 页面展示 Runner 最近输出，包含实际 `runnerRoot`、`runnerConfig`、启动参数和 Node/Playwright/API 错误；执行失败时结果回传失败也会标记为失败。
- admin Runner 产物目录按 `runs/<projectShortName>/<versionName>/<sceneId>/<caseId>/<yyyyMMdd>/<executionId>/` 分层保存，末级目录与执行历史的用例执行 ID 一致；未传 `--run-id` 的旧 CLI 仍使用 `HHmmss`。
- Runner 弹窗配置名称已改为中文，底部按 Jenkins 模板展示场景 ID、场景名称、执行状态、上次结果、运行耗时和构建号；Jenkins 组件与执行链路未改动。
- CDP/Runner 生成、admin 任务状态和 `debugRecord/playwrightResult` 顶层及嵌套执行时间已统一为北京时间 `yyyy-MM-dd HH:mm:ss`；旧 UTC ISO 时间由后端在入库前递归兼容转换。
- Runner 读取用例和回传结果使用 `/testcases/{sceneKey}/{caseId}` 双路径兼容入口，避免 `%3A` 编码导致 Spring 路由 404。
- Runner 的 `SAKURA_ADMIN_API_BASE` 使用 Spring 后端直连地址，不附加前端开发代理使用的 `/api` 前缀；该地址和浏览器、无头模式、产物、trace/video、HTTPS 证书策略均由 `.env` 统一提供。旧版 `CUECAST_API_BASE` 仍兼容。
- 内部自签名 HTTPS 测试站点可在 Runner `.env` 设置 `RUNNER_IGNORE_HTTPS_ERRORS=true`；公网生产环境应保持为 `false` 并修复证书链。
- admin 后端代码变更后必须重启后端；若 `/api/automation/playwright/runner/jobs` 返回 `404`，说明当前进程仍是旧版本。

验证：`mvn -pl continew-automation -am -DskipTests compile`、`npm run typecheck`、`npm run build`、`npm run check` 均通过。

### M6 执行日志与实时画面补充（2026-07-18）

- admin Job API 保留原 `outputTail`，新增最多 500 条结构化日志；批次详细结果合并时保留 `job_id`。
- 步骤日志按一基序号展示，并优先使用 admin `StepDO.name`；原始 `playwright_step` 仅在响应层补齐缺失的序号和名称，不回写存储数据。
- 实时帧上传限制为 JPEG，单帧上限由质量档位控制，只覆盖任务内存中的上一帧；任务结束或取消后保留最后一帧 30 秒，服务关闭时立即清理。
- admin-ui 使用 Bearer Header 定时读取最新 JPEG，不把登录令牌放入 URL；关闭抽屉或切换用例会停止轮询并释放 Blob URL。
- Jenkins 和 Extension CDP 的日志、报告与录屏入口保持原行为。

### UI 自动化全操作执行详情统一展示 Phase A（2026-08-06）

- 操作目录已增加统一诊断 profile 映射，覆盖 13 类、62 个操作方法；Admin 加载目录时校验覆盖完整性、重复项和非法 profile。
- Playwright Runner 新增 `details.operation` 通用执行摘要，保留既有 `details.infrastructure`、`details.variable`、`details.variable_references` 和定位诊断，不替换原有类型化结果。
- 执行摘要按白名单输出方法身份、配置值、运行时生效值、目标摘要和结果事实；敏感值脱敏，SQL、命令、脚本和路径不输出原文或完整路径。
- Admin 执行详情页已接入统一摘要，并兼容没有新摘要的历史执行记录；数据库/服务器原有结果面板继续独立展示。
- 验证通过：Runner `npm run check`、`npm run test:unit`（62/62），Admin `mvn -pl continew-automation -am -DskipTests compile`，admin-ui `pnpm typecheck`、定向 ESLint 和 `pnpm build:prod`。

### M6 实时画面质量档位补充（2026-07-19）

- `Playwright Runner 配置` 在浏览器右侧新增实时画面质量下拉框，提供流畅、高清、超清和 8K 四档，平台默认选择高清。
- admin 只接受白名单质量值，并按档位把单帧内存上限控制为 2MB、4MB、8MB 或 16MB；旧请求未传档位时继续使用原流畅配置。
- Runner 按档位设置设备像素倍率、JPEG 质量和截图间隔；有头最大化模式保持实际浏览器窗口分辨率，避免违反 Playwright 的 `viewport=null` 限制。
- admin-ui 实时画面轮询调整为 1 秒，关闭查看器后仍会停止轮询并释放 Blob URL；Jenkins 与 Extension CDP 链路不变。
- 验证通过：Runner `npm run check`、`npm run test:unit`，admin `mvn -pl continew-automation -am -DskipTests compile`，admin-ui `pnpm typecheck`、定向 ESLint 和 `pnpm build:prod`。

### M6 CueCast 录制变量与元素断言适配（2026-08-07）

- Runner 在 `case-loader` 边界把 CueCast 原始 `set_variable` 和带断言元数据的 `assert_text` 转换为运行时副本；Admin 中的 `playwright_step`、`locator_meta` 和 `{{name}}` 原文不回写、不迁移。
- `global_variable_set` 支持 locator 运行时取值、正则分组 0 和明确的抽取错误；变量上下文同时支持规范 `${name}` 与 CueCast `{{name}}` 语法。
- 新增统一动作 `assert_element_match`，覆盖 `contains`、`equals`、`not_contains`、`regex`、`visible`，并按 `auto/text/value` 读取页面元素。
- 操作目录同步升级为 `2026-08-07.1`、63 个方法，Runner 能力注册和统一诊断详情已覆盖新增方法。
- Playwright 与 Pytest 导出器生成等价的运行时变量和五种元素断言代码；导出测试会执行生成后的两个脚本，而不只做文本或语法检查。
- 新增 case 298 集成测试，直接读取 CueCast `test-lab/mock-data/cases.json`，通过内存 API 和真实 Chromium 执行 8 个原始录制步骤，不改写 mock 数据。
- 跨执行器验收通过：Admin 定向测试 41/41，CueCast 契约 24/24，Selenium 目录/诊断/语义及真实 Chrome 测试 9/9，Execution Agent 目录夹具 1/1。

验证结果：`npm run check` 通过，`npm run test:unit` 79/79 通过，`npm run test:locator` 13/13 通过，`npm run test:export` 1/1 通过。
