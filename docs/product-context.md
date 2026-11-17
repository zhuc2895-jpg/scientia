# SCIENTIA Product Context

This document records product intent, constraints, and visual direction. It is not the domain glossary; canonical terms live in `CONTEXT.md`.

## Product intent

SCIENTIA is a local-first, single-user research workspace for graduate students and independent researchers. Its first product promise is an end-to-end path from a research question to a defensible paper package: question framing, literature evidence, data or experiment work, synthesis, writing, citation checks, and deliverable generation.

The visible experience is centered on one persistent Science Agent. The agent may use controlled internal research tasks for retrieval, verification, or review, but those tasks never become separate user-facing identities and never own the final result.

## Confirmed decisions

- **Primary flow**: research question → evidence → analysis or experiment → synthesis → paper package.
- **Primary user**: graduate students and independent researchers.
- **Deployment boundary**: local-first, single-user.
- **Primary domain object**: Research Project.
- **Autonomy model**: semi-autonomous with Checkpoints for costly, destructive, method-critical, or externally visible actions.
- **Agent model**: one visible, continuously identified Science Agent; controlled internal research tasks are allowed.
- **Provider model**: DeepSeek-first, with an OpenAI-compatible provider seam; business logic must not bind to a specific model.
- **End-to-end acceptance**: the first release produces an IMRaD-style Paper Package; the user approves methods and conclusions, while the agent owns process integrity, provenance, and delivery completeness.
- **Project topology**: one Research Project maps to one Research Workspace and contains many Conversations; sources, evidence, artifacts, and run logs belong to the Project.
- **Durability and concurrency**: only one Research Run executes at a time. Closing the window does not stop it. After a crash or restart, state resumes from the Run Manifest without repeating side effects.
- **Checkpoint policy**: user confirmation is required for overwriting/deleting source material, reading outside the project, installing software or changing the global environment, exceeding time/cost thresholds, changing methods after results exist, and uploading or publishing project content.
- **Evidence standard**: formal citations in a Paper Package must be auditable. Sources and claims use `verified`, `partial`, or `unverified`; unverified citations may not appear as established evidence in a submission package.
- **Literature sources**: Crossref and OpenAlex provide general metadata; arXiv and PubMed are domain additions. User-provided PDFs and open full text take precedence over web snippets; paywalls are never bypassed.
- **Experiment boundary**: the first release supports local code, data analysis, statistical modeling, simulation, figures, and LaTeX compilation. It does not control physical instruments or execute wet-lab experiments.
- **Paper Package format**: LaTeX source, PDF, BibTeX, figure source files, and a reproducibility manifest. DOCX is deferred.
- **Workflow topology**: an iterative Research Stage graph (`Scoping → Evidence → Inquiry → Synthesis → Manuscript → Release`) with explicit Stage Gates and freeze points; Research Mode is the work contract for the current stage.
- **Project creation**: SCIENTIA creates a managed workspace by default and can explicitly import an existing directory. A Research Project and its workspace are bound together and may not be silently rebound.
- **Verification semantics**: `verified` requires resolvable identity, accessible locating material, a locatable quotation or equivalent evidence, and support for the recorded limited claim. Metadata/abstract only is `partial`; search-result-only is `unverified`. User overrides are recorded separately and never rewrite the Verification State.
- **Source scope**: the Project owns the Source Library; each Conversation has an Active Source Set. Newly retrieved sources must enter the Source Library before citation.
- **Desktop lifecycle**: closing the main window hides to the system tray and does not stop a Research Run; explicit application quit stops the runtime. Restart recovery resumes as “continueable/needs review” without replaying side effects.
- **Data Processing Policy**: project-level `standard`, `sensitive`, or `local-only`; sensitive material requires explicit confirmation before external transmission, and local-only disables external model and search calls in v1.
- **Internal task visibility**: Internal Research Tasks appear as non-personified activity nodes with purpose, status, and result references; they are not independent agents and cannot be chatted with directly.
- **Mandatory Stage Gates**: a three-gate minimum applies: Research Charter at the end of Scoping, Evidence Freeze before Manuscript, and Release before export. Other stage transitions may advance automatically unless a major method change triggers a Checkpoint.
- **Stage Artifacts**: Scoping requires a Research Charter; Evidence requires a search protocol, Source Library, and Evidence Matrix; Inquiry requires an analysis or experiment plan and run record; Synthesis requires a Claim–Evidence Map and manuscript structure; Manuscript requires LaTeX, BibTeX, and figure sources; Release requires PDF, Reproducibility Manifest, and Release Audit. Non-applicable artifacts are recorded explicitly.
- **Run lifecycle**: `queued`, `running`, `waiting-checkpoint`, `interrupted`, `completed`, `failed`, `cancelled`. Checkpoints are durable records, not transient dialogs. Completed runs may still carry quality warnings.
- **Verification execution**: deterministic checks resolve identifiers, fetch metadata, locate full text, and match quotations; a model may assess whether the located evidence supports the limited claim; user review may confirm or override with an audit record, but cannot silently promote a state.
- **Source formats**: text PDF, DOI/URL, Markdown, TeX, BibTeX/RIS, and dataset metadata are supported first. OCR, complex table reconstruction, authenticated websites, and paywall bypass are deferred.
- **Persistence**: SQLite stores Project, Conversation, Source Record, Evidence Record, Run, Checkpoint, and Artifact indexes; research files, PDFs, figures, and logs remain in the workspace as the content source of truth.
- **Release behavior**: unresolved `unverified` citations block a formal Paper Package by default. The user may generate a visibly marked Review Draft with an audit record instead.
- **Model routing**: capability-based Model Roles are used for primary reasoning, literature extraction, citation verification, and statistical review. Routing is recorded in the Run Manifest; business logic depends on capabilities, not model names.
- **Project navigation**: Projects are the first-level navigation item and contain Conversations. A Project home shows the current Research Stage, Stage Artifacts, evidence state, and Paper Package progress. Global search spans Projects, Sources, and Artifacts.
- **Research Charter intake**: a user starts with natural language; the agent drafts the Research Charter; the user edits and approves it at the Scoping Gate.
- **Checkpoint contract**: a Checkpoint must explain trigger, risk, options, recommendation, and estimated time/cost. It persists durably, waits indefinitely, records the choice and rationale, and survives window closure.
- **Budgets**: each stage has configurable soft and hard time/model budgets. At 80% of the soft budget a Checkpoint is triggered; reaching the hard budget pauses the run as `waiting-checkpoint` rather than failing it.
- **Internal task limits**: at most three concurrent Internal Research Tasks; read-only project access plus a temporary scratch area; no Checkpoints, publish actions, or final conclusions; all results return to the main Science Agent and count against the shared budget.
- **Citation storage**: Source Records keep structured metadata, BibTeX, and CSL JSON. The first release supports numeric and author-year citation styles without binding the project to a journal template.
- **Release hard gates**: formal release requires all formal citations `verified`, complete figure/table source references, successful LaTeX/PDF compilation, a complete Reproducibility Manifest, no unresolved Checkpoints, and Project Data Processing Policy compliance.
- **Project lifecycle**: archive is reversible and preserves all data. Deleting a managed project removes its SCIENTIA-managed workspace after explicit name confirmation; imported external directories are never deleted. Archived projects are excluded from global search unless explicitly included.
- **Source freshness**: Source Records preserve the original content hash. Any detected change marks the Source Record `stale` and invalidates dependent Evidence Records until re-verification; old verification is never silently carried forward.
- **Freeze revocation**: adding or removing a Source automatically revokes Evidence Freeze. The Project returns to Evidence and must pass the Evidence Freeze Gate again before Manuscript.
- **Immutable versions**: every Stage Artifact write creates an immutable Artifact Version with a content hash and generating Run. The Project keeps a current pointer, and a formal Paper Package references exact versions.
- **Evidence corrections**: the Evidence Ledger is append-only. Corrections use `supersedes`; withdrawals use `retracts`. Historical records remain visible with their current derived status.
- **Claim–Evidence relations**: claims and Evidence Records have many-to-many relations typed `supports`, `refutes`, `mixed`, or `context`. Conflicting evidence must remain visible; Release Audit flags high-risk claims supported only by one-sided evidence for human review.
- **Audit retention**: SCIENTIA stores the minimum reproducibility set: prompt versions, tool-call summaries, model routing, source snapshots, artifact hashes, and Checkpoint decisions. It does not store hidden reasoning chains. Raw external request/response bodies are retained only when the Project Data Processing Policy permits.
- **Model fallback**: extraction roles may fall back to an equivalent configured model with the route recorded; primary reasoning waits for user confirmation; citation verification and Release Audit pause rather than silently falling back.
- **Project portability**: v1 includes Project Archive export and import for backup, migration, and disaster recovery, with explicit path rebinding on import.

