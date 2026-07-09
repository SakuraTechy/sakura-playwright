# AGENTS.md

本文件是仓库级协作规则，适用于整个 `sakura-playwright` 项目。除非更深层目录存在新的 `AGENTS.md`，否则所有代码修改、文档编写、测试验证都应遵守本文件。

## 最高优先级规则

- 默认禁止改动 `cuecast/` 目录下的任何文件。
- 只有当用户在当前对话中明确要求修改 Chrome 扩展本身时，才可以新增、编辑、删除或格式化 `cuecast/` 下的文件。
- 不得通过批量脚本、格式化工具或自动迁移间接改动 `cuecast/`。
- 项目文档默认使用中文书写。
- 不要提交 token、私有 API 地址、生成产物或本地浏览器 profile。

## 项目结构

- `cuecast/`：Manifest V3 Chrome 扩展，用于录制和回放 UI 测试用例。默认只读，不要改动。
- `playwright-runner/`：Node.js ESM Playwright Runner，用于执行 CueCast 录制的步骤。源码位于 `playwright-runner/src/`。
- `test-lab/`：本地 mock 应用和 mock API，用于开发、调试和 Runner 验证。种子用例数据位于 `test-lab/mock-data/cases.json`。
- `docs/`：方案设计、实现说明、操作手册和阶段完成记录。
- `playwright-runner-artifacts/`：Runner 生成产物目录，不作为源码维护。

## 常用命令

除非特别说明，命令都从仓库根目录执行。

```bash
npm --prefix playwright-runner install
npm --prefix playwright-runner exec playwright install chromium
node test-lab/mock-server.js --port 4173
npm --prefix playwright-runner run check
node playwright-runner/src/index.js --case-id 278 --api-base http://127.0.0.1:4173/api --headed false
```

- `npm --prefix playwright-runner install`：安装 Runner 依赖。
- `npm --prefix playwright-runner exec playwright install chromium`：安装本地执行所需的 Chromium。
- `node test-lab/mock-server.js --port 4173`：启动 mock UI 和 API，访问地址为 `http://127.0.0.1:4173/`。
- `npm --prefix playwright-runner run check`：检查 Runner 源码语法。
- `node playwright-runner/src/index.js`：执行指定用例并生成执行产物。

## 代码风格

- JavaScript 使用两个空格缩进、分号和单引号。
- Runner 使用 ESM `import` / `export`，目标运行环境为 Node.js 20+。
- 文件名优先使用 kebab-case，例如 `step-runner.js`。
- 函数和变量使用 camelCase。
- 优先遵循现有代码风格和模块边界，不做无关重构。

## 文档规则

- README、`docs/` 文档、操作手册、阶段完成记录和功能使用说明默认使用中文。
- 命令、文件路径、环境变量名、API 名称、代码标识符和上游专有术语，可以保留原文。
- 文档要面向人工可操作，说明环境要求、配置位置、执行命令、验证方式、产物路径和常见注意事项。

## 测试要求

- 提交变更前至少运行 `npm --prefix playwright-runner run check`。
- 涉及 Runner 回放能力时，需要结合 mock lab 验证 case `278` 或相关新增用例。
- 新增步骤行为时，应在 `test-lab/mock-data/cases.json` 中补充 mock 用例。
- 验证执行结果时，检查 `result.json`、截图、trace、video 或 batch summary。
- 每个阶段完成后，更新对应阶段完成记录，方便对比方案和验收结果。

## 配置与安全

- Runner 本地配置优先放在 `playwright-runner/.env`。
- 可提交示例配置 `playwright-runner/.env.example`，不要提交真实 token。
- 真实环境变量、账号信息、登录态文件和浏览器 profile 不应进入 Git。
- `cuecast/manifest.json` 权限应保持收敛；如果用户明确要求修改扩展权限，需要在文档或 PR 说明原因和影响范围。

## 提交与 Pull Request

- 提交信息使用清晰的祈使句，例如 `Add locator fallback handling`。
- Pull Request 需要说明行为变化、验证命令、相关 issue，以及涉及 UI、录制器或回放效果时的截图或产物路径。
