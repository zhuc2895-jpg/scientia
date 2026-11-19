import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeConversation } from '../app/conversation-state.js';
import {
  approveResearchCharter as approveCharterState,
  charterNeedsReapproval,
  createInitialResearchCharterState,
  currentApprovedResearchCharter,
  currentResearchCharter,
  normalizeResearchCharterState,
  researchCharterContentString,
  saveResearchCharterDraft as saveCharterDraftState,
  setCurrentResearchCharterContentHash,
} from '../app/research-charter.js';
import {
  buildResearchStageGraph,
  completeResearchStage,
  markResearchStageNotApplicable,
  normalizeResearchStageState,
  reopenResearchStage,
} from '../app/research-stages.js';
import { isWithin } from './path-boundary.js';

const ACTIVE_PROJECT_KEY = 'active_project_id';
const ACTIVE_CONVERSATION_KEY = 'active_conversation_id';
const CONVERSATION_MIGRATION_KEY = 'conversation_local_storage_v1';
const DEFAULT_PROJECT_BOOTSTRAP_KEY = 'default_project_bootstrap_v1';
const DEFAULT_PROJECT_ID = 'scientia-default-project';
const WORKSPACE_KINDS = new Set(['managed', 'imported']);

function deserializeConversation(row) {
  const parsed = JSON.parse(row.payload_json);
  return normalizeConversation(parsed);
}

function normalizeProjectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.length > 200) {
    throw new Error('Research Project ID 无效。');
  }
  return value;
}

function normalizeProjectName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Research Project 名称不能为空。');
  const name = value.trim();
  if (name.length > 120) throw new Error('Research Project 名称过长。');
  return name;
}

function normalizeWorkspaceKind(value) {
  if (!WORKSPACE_KINDS.has(value)) throw new Error('Research Workspace 类型无效。');
  return value;
}

function researchCharterContentHash(revision) {
  return createHash('sha256')
    .update(researchCharterContentString(revision), 'utf8')
    .digest('hex');
}

