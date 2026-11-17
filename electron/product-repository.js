import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ACTIVE_CONVERSATION_KEY = 'active_conversation_id';
const CONVERSATION_MIGRATION_KEY = 'conversation_local_storage_v1';

function normalizeConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('会话数据无效。');
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200) {
    throw new Error('会话 ID 无效。');
  }
  return {
    ...value,
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title : '新的研究',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    messages: Array.isArray(value.messages) ? value.messages : [],
    activities: Array.isArray(value.activities) ? value.activities : [],
    evidenceMode: value.evidenceMode !== false,
    researchMode: typeof value.researchMode === 'string' ? value.researchMode : 'auto',
  };
}

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
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const insertConversation = database.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertConversationIfAbsent = database.prepare(`
    INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateConversation = database.prepare(`
    UPDATE conversations
    SET title = ?, created_at = ?, updated_at = ?, payload_json = ?
    WHERE id = ?
  `);
  const deleteConversation = database.prepare('DELETE FROM conversations WHERE id = ?');
  const selectConversations = database.prepare(`
    SELECT id, payload_json FROM conversations ORDER BY updated_at DESC, id ASC
  `);
  const selectConversationById = database.prepare('SELECT payload_json FROM conversations WHERE id = ?');
  const selectActiveConversation = database.prepare('SELECT value FROM app_state WHERE key = ?');
  const setAppState = database.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  let closed = false;

  function assertOpen() {
    if (closed) throw new Error('产品数据库已关闭。');
  }

  function loadState() {
    assertOpen();
    const conversations = selectConversations.all().map(deserializeConversation);
    const activeRow = selectActiveConversation.get(ACTIVE_CONVERSATION_KEY);
    const requestedActiveId = typeof activeRow?.value === 'string' ? activeRow.value : null;
    const activeId = conversations.some((item) => item.id === requestedActiveId)
      ? requestedActiveId
      : conversations[0]?.id || null;
    if (activeId !== requestedActiveId) setAppState.run(ACTIVE_CONVERSATION_KEY, activeId);
    const migrationComplete = selectActiveConversation.get(CONVERSATION_MIGRATION_KEY)?.value === '1';
    return { conversations, activeId, migrationComplete };
  }

  function createConversation(value) {
    assertOpen();
    const conversation = normalizeConversation(value);
    insertConversation.run(
      conversation.id,
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
    );
    if (result.changes !== 1) throw new Error('无法更新不存在的会话。');
    return conversation;
  }

  function deleteConversationRecord(id) {
    assertOpen();
    const activeRow = selectActiveConversation.get(ACTIVE_CONVERSATION_KEY);
    const result = deleteConversation.run(id);
    if (result.changes !== 1) throw new Error('无法删除不存在的会话。');
    if (activeRow?.value === id) {
      const next = selectConversations.all()[0]?.id || null;
      setAppState.run(ACTIVE_CONVERSATION_KEY, next);
      return next;
    }
    return activeRow?.value || null;
  }

  function migrateLegacyState({ conversations, activeId }) {
    assertOpen();
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
        const existing = selectConversationById.get(conversation.id);
        if (existing && JSON.stringify(deserializeConversation(existing)) !== JSON.stringify(conversation)) {
          throw new Error(`旧会话与本地数据库中的同名 ID 冲突：${conversation.id}`);
        }
        insertConversationIfAbsent.run(
          conversation.id,
          conversation.title,
          conversation.createdAt,
          conversation.updatedAt,
          JSON.stringify(conversation),
        );
      }
      const knownIds = new Set(selectConversations.all().map((row) => row.id));
      const existingActiveId = selectActiveConversation.get(ACTIVE_CONVERSATION_KEY)?.value || null;
      const nextActiveId = knownIds.has(activeId)
        ? activeId
        : knownIds.has(existingActiveId)
          ? existingActiveId
          : selectConversations.all()[0]?.id || null;
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
    if (id !== null && !selectConversations.all().some((row) => row.id === id)) {
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
    createConversation,
    updateConversation: updateConversationRecord,
    deleteConversation: deleteConversationRecord,
    migrateLegacyState,
    setActiveConversation,
    close,
  };
}
