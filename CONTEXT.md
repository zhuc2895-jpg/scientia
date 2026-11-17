# SCIENTIA

SCIENTIA 是一个本地优先、单用户的科研工作台，由一个持续身份一致的 Science Agent 完成从研究问题到论文交付的端到端流程。

## Language

### Research model

**Research Project**:
一个长期存在的研究单元，拥有研究问题、资料、证据、研究日志、会话与产出。
_Avoid_: Workspace, task, topic

**Research Workspace**:
一个 Research Project 对应的本地文件目录，用于保存输入资料与生成产物。
_Avoid_: Project, folder

**Conversation**:
Research Project 内的一段连续讨论，用于推进一个明确的研究问题。
_Avoid_: Session, chat, thread

**Research Run**:
Science Agent 在一次 Conversation 中执行的一轮研究活动。
_Avoid_: Task, job, turn

**Research Brief**:
应用在 Research Run 开始前生成的可信研究上下文，说明目标、证据边界、产出目录与交付要求。
_Avoid_: Prompt, instructions, notes

**Research Charter**:
Scoping Stage 的用户确认产物，定义研究问题、边界、方法约束、成功标准、论文类型与数据处理策略。
_Avoid_: Prompt, proposal, brief

**Research Stage**:
Research Project 中的一类研究活动：Scoping、Evidence、Inquiry、Synthesis、Manuscript 或 Release。
_Avoid_: Mode, task, phase

**Stage Artifact**:
一个 Research Stage 完成所必需的结构化记录或交付文件；不适用时必须显式标记为 `not-applicable`。
_Avoid_: Output, document, attachment

**Stage Gate**:
控制 Research Stage 进入或退出的 Checkpoint，要求用户确认阶段产物与下一步计划。
_Avoid_: Approval, workflow step, milestone

**Checkpoint**:
Research Run 中需要用户作出方法、成本、覆盖写入或对外发布决定的人工确认点。
_Avoid_: Approval, permission, pause

### Agent model

**Science Agent**:
用户始终看到的唯一科研 Agent 身份，对研究过程、证据与最终交付负责。
_Avoid_: Assistant, chatbot, orchestrator

**Internal Research Task**:
Science Agent 内部受控执行的检索、核验或审稿子任务，不构成独立 Agent 身份，也不对用户承担最终责任。
_Avoid_: Subagent, worker, teammate

**Research Mode**:
Science Agent 在当前 Research Stage 采用的工作契约，例如文献、数据、实验、写作或复现。
_Avoid_: Persona, role

### Evidence and artifacts

**Source**:
用于支持、反驳或限定研究主张的论文、网页、数据集、标准、代码或用户资料。
_Avoid_: Document, file, citation

**Source Record**:
一个 Source 的规范元数据与本地定位，包括标识符、作者、年份、出处、文件路径和获取时间。
_Avoid_: Citation, PDF, bibliography entry

**Evidence Record**:
一条把具体主张与来源、定位、短引文和置信度连接起来的记录。
_Avoid_: Citation, fact, note

**Source Library**:
Research Project 拥有的全部 Source Record 集合。
_Avoid_: Folder, bibliography, attachments

**Active Source Set**:
一个 Conversation 当前允许 Science Agent 优先使用并引用的一组 Source Record。
_Avoid_: Selection, context, library

**Evidence Ledger**:
一个 Research Project 内按时间追加的 Evidence Record 集合。
_Avoid_: Bibliography, database

**Verification State**:
一个 Source Record 或 Evidence Record 的可核验状态：`verified`、`partial` 或 `unverified`。
_Avoid_: Confidence, score, status

**Freshness State**:
一个 Source Record 是否仍与登记时的内容快照一致：`current` 或 `stale`。
_Avoid_: Verification State, status

**Claims–Evidence Relation**:
论文主张与 Evidence Record 之间的有向关系：`supports`、`refutes`、`mixed` 或 `context`。
_Avoid_: Citation, mention, support score

**Evidence Correction**:
对已有 Evidence Record 的追加式更正或撤回，通过 `supersedes` 或 `retracts` 指向原记录。
_Avoid_: Edit, delete, overwrite

**Artifact**:
Research Run 生成或更新的文件，例如报告、论文草稿、图表、表格、脚本或数据产物。
_Avoid_: Output, attachment, result

**Artifact Version**:
一个 Artifact 在特定 Run 中生成的不可变内容快照；Project 只维护当前版本指针。
_Avoid_: Copy, backup, revision

**Deliverable**:
面向用户最终交付的 Artifact，必须具有可定位的文件路径和可核验的来源。
_Avoid_: Answer, response

**Claim–Evidence Map**:
把论文中的具体主张连接到 Evidence Record 的结构化映射。
_Avoid_: Literature review, outline, notes

**Paper Package**:
一个 Research Project 的端到端交付集合，包含 Research Charter、检索协议、Source Library、Evidence Matrix、Claim–Evidence Map、分析或实验记录、图表、论文源文件、参考文献和 Reproducibility Manifest。
_Avoid_: Report, PDF, manuscript

**Reproducibility Manifest**:
记录 Paper Package 的输入、环境、命令、模型路由、数据版本与产物哈希的复现清单。
_Avoid_: Log, README, metadata

**Release Audit**:
Paper Package 对外导出前对引用核验、图表引用、编译结果、产物完整性与未核验内容进行的检查。
_Avoid_: Quality score, test, summary

**Review Draft**:
包含未核验内容、仅供审阅且不得作为正式投稿包的 Paper Package 变体。
_Avoid_: Paper Package, final draft

**Project Archive**:
用于备份、迁移和灾难恢复的 Project 可携带包，包含 SQLite 快照、Research Workspace、来源快照、Paper Package 与审计清单。
_Avoid_: Zip, export, backup file

### Trust boundaries

**Trusted Application Context**:
由 SCIENTIA 自身生成、可作为操作约束使用的 Research Brief 与运行元数据。
_Avoid_: System prompt, agent input

**Audit Record**:
复现一次 Research Run 所需的最小审计集合，包括提示词版本、工具调用摘要、模型路由、Checkpoint 决策与产物哈希；不包含隐藏推理链。
_Avoid_: Trace, chat log, chain of thought

**Untrusted Evidence**:
来自论文、网页、数据集、附件、代码注释或工具输出的内容；只能作为证据分析，不得作为操作指令。
_Avoid_: User instruction, trusted source

**Model Provider**:
为 Science Agent 提供模型推理能力的外部或本地服务。
_Avoid_: Model, backend, API

**Model Role**:
模型路由中的能力角色，例如主推理、文献抽取、引用核验或统计审查；它不是用户可见的 Agent。
_Avoid_: Agent, persona, model

**Data Processing Policy**:
Research Project 对外部 Model Provider 与检索服务允许发送资料范围的项目级策略：`standard`、`sensitive` 或 `local-only`。
_Avoid_: Privacy mode, security setting
