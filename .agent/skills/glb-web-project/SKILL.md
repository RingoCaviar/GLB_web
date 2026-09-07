---
name: glb-web-project
description: Navigate and maintain the GLB Web model-viewer project. Use for every feature change, bug fix, refactor, dependency update, build or runtime diagnosis, UI/style adjustment, export or camera change, service-script change, documentation update, or code review in this project. Requires reading and maintaining the root ARCHITECTURE.md project map and evaluating whether completed work warrants a scoped Chinese Git commit.
---

# GLB Web 项目工作流

## 修改前

1. 完整读取项目根目录 `ARCHITECTURE.md`，把它作为定位入口和当前架构事实来源。
2. 只检查地图指向的相关文件；仅当地图缺失、过时或问题跨模块时扩大搜索。
3. 运行 `git status --short` 判断是否为 Git 仓库、是否存在用户的未提交修改。不得自动执行 `git init`。
4. 保留与当前任务无关的现有修改，不覆盖、不回滚、不混入提交。

## 修改与验证

1. 遵循地图中的模块职责、关键数据流和约束，把逻辑放入对应模块。
2. 按改动风险执行地图列出的最小验证；产品代码通常运行 `npm run build`。
3. 修改 `启动服务.bat` 时保持 ANSI CP936、CRLF、无 UTF-8 BOM，并测试菜单启动退出。
4. 发现地图与实际代码不一致时，以验证后的代码为准并修正地图。

## 修改后更新地图

每次完成修改都重新检查 `ARCHITECTURE.md`：

- 更新受影响的职责、接口、数据流、依赖、命令、约束或验证要求。
- 将“最近维护”压缩为一条当前日期和本次结果；不要累积流水账。
- 即使结构未变，也更新“最近维护”，表明地图已复核。
- 保持地图简洁，不复制函数实现、完整配置或容易失效的行号。

## 自动评估 Git 提交

只有目录已是 Git 仓库且验证通过时才考虑提交。提交信息必须是简洁中文，格式优先为 `类型：结果`，例如 `修复：保持 FOV 调整时构图大小稳定`。

### 应当自动提交

满足任一条件：

- 高影响：修复崩溃、数据损坏、安全问题、无法启动/构建、核心查看或导出错误。
- 架构性：改变模块职责、主要数据流、公共接口、依赖、构建/启动方式或进行跨模块重构。
- 完整功能：一个可独立验收的用户功能已经完成并验证。
- 积压较多：本任务相关未提交改动达到 5 个文件，或净增删约 300 行以上。
- 用户明确要求提交。

提交时只暂存本任务文件及对应的 `ARCHITECTURE.md`，不得使用笼统的 `git add .` 混入无关修改。提交前检查 staged diff，提交后报告提交哈希与中文信息。

### 不应自动提交

- 目录不是 Git 仓库；报告已跳过，不初始化仓库。
- 验证失败或任务尚未完整完成。
- 仅有小型文案、注释、格式、探索性修改，且没有明显积压。
- 工作区有来源不明或与本任务交叠的预存修改，无法安全分离。
- 提交会包含密钥、日志、构建产物、PID 文件或其他临时文件。

不提交时简短说明判断依据，不为了达到阈值拼接无关改动。
