import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeConversation } from '../app/conversation-state.js';

const ACTIVE_PROJECT_KEY = 'active_project_id';
const ACTIVE_CONVERSATION_KEY = 'active_conversation_id';
const CONVERSATION_MIGRATION_KEY = 'conversation_local_storage_v1';
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
  database.prepare(`
    INSERT OR IGNORE INTO projects (id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at)
    VALUES (?, ?, NULL, 'imported', ?, ?, NULL)
  `).run(DEFAULT_PROJECT_ID, 'Research Project', now, now);

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
  const countProjectConversations = database.prepare('SELECT COUNT(*) AS count FROM conversations WHERE project_id = ?');
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  const selectProject = database.prepare(`
    SELECT id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at
    FROM projects WHERE id = ?
  `);
  const selectProjects = database.prepare(`
    SELECT id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at
    FROM projects
    ORDER BY (archived_at IS NOT NULL) ASC, updated_at DESC, id ASC
  `);
  const selectFirstOpenProject = database.prepare(`
    SELECT id, name, workspace_path, workspace_kind, created_at, updated_at, archived_at
    FROM projects WHERE archived_at IS NULL
    ORDER BY updated_at DESC, id ASC LIMIT 1
  `);
  const updateProjectWorkspace = database.prepare(`
    UPDATE projects SET workspace_path = ?, workspace_kind = ?, updated_at = ? WHERE id = ?
  `);
  const updateProjectName = database.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?');
  const archiveProject = database.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?');
  const restoreProject = database.prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?');
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

  function serializeProject(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      workspacePath: row.workspace_path || '',
      workspaceKind: row.workspace_kind || 'imported',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at || null,
    };
  }

  function workspaceKey(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function getProjectRow(id) {
    if (typeof id !== 'string' || !id) return null;
    return selectProject.get(id) || null;
  }

  function getActiveProjectRow({ persist = true } = {}) {
    const requestedId = selectActiveState.get(ACTIVE_PROJECT_KEY)?.value || null;
    const requested = getProjectRow(requestedId);
    if (requested && !requested.archived_at) return requested;

    const fallback = selectFirstOpenProject.get() || null;
    if (persist && (fallback?.id || null) !== requestedId) setAppState.run(ACTIVE_PROJECT_KEY, fallback?.id || null);
    return fallback;
  }

  function assertActiveProject() {
    const row = getActiveProjectRow();
    if (!row?.workspace_path) throw new Error('Research Project 尚未绑定研究工作区。');
    return row;
  }

  function activeConversationStateKey(projectId) {
    return `${ACTIVE_CONVERSATION_KEY}:${projectId}`;
  }

  function activeConversationId(projectId) {
    const projectValue = selectActiveState.get(activeConversationStateKey(projectId))?.value || null;
    if (projectValue) return projectValue;
    const legacyValue = selectActiveState.get(ACTIVE_CONVERSATION_KEY)?.value || null;
    if (!legacyValue) return null;
    const row = selectConversationById.get(legacyValue);
    return row?.project_id === projectId ? legacyValue : null;
  }

  function setActiveConversationId(projectId, id) {
    setAppState.run(activeConversationStateKey(projectId), id);
    setAppState.run(ACTIVE_CONVERSATION_KEY, id);
  }

  function assertWorkspaceAvailable(workspacePath, { exceptProjectId = null } = {}) {
    const nextKey = workspaceKey(workspacePath);
    const conflict = selectProjects.all().find((row) => (
      row.id !== exceptProjectId
      && row.workspace_path
      && workspaceKey(row.workspace_path) === nextKey
    ));
    if (conflict) throw new Error(`该研究工作区已经绑定到 Research Project“${conflict.name}”。`);
  }

  function validateWorkspaceBinding(workspacePath) {
    assertOpen();
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('Research Project 必须绑定研究工作区。');
    const nextWorkspacePath = workspacePath.trim();
    if (!path.isAbsolute(nextWorkspacePath)) throw new Error('研究工作区必须是绝对路径。');
    const row = getActiveProjectRow() || getProjectRow(DEFAULT_PROJECT_ID);
    if (!row) throw new Error('当前 Research Project 不存在。');

    if (row.workspace_path && workspaceKey(row.workspace_path) !== workspaceKey(nextWorkspacePath)) {
      const { count } = countProjectConversations.get(row.id);
      if (count > 0) throw new Error('当前 Research Project 已有会话，不能直接更换研究工作区。');
    }
    assertWorkspaceAvailable(nextWorkspacePath, { exceptProjectId: row.id });
    return serializeProject(row);
  }

  function ensureProject({ workspacePath, name, workspaceKind = 'imported' } = {}) {
    assertOpen();
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new Error('研究工作区必须是绝对路径。');
    normalizeWorkspaceKind(workspaceKind);
    const row = getProjectRow(DEFAULT_PROJECT_ID);
    if (!row) throw new Error('默认 Research Project 不存在。');
    const existingConversations = countProjectConversations.get(DEFAULT_PROJECT_ID).count;
    if (row.workspace_path && existingConversations > 0 && workspaceKey(row.workspace_path) !== workspaceKey(workspacePath)) {
      throw new Error('当前 Research Project 已有会话，不能直接更换研究工作区。');
    }
    assertWorkspaceAvailable(workspacePath, { exceptProjectId: DEFAULT_PROJECT_ID });
    updateProjectWorkspace.run(workspacePath.trim(), workspaceKind, new Date().toISOString(), DEFAULT_PROJECT_ID);
    if (typeof name === 'string' && name.trim()) updateProjectName.run(normalizeProjectName(name), new Date().toISOString(), DEFAULT_PROJECT_ID);
    setAppState.run(ACTIVE_PROJECT_KEY, DEFAULT_PROJECT_ID);
    return serializeProject(getProjectRow(DEFAULT_PROJECT_ID));
  }

  function loadState() {
    assertOpen();
    const projects = selectProjects.all().map(serializeProject);
    const activeRow = getActiveProjectRow();
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
      archivedProjects: projects.filter((project) => project.archivedAt),
      activeProjectId,
      project: activeRow ? serializeProject(activeRow) : null,
      conversations,
      activeId,
      migrationComplete,
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
        const next = selectFirstOpenProject.get();
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
      setAppState.run(ACTIVE_PROJECT_KEY, id);
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
        const next = selectFirstOpenProject.get();
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
    return serializeProject(getProjectRow(id));
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

  function rebindActiveWorkspace(workspacePath) {
    assertOpen();
    const row = assertActiveProject();
    validateWorkspaceBinding(workspacePath);
    const timestamp = new Date().toISOString();
    updateProjectWorkspace.run(workspacePath.trim(), 'imported', timestamp, row.id);
    return serializeProject(getProjectRow(row.id));
  }

  function close() {
    if (closed) return;
    closed = true;
    database.close();
  }

  return {
    loadState,
    getProject,
    getConversationProjectId,
    ensureProject,
    validateWorkspaceBinding,
    rebindWorkspace: rebindActiveWorkspace,
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
