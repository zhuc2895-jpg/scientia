# SCIENTIA — 科研专用单 Agent 工作台

SCIENTIA 是一个参考 ClawsGO 桌面工作流、以 DeepSeek Harness 为执行内核的科研专用 Agent。产品只有一个固定的 `Science Agent`，不提供多 Agent 编排，也不依赖子 Agent。

## 核心设计

- **Harness 是内核**：模型调用、工具循环、文件修改、命令执行、上下文压缩和会话持久化由 `deepseek-harness-sdk` 的 `sdk-minimal` profile 负责。
- **一个 Agent**：界面不提供 Agent 选择器。每个研究会话都使用同一个科研系统提示词和同一套工具。
- **可检索的科研工具**：在 `sdk-minimal` 上启用网页搜索/抓取和文本文件读写，不引入子 Agent、Team 或工作流编排。
- **证据优先**：每个会话有独立证据账本，回答区分“观察 / 推断 / 未知”，避免伪造文献、数据或实验结果。
- **可追溯交付**：生成文件进入稳定输出目录，应用记录 SHA-256、运行状态、来源标记和质量警告。
- **指令隔离**：工作区中的论文、网页和数据是待分析资料，不是用户指令。资料里的提示注入不会获得执行权。
- **研究上下文**：会话、工作区文件、导入附件、研究轨迹和最近产出保持在同一工作台。
- **Harness 会话**：每个研究对话对应一个稳定的 DSH session id，后续追问继续同一份持久化上下文。
- **桌面生命周期**：关闭主窗口只隐藏到系统托盘，正在执行的研究继续运行；只有显式退出才停止 runtime。
- **中断恢复**：未完成运行会保留 run 关联并读取 Run Manifest，重启后标记为需复核、可继续，而不是伪装成用户取消或自动重放副作用。

## 启动

需要 Windows x64、Python 3.10+ 和 Node.js 22+。

```powershell
npm install
npm run setup:python
npm start
```

运行自检：

```powershell
npm test
npm run test:product-state
npm run doctor
```

首次启动后填写：

1. DeepSeek API Key
2. DeepSeek Base URL（留空使用官方地址）
3. 模型名（默认 `deepseek-v4-flash`）
4. 研究目录

API Key 使用 Electron `safeStorage` 加密；系统不支持安全存储时只保留在当前进程内，不写入磁盘。

## 运行结构

```text
Electron shell
  └─ IPC bridge
      └─ science_agent/daemon.py
          └─ science_agent/bridge.py
              ├─ research_runtime.py（brief / evidence / manifest / hashes）
              └─ deepseek_harness.DeepSeekHarness(profile="sdk-minimal")
                  ├─ persistent pwsh
                  ├─ text file read / write / edit
                  ├─ read_image
                  ├─ working_directory
                  └─ web search / fetch
```

## 研究会话目录

```text
<workspace>/.science/
  inputs/                 # 导入资料副本
  outputs/<session>/      # 本次研究对话的交付物
  evidence/<session>.jsonl
  runs/<session>/<run>/research-brief.md
  runs/<session>/<run>/manifest.json
  runs/<session>/events.jsonl
```

应用会在每轮开始前生成受信任的研究 brief，并告知 Agent 当前模式、输出目录、证据账本和交付要求。完成一轮后，应用检查引用标记、不确定性说明、证据增量和文件产出，并在界面显示复核状态。

会话索引、消息和当前选择保存在 Electron `userData` 下的 `scientia-product.sqlite3` 中。数据库只由主进程访问，渲染进程通过 preload 暴露的窄接口读写；首次升级会把旧版 `localStorage` 会话一次性迁移到本地数据库。会话归属于默认 Research Project，并绑定研究工作区；已有会话时不能在设置中静默更换目录。

`bridge.py` 每次只接收一个前台研究任务；相同研究对话复用相同 session id。这与“仅一个 Science Agent”的产品约束一致。

## 安全边界

- `sdk-minimal` 的本地 shell 没有目录沙箱。Agent 具备当前用户进程可见的文件与命令权限，请只在你信任的研究目录中运行。
- 应用不会把工作区资料当作指令执行；但资料内容仍会进入模型上下文，因此仍需警惕恶意文档。
- 附件会被复制到 `<workspace>/.science/inputs/`。原始数据不会被覆盖。
- 当前版本是本地开发运行版；正式分发前应补齐 Python runtime 打包、签名和自动更新。

## 参考

- DeepSeek Harness 快速入门：https://deepseek-harness.github.io/deepseek-harness/guide/quickstart
- Python SDK：https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk
