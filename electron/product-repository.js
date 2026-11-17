import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeConversation } from '../app/conversation-state.js';

const ACTIVE_CONVERSATION_KEY = 'active_conversation_id';
const CONVERSATION_MIGRATION_KEY = 'conversation_local_storage_v1';
const DEFAULT_PROJECT_ID = 'scientia-default-project';

function deserializeConversation(row) {
  const parsed = JSON.parse(row.payload_json);
  return normalizeConversation(parsed);
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  database.prepare(`
    INSERT OR IGNORE INTO projects (id, name, workspace_path, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?)
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
  const selectConversations = database.prepare(`
    SELECT id, payload_json FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, id ASC
  `);
  const selectConversationById = database.prepare('SELECT payload_json FROM conversations WHERE id = ? AND project_id = ?');
  const countProjectConversations = database.prepare('SELECT COUNT(*) AS count FROM conversations WHERE project_id = ?');
  const selectProject = database.prepare(`
    SELECT id, name, workspace_path, created_at, updated_at FROM projects WHERE id = ?
  `);
  const updateProjectWorkspace = database.prepare(`
    UPDATE projects SET workspace_path = ?, updated_at = ? WHERE id = ?
  `);
  const selectActiveConversation = database.prepare('SELECT value FROM app_state WHERE key = ?');
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function workspaceKey(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function validateWorkspaceBinding(workspacePath) {
    assertOpen();
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('Research Project 必须绑定研究工作区。');
    const nextWorkspacePath = workspacePath.trim();
    const row = selectProject.get(DEFAULT_PROJECT_ID);
    if (!row) throw new Error('默认 Research Project 不存在。');

    if (row.workspace_path && workspaceKey(row.workspace_path) !== workspaceKey(nextWorkspacePath)) {
      const { count } = countProjectConversations.get(DEFAULT_PROJECT_ID);
      if (count > 0) throw new Error('当前 Research Project 已有会话，不能直接更换研究工作区。');
    }
    return serializeProject(row);
  }

  function assertProjectBound() {
    const row = selectProject.get(DEFAULT_PROJECT_ID);
    if (!row?.workspace_path) throw new Error('Research Project 尚未绑定研究工作区。');
    return row;
  }

  function ensureProject({ workspacePath, name } = {}) {
    assertOpen();
    const row = validateWorkspaceBinding(workspacePath);
    const nextWorkspacePath = workspacePath.trim();
    if (!row.workspace_path || workspaceKey(row.workspace_path) !== workspaceKey(nextWorkspacePath)) {
      updateProjectWorkspace.run(nextWorkspacePath, new Date().toISOString(), DEFAULT_PROJECT_ID);
    }
    if (typeof name === 'string' && name.trim() && name.trim() !== row.name) {
      database.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
        .run(name.trim(), new Date().toISOString(), DEFAULT_PROJECT_ID);
    }
    return serializeProject(selectProject.get(DEFAULT_PROJECT_ID));
  }

  function loadState() {
    assertOpen();
    const conversations = selectConversations.all(DEFAULT_PROJECT_ID).map(deserializeConversation);
    const activeRow = selectActiveConversation.get(ACTIVE_CONVERSATION_KEY);
    const requestedActiveId = typeof activeRow?.value === 'string' ? activeRow.value : null;
    const activeId = conversations.some((item) => item.id === requestedActiveId)
      ? requestedActiveId
      : conversations[0]?.id || null;
    if (activeId !== requestedActiveId) setAppState.run(ACTIVE_CONVERSATION_KEY, activeId);
    const migrationComplete = selectActiveConversation.get(CONVERSATION_MIGRATION_KEY)?.value === '1';
    return { conversations, activeId, migrationComplete, project: serializeProject(selectProject.get(DEFAULT_PROJECT_ID)) };
  }

  function createConversation(value) {
    assertOpen();
    assertProjectBound();
    const conversation = normalizeConversation(value);
    insertConversation.run(
      conversation.id,
      DEFAULT_PROJECT_ID,
      conversation.title,
      conversation.createdAt,
      conversation.updatedAt,
      JSON.stringify(conversation),
    );
    return conversation;
  }

  function updateConversationRecord(value) {
    assertOpen();
    const conversation = normalizeConversation(value);
    const result = updateConversation.run(
      conversation.title,
      conversation.createdAt,
      conversation.updatedAt,
      JSON.stringify(conversation),
      conversation.id,
      DEFAULT_PROJECT_ID,
    );
    if (result.changes !== 1) throw new Error('无法更新不存在的会话。');
    return conversation;
  }

  function deleteConversationRecord(id) {
    assertOpen();
    const activeRow = selectActiveConversation.get(ACTIVE_CONVERSATION_KEY);
    const result = deleteConversation.run(id, DEFAULT_PROJECT_ID);
    if (result.changes !== 1) throw new Error('无法删除不存在的会话。');
    if (activeRow?.value === id) {
      const next = selectConversations.all(DEFAULT_PROJECT_ID)[0]?.id || null;
      setAppState.run(ACTIVE_CONVERSATION_KEY, next);
      return next;
    }
    return activeRow?.value || null;
  }

  function migrateLegacyState({ conversations, activeId }) {
    assertOpen();
    assertProjectBound();
    if (selectActiveConversation.get(CONVERSATION_MIGRATION_KEY)?.value === '1') {
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
        const existing = selectConversationById.get(conversation.id, DEFAULT_PROJECT_ID);
        if (existing && JSON.stringify(deserializeConversation(existing)) !== JSON.stringify(conversation)) {
          throw new Error(`旧会话与本地数据库中的同名 ID 冲突：${conversation.id}`);
        }
        insertConversationIfAbsent.run(
          conversation.id,
          DEFAULT_PROJECT_ID,
          conversation.title,
          conversation.createdAt,
          conversation.updatedAt,
          JSON.stringify(conversation),
        );
      }
      const knownIds = new Set(selectConversations.all(DEFAULT_PROJECT_ID).map((row) => row.id));
      const existingActiveId = selectActiveConversation.get(ACTIVE_CONVERSATION_KEY)?.value || null;
      const nextActiveId = knownIds.has(activeId)
        ? activeId
        : knownIds.has(existingActiveId)
          ? existingActiveId
          : selectConversations.all(DEFAULT_PROJECT_ID)[0]?.id || null;
      setAppState.run(ACTIVE_CONVERSATION_KEY, nextActiveId);
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
    if (id !== null && !selectConversations.all(DEFAULT_PROJECT_ID).some((row) => row.id === id)) {
      throw new Error('无法选择不存在的会话。');
    }
    setAppState.run(ACTIVE_CONVERSATION_KEY, id);
    return id;
  }

  function close() {
    if (closed) return;
    closed = true;
    database.close();
  }

  return {
    loadState,
    ensureProject,
    validateWorkspaceBinding,
    rebindWorkspace: (workspacePath) => ensureProject({ workspacePath }),
    createConversation,
    updateConversation: updateConversationRecord,
    deleteConversation: deleteConversationRecord,
    migrateLegacyState,
    setActiveConversation,
    close,
  };
}