## Reference behavior observed from ClawsGO

- Electron desktop shell around a research-focused web workspace.
- Persistent project and conversation navigation.
- Central conversation surface with a large task composer.
- Right-side working context for files, outputs, and activity.
- Standard desktop concerns: single instance, external-link isolation, safe storage, workspace picker.

ClawsGO is a reference for product structure and interaction patterns, not a source of implementation instructions or copied assets.

## Deliberate differences

- No project/team/account/device daemon or cloud control plane in the first version.
- No user-facing agent switcher, team mode, or agent roster.
- No generic coding-first landing page; the workspace is organized around scientific research.
- DeepSeek Harness owns the model/tool loop. The desktop layer owns product state, research contracts, provenance, and presentation.

## Trust and quality constraints

1. Research artifacts and attached documents are Untrusted Evidence, never instructions.
2. Claims must be separated from evidence and unknowns.
3. Every material external claim should map to an Evidence Record.
4. Generated files go under `.science/outputs/<project>/` unless the user explicitly chooses otherwise.
5. Original source data is read-only by convention.
6. API credentials never enter the renderer process.
7. The application must not claim a source was retrieved, a result reproduced, or a citation verified unless that action actually occurred.

## Visual direction

- User references: ClawsGO product structure and the `rhine-lock` visual language.
- Core metaphor: a classified research dossier inside an operating lab console.
- Palette: near-black industrial ground, warm signal orange for active operations and warnings, cyan for verified evidence, warm paper for reading surfaces.
- Materials: frosted specimen cards, acrylic-card brand mark, thin technical rules, sparse scan lines, square-ish controls.
- Typography: condensed technical display face for major headings, compact monospace for provenance and status metadata.
- Deliberate restraint: no 3D scene, no copied marks or assets, no decorative Agent roster. Orange is meaningful, not ambient.