export function openProductRepository({ databasePath }) {
  if (typeof databasePath !== 'string' || !databasePath) {
    throw new Error('产品数据库路径无效。');
  }

  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const now = new Date().toISOString();
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'imported',
      current_stage_key TEXT NOT NULL DEFAULT 'scoping',
      research_stage_states_json TEXT NOT NULL DEFAULT '{}',
      research_charter_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}',
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const conversationColumns = database.prepare('PRAGMA table_info(conversations)').all();
  if (!conversationColumns.some((column) => column.name === 'project_id')) {
    database.exec(`ALTER TABLE conversations ADD COLUMN project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}'`);
  }
  const projectColumns = database.prepare('PRAGMA table_info(projects)').all();
  if (!projectColumns.some((column) => column.name === 'workspace_kind')) {
    database.exec("ALTER TABLE projects ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'imported'");
  }
  if (!projectColumns.some((column) => column.name === 'archived_at')) {
    database.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'current_stage_key')) {
    database.exec("ALTER TABLE projects ADD COLUMN current_stage_key TEXT NOT NULL DEFAULT 'scoping'");
  }
  if (!projectColumns.some((column) => column.name === 'research_stage_states_json')) {
    database.exec("ALTER TABLE projects ADD COLUMN research_stage_states_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!projectColumns.some((column) => column.name === 'research_charter_json')) {
    database.exec("ALTER TABLE projects ADD COLUMN research_charter_json TEXT NOT NULL DEFAULT '{}'");
  }
  const bootstrapState = database.prepare('SELECT value FROM app_state WHERE key = ?').get(DEFAULT_PROJECT_BOOTSTRAP_KEY);
  if (!bootstrapState) {
    const projectCount = database.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    if (projectCount === 0) {
      database.prepare(`
        INSERT INTO projects (id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at)
        VALUES (?, ?, NULL, 'imported', ?, ?, NULL)
      `).run(DEFAULT_PROJECT_ID, 'Research Project', now, now);
    }
    database.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run(DEFAULT_PROJECT_BOOTSTRAP_KEY, '1');
  }

  const insertConversation = database.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertConversationIfAbsent = database.prepare(`
    INSERT OR IGNORE INTO conversations (id, project_id, title, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateConversation = database.prepare(`
    UPDATE conversations
    SET title = ?, created_at = ?, updated_at = ?, payload_json = ?
    WHERE id = ? AND project_id = ?
  `);
  const deleteConversation = database.prepare('DELETE FROM conversations WHERE id = ? AND project_id = ?');
  const deleteProjectConversations = database.prepare('DELETE FROM conversations WHERE project_id = ?');
  const selectConversations = database.prepare(`
    SELECT id, payload_json FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, id ASC
  `);
  const selectConversationById = database.prepare('SELECT payload_json, project_id FROM conversations WHERE id = ?');
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  const selectProject = database.prepare(`
    SELECT id, name, workspace_path, workspace_kind, current_stage_key, research_stage_states_json,
           research_charter_json, created_at, updated_at, archived_at
    FROM projects WHERE id = ?
  `);
  const selectProjects = database.prepare(`
    SELECT id, name, workspace_path, workspace_kind, current_stage_key, research_stage_states_json,
           research_charter_json, created_at, updated_at, archived_at
    FROM projects
    ORDER BY (archived_at IS NOT NULL) ASC, updated_at DESC, id ASC
  `);
  const updateProjectWorkspace = database.prepare(`
    UPDATE projects SET workspace_path = ?, workspace_kind = ?, updated_at = ? WHERE id = ?
  `);
  const archiveProject = database.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?');
  const restoreProject = database.prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?');
  const updateResearchStageState = database.prepare(`
    UPDATE projects
    SET current_stage_key = ?, research_stage_states_json = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateResearchProjectState = database.prepare(`
    UPDATE projects
    SET research_charter_json = ?, current_stage_key = ?, research_stage_states_json = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteProject = database.prepare('DELETE FROM projects WHERE id = ?');
  const selectActiveState = database.prepare('SELECT value FROM app_state WHERE key = ?');
  const setAppState = database.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  let closed = false;

  function assertOpen() {
    if (closed) throw new Error('产品数据库已关闭。');
  }

  function isBoundResearchProjectRow(row) {
    return typeof row?.workspace_path === 'string' && row.workspace_path.trim() !== '';
  }

  function researchCharterStateForRow(row) {
    try {
      return normalizeResearchCharterState(JSON.parse(row?.research_charter_json || '{}'));
    } catch {
      return createInitialResearchCharterState();
    }
  }

  function researchStageStateForRow(row, charterState = researchCharterStateForRow(row)) {
    let stages = {};
    try {
      const parsed = JSON.parse(row?.research_stage_states_json || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stages = parsed;
    } catch {
      // Corrupt derived stage records recover to the beginning of the project stage graph.
    }
    const normalized = normalizeResearchStageState({
      currentStageKey: row?.current_stage_key || null,
      stages,
    });
    const approved = currentApprovedResearchCharter(charterState);
    if (!approved && normalized.currentStageKey !== 'scoping') {
      return { ...normalized, currentStageKey: 'scoping' };
    }
    return normalized;
  }

  function serializeProject(row) {
    if (!row) return null;
    const charterState = researchCharterStateForRow(row);
    const approved = currentApprovedResearchCharter(charterState);
    const current = currentResearchCharter(charterState);
    return {
      id: row.id,
      name: row.name,
      workspacePath: row.workspace_path || '',
      workspaceKind: row.workspace_kind || 'imported',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at || null,
      charter: {
        currentVersion: charterState.currentVersion,
        approvedVersion: charterState.approvedVersion,
        needsReapproval: charterNeedsReapproval(charterState),
        current,
        approved,
        revisions: charterState.revisions,
      },
      stageGraph: buildResearchStageGraph(researchStageStateForRow(row, charterState), {
        charterApproved: Boolean(approved),
        charterVersion: approved?.version || current?.version || null,
      }),
    };
  }

  function getProjectRow(id) {
    if (typeof id !== 'string' || !id) return null;
    return selectProject.get(id) || null;
  }

  function findFirstUnarchivedBoundResearchProjectRow() {
    return selectProjects.all().find((row) => !row.archived_at && isBoundResearchProjectRow(row)) || null;
  }

  function getActiveProjectRow({ persist = true } = {}) {
    const requestedId = selectActiveState.get(ACTIVE_PROJECT_KEY)?.value || null;
    const requested = getProjectRow(requestedId);
    if (requested && !requested.archived_at && isBoundResearchProjectRow(requested)) return requested;

    const fallback = findFirstUnarchivedBoundResearchProjectRow();
    if (persist && (fallback?.id || null) !== requestedId) setAppState.run(ACTIVE_PROJECT_KEY, fallback?.id || null);
    return fallback;
  }

  function assertActiveProject() {
    const row = getActiveProjectRow();
    if (!row?.workspace_path) throw new Error('Research Project 尚未绑定 Research Workspace。');
    return row;
  }

  function activeConversationStateKey(projectId) {
    return `${ACTIVE_CONVERSATION_KEY}:${projectId}`;
  }

  function activeConversationId(projectId) {
    const projectKey = activeConversationStateKey(projectId);
    const projectValue = selectActiveState.get(projectKey)?.value || null;
    if (projectValue) return projectValue;
    const legacyValue = selectActiveState.get(ACTIVE_CONVERSATION_KEY)?.value || null;
    if (!legacyValue) return null;
    const row = selectConversationById.get(legacyValue);
    if (row?.project_id !== projectId) return null;
    setAppState.run(projectKey, legacyValue);
    return legacyValue;
  }

  function setActiveConversationId(projectId, id) {
    setAppState.run(activeConversationStateKey(projectId), id);
    setAppState.run(ACTIVE_CONVERSATION_KEY, id);
  }

  function assertWorkspaceAvailable(workspacePath, { exceptProjectId = null } = {}) {
    const conflict = selectProjects.all().find((row) => (
      row.id !== exceptProjectId
      && isBoundResearchProjectRow(row)
      && (isWithin(row.workspace_path, workspacePath) || isWithin(workspacePath, row.workspace_path))
    ));
    if (conflict) throw new Error(`该 Research Workspace 与现有 Research Project“${conflict.name}”的目录重叠。`);
  }

  function bindPendingBootstrapResearchProject({ workspacePath }) {
    assertOpen();
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new Error('Research Workspace 必须是绝对路径。');
    const row = getProjectRow(DEFAULT_PROJECT_ID);
    if (!row) throw new Error('默认 Research Project 不存在。');
    if (!isBoundResearchProjectRow(row)) {
      assertWorkspaceAvailable(workspacePath, { exceptProjectId: DEFAULT_PROJECT_ID });
      updateProjectWorkspace.run(workspacePath.trim(), 'imported', new Date().toISOString(), DEFAULT_PROJECT_ID);
    }
    setAppState.run(ACTIVE_PROJECT_KEY, DEFAULT_PROJECT_ID);
    return serializeProject(getProjectRow(DEFAULT_PROJECT_ID));
  }

  function loadState() {
    assertOpen();
    const projects = selectProjects.all().filter(isBoundResearchProjectRow).map(serializeProject);
    const activeRow = getActiveProjectRow();
    const pendingBootstrapRow = getProjectRow(DEFAULT_PROJECT_ID);
    const activeProjectId = activeRow?.id || null;
    const conversations = activeRow ? selectConversations.all(activeRow.id).map(deserializeConversation) : [];
    const requestedActiveId = activeRow ? activeConversationId(activeRow.id) : null;
    const activeId = conversations.some((item) => item.id === requestedActiveId)
      ? requestedActiveId
      : conversations[0]?.id || null;
    if (activeRow && activeId !== requestedActiveId) setActiveConversationId(activeRow.id, activeId);
    const migrationComplete = selectActiveState.get(CONVERSATION_MIGRATION_KEY)?.value === '1';
    return {
      projects,
      activeProjectId,
      project: activeRow ? serializeProject(activeRow) : null,
      conversations,
      activeId,
      migrationComplete,
      requiresResearchWorkspaceBinding: !activeRow && Boolean(pendingBootstrapRow && !isBoundResearchProjectRow(pendingBootstrapRow)),
    };
  }

  function createProject(value = {}) {
    assertOpen();
    const id = normalizeProjectId(value.id);
    const name = normalizeProjectName(value.name);
    const workspacePath = typeof value.workspacePath === 'string' ? value.workspacePath.trim() : '';
    if (!workspacePath || !path.isAbsolute(workspacePath)) throw new Error('Research Workspace 必须是绝对路径。');
    const workspaceKind = normalizeWorkspaceKind(value.workspaceKind || 'imported');
    if (getProjectRow(id)) throw new Error('Research Project ID 已存在。');
    assertWorkspaceAvailable(workspacePath);
    const timestamp = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      insertProject.run(id, name, workspacePath, workspaceKind, timestamp, timestamp);
      setAppState.run(ACTIVE_PROJECT_KEY, id);
      setActiveConversationId(id, null);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return serializeProject(getProjectRow(id));
  }

  function setActiveProject(id) {
    assertOpen();
    const row = getProjectRow(id);
    if (!row) throw new Error('无法选择不存在的 Research Project。');
    if (row.archived_at) throw new Error('已归档的 Research Project 需要先恢复。');
    setAppState.run(ACTIVE_PROJECT_KEY, id);
    return serializeProject(row);
  }

  function archiveProjectRecord(id) {
    assertOpen();
    const row = getProjectRow(id);
    if (!row) throw new Error('无法归档不存在的 Research Project。');
    if (row.archived_at) return serializeProject(row);
    const timestamp = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      archiveProject.run(timestamp, timestamp, id);
      if (selectActiveState.get(ACTIVE_PROJECT_KEY)?.value === id) {
        const next = findFirstUnarchivedBoundResearchProjectRow();
        setAppState.run(ACTIVE_PROJECT_KEY, next?.id || null);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return serializeProject(getProjectRow(id));
  }

  function restoreProjectRecord(id) {
    assertOpen();
    const row = getProjectRow(id);
    if (!row) throw new Error('无法恢复不存在的 Research Project。');
    const timestamp = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      restoreProject.run(timestamp, id);
      if (!getActiveProjectRow({ persist: false })) setAppState.run(ACTIVE_PROJECT_KEY, id);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return serializeProject(getProjectRow(id));
  }

  function deleteProjectRecord({ id, confirmationName } = {}) {
    assertOpen();
    const row = getProjectRow(id);
    if (!row) throw new Error('无法删除不存在的 Research Project。');
    if (confirmationName !== row.name) throw new Error('项目名称确认不一致，未删除 Research Project。');
    const deletedProject = serializeProject(row);
    database.exec('BEGIN IMMEDIATE');
    try {
      deleteProjectConversations.run(id);
      deleteProject.run(id);
      if (selectActiveState.get(ACTIVE_PROJECT_KEY)?.value === id) {
        const next = findFirstUnarchivedBoundResearchProjectRow();
        setAppState.run(ACTIVE_PROJECT_KEY, next?.id || null);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { deletedProject };
  }

  function getProject(id) {
    assertOpen();
    const row = getProjectRow(id);
    return isBoundResearchProjectRow(row) ? serializeProject(row) : null;
  }

  function getActiveResearchWorkspacePath() {
    assertOpen();
    return getActiveProjectRow()?.workspace_path || '';
  }

  function getBoundResearchWorkspacePaths() {
    assertOpen();
    return selectProjects.all().filter(isBoundResearchProjectRow).map((row) => row.workspace_path);
  }

  function mutateResearchStageState(transform) {
    assertOpen();
    const project = assertActiveProject();
    const nextState = transform(researchStageStateForRow(project), project);
    const timestamp = new Date().toISOString();
    updateResearchStageState.run(
      nextState.currentStageKey || '',
      JSON.stringify(nextState.stages),
      timestamp,
      project.id,
    );
    return loadState();
  }

  function saveResearchCharterDraftRecord({ charter, source = 'user', generatedByRunId = null } = {}) {
    assertOpen();
    const project = assertActiveProject();
    const previousCharter = researchCharterStateForRow(project);
    const previousCurrent = currentResearchCharter(previousCharter);
    const nextCharter = saveCharterDraftState(previousCharter, charter, {
      source,
      updatedAt: new Date().toISOString(),
      generatedByRunId,
    });
    const nextCurrent = currentResearchCharter(nextCharter);
    const revisionCreated = previousCurrent?.status === 'approved'
      && nextCurrent?.version !== previousCurrent.version;
    const currentStageState = researchStageStateForRow(project, previousCharter);
    const stageState = revisionCreated
      ? { ...currentStageState, currentStageKey: 'scoping' }
      : currentStageState;
    const timestamp = new Date().toISOString();
    updateResearchProjectState.run(
      JSON.stringify(nextCharter),
      stageState.currentStageKey || '',
      JSON.stringify(stageState.stages),
      timestamp,
      project.id,
    );
    return loadState();
  }

  function approveResearchCharterRecord({ charter } = {}) {
    assertOpen();
    const project = assertActiveProject();
    const previousCharter = researchCharterStateForRow(project);
    const previousStageState = researchStageStateForRow(project, previousCharter);
    const timestamp = new Date().toISOString();
    const drafted = saveCharterDraftState(previousCharter, charter, {
      source: 'user',
      updatedAt: timestamp,
    });
    if (!currentResearchCharter(drafted)?.generatedByRunId) {
      throw new Error('Research Charter 必须由 Science Agent 起草后才能批准。');
    }
    let approvedCharter = approveCharterState(drafted, { approvedAt: timestamp });
    const approvedContent = currentApprovedResearchCharter(approvedCharter);
    approvedCharter = setCurrentResearchCharterContentHash(
      approvedCharter,
      researchCharterContentHash(approvedContent),
    );
    if (previousStageState.currentStageKey !== 'scoping') {
      throw new Error('Research Charter 只能在 Scoping Gate 中批准。');
    }
    const approvedCurrent = currentApprovedResearchCharter(approvedCharter);
    const nextStageState = completeResearchStage(previousStageState, 'scoping', {
      completedAt: timestamp,
      charterApproved: true,
      charterVersion: approvedCurrent?.version || null,
    });
    updateResearchProjectState.run(
      JSON.stringify(approvedCharter),
      nextStageState.currentStageKey || '',
      JSON.stringify(nextStageState.stages),
      timestamp,
      project.id,
    );
    return loadState();
  }

  function completeResearchStageRecord(stageKey) {
    return mutateResearchStageState((state, project) => {
      const approvedCharter = currentApprovedResearchCharter(researchCharterStateForRow(project));
      return completeResearchStage(state, stageKey, {
        completedAt: new Date().toISOString(),
        charterApproved: Boolean(approvedCharter),
        charterVersion: approvedCharter?.version || null,
      });
    });
  }

  function markResearchStageNotApplicableRecord({ stageKey, reason } = {}) {
    return mutateResearchStageState((state) => markResearchStageNotApplicable(state, stageKey, reason, {
      markedAt: new Date().toISOString(),
    }));
  }

  function reopenResearchStageRecord(stageKey) {
    return mutateResearchStageState((state) => reopenResearchStage(state, stageKey, {
      reopenedAt: new Date().toISOString(),
    }));
  }

  function getConversationProjectId(id) {
    assertOpen();
    if (typeof id !== 'string' || !id) return null;
    return selectConversationById.get(id)?.project_id || null;
  }

  function createConversation(value) {
    assertOpen();
    const project = assertActiveProject();
    const conversation = normalizeConversation(value);
    insertConversation.run(
      conversation.id,
      project.id,
      conversation.title,
      conversation.createdAt,
      conversation.updatedAt,
      JSON.stringify(conversation),
    );
    return conversation;
  }

  function updateConversationRecord(value) {
    assertOpen();
    const project = assertActiveProject();
    const conversation = normalizeConversation(value);
    const result = updateConversation.run(
      conversation.title,
      conversation.createdAt,
      conversation.updatedAt,
      JSON.stringify(conversation),
      conversation.id,
      project.id,
    );
    if (result.changes !== 1) throw new Error('无法更新不存在的会话。');
    return conversation;
  }

  function deleteConversationRecord(id) {
    assertOpen();
    const project = assertActiveProject();
    const result = deleteConversation.run(id, project.id);
    if (result.changes !== 1) throw new Error('无法删除不存在的会话。');
    const currentActiveId = activeConversationId(project.id);
    if (currentActiveId === id) {
      const next = selectConversations.all(project.id)[0]?.id || null;
      setActiveConversationId(project.id, next);
      return next;
    }
    return currentActiveId || null;
  }

  function migrateLegacyState({ conversations, activeId }) {
    assertOpen();
    const project = assertActiveProject();
    if (selectActiveState.get(CONVERSATION_MIGRATION_KEY)?.value === '1') {
      return { ...loadState(), migrated: false };
    }
    if (!Array.isArray(conversations)) throw new Error('旧会话数据格式无效。');
    const normalized = conversations.map(normalizeConversation);
    const uniqueById = new Map();
    for (const conversation of normalized) {
      const existing = uniqueById.get(conversation.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(conversation)) {
        throw new Error(`旧会话数据包含重复 ID：${conversation.id}`);
      }
      uniqueById.set(conversation.id, conversation);
    }
    const uniqueConversations = [...uniqueById.values()];

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const conversation of uniqueConversations) {
        const existing = selectConversationById.get(conversation.id);
        if (existing) {
          if (existing.project_id !== project.id || JSON.stringify(deserializeConversation(existing)) !== JSON.stringify(conversation)) {
            throw new Error(`旧会话与本地数据库中的同名 ID 冲突：${conversation.id}`);
          }
          continue;
        }
        insertConversationIfAbsent.run(
          conversation.id,
          project.id,
          conversation.title,
          conversation.createdAt,
          conversation.updatedAt,
          JSON.stringify(conversation),
        );
      }
      const knownIds = new Set(selectConversations.all(project.id).map((row) => row.id));
      const existingActiveId = activeConversationId(project.id);
      const nextActiveId = knownIds.has(activeId)
        ? activeId
        : knownIds.has(existingActiveId)
          ? existingActiveId
          : selectConversations.all(project.id)[0]?.id || null;
      setActiveConversationId(project.id, nextActiveId);
      setAppState.run(CONVERSATION_MIGRATION_KEY, '1');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return { ...loadState(), migrated: true };
  }

  function setActiveConversation(id) {
    assertOpen();
    const project = assertActiveProject();
    if (id !== null && !selectConversations.all(project.id).some((row) => row.id === id)) {
      throw new Error('无法选择不存在的会话。');
    }
    setActiveConversationId(project.id, id);
    return id;
  }

  function close() {
    if (closed) return;
    closed = true;
    database.close();
  }

  return {
    loadState,
    getProject,
    getActiveResearchWorkspacePath,
    getBoundResearchWorkspacePaths,
    saveResearchCharterDraft: saveResearchCharterDraftRecord,
    approveResearchCharter: approveResearchCharterRecord,
    completeResearchStage: completeResearchStageRecord,
    markResearchStageNotApplicable: markResearchStageNotApplicableRecord,
    reopenResearchStage: reopenResearchStageRecord,
    getConversationProjectId,
    bindPendingBootstrapResearchProject,
    createProject,
    setActiveProject,
    archiveProject: archiveProjectRecord,
    restoreProject: restoreProjectRecord,
    deleteProject: deleteProjectRecord,
    createConversation,
    updateConversation: updateConversationRecord,
    deleteConversation: deleteConversationRecord,
    migrateLegacyState,
    setActiveConversation,
    close,
  };
}
