import { createHash, randomUUID } from 'node:crypto';
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
import {
  findDuplicateSource,
  normalizeDoi,
  normalizeSourceTitle,
  normalizeSourceUrl,
  normalizeSourceYear,
  stableIdentifierForSource,
} from '../app/source-library.js';

const ACTIVE_PROJECT_KEY = 'active_project_id';
const ACTIVE_CONVERSATION_KEY = 'active_conversation_id';
const CONVERSATION_MIGRATION_KEY = 'conversation_local_storage_v1';
const DEFAULT_PROJECT_BOOTSTRAP_KEY = 'default_project_bootstrap_v1';
const DEFAULT_PROJECT_ID = 'scientia-default-project';
const WORKSPACE_KINDS = new Set(['managed', 'imported']);
const SOURCE_KINDS = new Set(['pdf', 'markdown', 'tex', 'bibtex', 'ris', 'doi', 'url']);

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function deserializeSource(row) {
  let authors = [];
  try {
    const parsed = JSON.parse(row.authors_json || '[]');
    if (Array.isArray(parsed)) authors = parsed.filter((author) => typeof author === 'string');
  } catch {
    // Invalid author metadata remains recoverable through the source title and locator.
  }
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    authors,
    year: row.year ?? null,
    doi: row.doi || null,
    url: row.url || null,
    venue: row.venue || '',
    stableIdentifier: row.stable_identifier || null,
    localLocator: row.local_locator,
    contentHash: row.content_hash,
    acquiredAt: row.acquired_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function normalizeSourceRecord(value = {}) {
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id || id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Source ID 无效。');
  const kind = typeof value.kind === 'string' ? value.kind.trim().toLowerCase() : '';
  if (!SOURCE_KINDS.has(kind)) throw new Error('Source 类型无效。');
  const title = typeof value.title === 'string' ? value.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > 500) throw new Error('Source 标题无效。');
  const authors = Array.isArray(value.authors)
    ? [...new Set(value.authors.map((author) => String(author || '').trim()).filter(Boolean))].slice(0, 100)
    : [];
  const doi = normalizeDoi(value.doi);
  const url = normalizeSourceUrl(value.url);
  const stableIdentifier = stableIdentifierForSource({
    stableIdentifier: value.stableIdentifier,
    doi,
    url,
  });
  const localLocator = typeof value.localLocator === 'string' ? value.localLocator.trim().replace(/\\/g, '/') : '';
  if (!localLocator || path.isAbsolute(localLocator) || localLocator.startsWith('../') || localLocator.includes('/../')) {
    throw new Error('Source local locator 必须是 Research Workspace 内的相对路径。');
  }
  const contentHash = typeof value.contentHash === 'string' ? value.contentHash.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Source content hash 无效。');
  const acquiredAt = typeof value.acquiredAt === 'string' && !Number.isNaN(Date.parse(value.acquiredAt))
    ? new Date(value.acquiredAt).toISOString()
    : new Date().toISOString();
  return {
    id,
    kind,
    title,
    normalizedTitle: normalizeSourceTitle(title),
    authors,
    year: normalizeSourceYear(value.year),
    doi,
    url,
    venue: typeof value.venue === 'string' ? value.venue.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
    stableIdentifier: stableIdentifier ? stableIdentifier.slice(0, 1000) : null,
    localLocator: localLocator.slice(0, 2000),
    contentHash,
    acquiredAt,
    metadata: value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {},
  };
}

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

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      authors_json TEXT NOT NULL DEFAULT '[]',
      year INTEGER,
      doi TEXT,
      url TEXT,
      venue TEXT NOT NULL DEFAULT '',
      stable_identifier TEXT,
      local_locator TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS sources_project_updated
      ON sources(project_id, acquired_at DESC, id ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS sources_project_stable_identifier
      ON sources(project_id, stable_identifier)
      WHERE stable_identifier IS NOT NULL;
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
  const insertCheckpoint = database.prepare(`
    INSERT INTO checkpoints (id, project_id, type, decision, rationale, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectCheckpoints = database.prepare(`
    SELECT id, project_id, type, decision, rationale, metadata_json, created_at
    FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC
  `);
  const insertSource = database.prepare(`
    INSERT INTO sources (
      id, project_id, kind, title, normalized_title, authors_json, year, doi, url, venue,
      stable_identifier, local_locator, content_hash, acquired_at, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSources = database.prepare(`
    SELECT id, project_id, kind, title, normalized_title, authors_json, year, doi, url, venue,
           stable_identifier, local_locator, content_hash, acquired_at, metadata_json
    FROM sources WHERE project_id = ? ORDER BY acquired_at DESC, title ASC, id ASC
  `);
  const selectSourceForProject = database.prepare(`
    SELECT id, project_id, kind, title, normalized_title, authors_json, year, doi, url, venue,
           stable_identifier, local_locator, content_hash, acquired_at, metadata_json
    FROM sources WHERE id = ? AND project_id = ?
  `);
  const selectSourceById = database.prepare('SELECT id, project_id FROM sources WHERE id = ?');

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
    if (!approved && normalized.stages.scoping?.status === 'not-applicable') {
      return { currentStageKey: 'scoping', stages: {} };
    }
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
      sources: activeRow ? selectSources.all(activeRow.id).map(deserializeSource) : [],
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

  function saveResearchCharterDraftRecord({ charter, revisionOrigin = 'user', generatedByRunId = null } = {}) {
    assertOpen();
    const project = assertActiveProject();
    const previousCharter = researchCharterStateForRow(project);
    const previousCurrent = currentResearchCharter(previousCharter);
    const nextCharter = saveCharterDraftState(previousCharter, charter, {
      revisionOrigin,
      updatedAt: new Date().toISOString(),
      generatedByRunId,
    });
    const nextCurrent = currentResearchCharter(nextCharter);
    const revisionCreated = nextCurrent?.version !== previousCurrent?.version;
    const persistedCharter = revisionCreated
      ? setCurrentResearchCharterContentHash(nextCharter, researchCharterContentHash(nextCurrent))
      : nextCharter;
    const currentStageState = researchStageStateForRow(project, previousCharter);
    const stageState = previousCurrent?.status === 'approved' && revisionCreated
      ? { ...currentStageState, currentStageKey: 'scoping' }
      : currentStageState;
    const timestamp = new Date().toISOString();
    updateResearchProjectState.run(
      JSON.stringify(persistedCharter),
      stageState.currentStageKey || '',
      JSON.stringify(stageState.stages),
      timestamp,
      project.id,
    );
    return loadState();
  }

  function restoreResearchCharterRevisionRecord({ version } = {}) {
    assertOpen();
    const project = assertActiveProject();
    const charterState = researchCharterStateForRow(project);
    const selected = charterState.revisions.find((revision) => revision.version === Number(version));
    if (!selected) throw new Error('无法恢复不存在的 Research Charter 版本。');
    return saveResearchCharterDraftRecord({
      charter: selected,
      revisionOrigin: 'user',
      generatedByRunId: selected.generatedByRunId,
    });
  }

  function approveResearchCharterRecord({ charter } = {}) {
    assertOpen();
    const project = assertActiveProject();
    const previousCharter = researchCharterStateForRow(project);
    const previousStageState = researchStageStateForRow(project, previousCharter);
    const timestamp = new Date().toISOString();
    const drafted = saveCharterDraftState(previousCharter, charter, {
      revisionOrigin: 'user',
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

  function serializeCheckpoint(row) {
    let metadata = {};
    try {
      const parsed = JSON.parse(row.metadata_json || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      // Corrupt checkpoint metadata remains available through its other fields.
    }
    return {
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      decision: row.decision,
      rationale: row.rationale,
      metadata,
      createdAt: row.created_at,
    };
  }

  function recordCheckpointRecord({ type, decision, rationale, metadata = {} } = {}) {
    assertOpen();
    const project = assertActiveProject();
    const normalizedType = typeof type === 'string' ? type.trim() : '';
    const normalizedDecision = typeof decision === 'string' ? decision.trim() : '';
    const normalizedRationale = typeof rationale === 'string' ? rationale.trim() : '';
    if (!normalizedType || !normalizedDecision || !normalizedRationale) {
      throw new Error('Checkpoint 类型、决定和理由不能为空。');
    }
    const normalizedMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    insertCheckpoint.run(
      id,
      project.id,
      normalizedType,
      normalizedDecision,
      normalizedRationale,
      JSON.stringify(normalizedMetadata),
      createdAt,
    );
    return {
      id,
      projectId: project.id,
      type: normalizedType,
      decision: normalizedDecision,
      rationale: normalizedRationale,
      metadata: normalizedMetadata,
      createdAt,
    };
  }

  function listCheckpointRecords() {
    assertOpen();
    const project = assertActiveProject();
    return selectCheckpoints.all(project.id).map(serializeCheckpoint);
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

  function assertConversationInActiveProject(conversationId) {
    const project = assertActiveProject();
    const conversationRow = selectConversationById.get(conversationId);
    if (!conversationRow) throw new Error('无法读取不存在的 Conversation。');
    if (conversationRow.project_id !== project.id) {
      throw new Error('只能访问当前 Research Project 中的 Conversation。');
    }
    return { project, conversationRow };
  }

  function registerSources({ sources } = {}) {
    assertOpen();
    const project = assertActiveProject();
    if (!Array.isArray(sources)) throw new Error('Source Library 导入批次无效。');
    if (sources.length > 200) throw new Error('单次最多登记 200 个 Source Record。');
    const existing = selectSources.all(project.id).map(deserializeSource);
    const inserted = [];
    const duplicates = [];
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const value of sources) {
        const source = normalizeSourceRecord(value);
        const duplicate = findDuplicateSource(source, existing);
        if (duplicate) {
          duplicates.push({ incoming: source, existing: duplicate });
          continue;
        }
        const createdAt = new Date().toISOString();
        insertSource.run(
          source.id,
          project.id,
          source.kind,
          source.title,
          source.normalizedTitle,
          JSON.stringify(source.authors),
          source.year,
          source.doi,
          source.url,
          source.venue,
          source.stableIdentifier,
          source.localLocator,
          source.contentHash,
          source.acquiredAt,
          JSON.stringify(source.metadata),
          createdAt,
        );
        const stored = deserializeSource(selectSourceForProject.get(source.id, project.id));
        inserted.push(stored);
        existing.push(stored);
      }
      if (inserted.length) {
        const stageState = researchStageStateForRow(project);
        if (
          ['inquiry', 'synthesis', 'manuscript', 'release'].includes(stageState.currentStageKey)
          && stageState.stages.evidence?.status === 'completed'
        ) {
          const reopenedAt = new Date().toISOString();
          const reopened = reopenResearchStage(stageState, 'evidence', { reopenedAt });
          updateResearchStageState.run(
            reopened.currentStageKey || '',
            JSON.stringify(reopened.stages),
            reopenedAt,
            project.id,
          );
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { inserted, duplicates };
  }

  function getSource(id) {
    assertOpen();
    const project = assertActiveProject();
    const row = selectSourceForProject.get(id, project.id);
    return row ? deserializeSource(row) : null;
  }

  function getConversationActiveSourceIds(conversationId) {
    assertOpen();
    const { project, conversationRow } = assertConversationInActiveProject(conversationId);
    const conversationState = deserializeConversation(conversationRow);
    const requested = Array.isArray(conversationState.activeSourceIds) ? conversationState.activeSourceIds : [];
    return [...new Set(requested.filter((id) => typeof id === 'string' && selectSourceForProject.get(id, project.id)))];
  }

  function getConversationActiveSources(conversationId) {
    assertOpen();
    const { project } = assertConversationInActiveProject(conversationId);
    return getConversationActiveSourceIds(conversationId)
      .map((id) => selectSourceForProject.get(id, project.id))
      .filter(Boolean)
      .map(deserializeSource);
  }

  function setActiveSources({ conversationId, sourceIds } = {}) {
    assertOpen();
    const { project, conversationRow } = assertConversationInActiveProject(conversationId);
    if (!Array.isArray(sourceIds)) throw new Error('Active Source Set 格式无效。');
    const uniqueIds = [...new Set(sourceIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    if (uniqueIds.length > 500) throw new Error('Active Source Set 最多包含 500 个 Source Record。');
    for (const sourceId of uniqueIds) {
      if (selectSourceForProject.get(sourceId, project.id)) continue;
      if (selectSourceById.get(sourceId)) throw new Error('Source 不属于当前 Research Project。');
      throw new Error('Source Record 不存在。');
    }
    const conversationState = deserializeConversation(conversationRow);
    const updated = {
      ...conversationState,
      activeSourceIds: uniqueIds,
      updatedAt: new Date().toISOString(),
    };
    updateConversation.run(
      updated.title,
      updated.createdAt,
      updated.updatedAt,
      JSON.stringify(updated),
      conversationId,
      project.id,
    );
    return loadState();
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
    recordCheckpoint: recordCheckpointRecord,
    listCheckpoints: listCheckpointRecords,
    registerSources,
    getSource,
    getConversationActiveSourceIds,
    getConversationActiveSources,
    setActiveSources,
    saveResearchCharterDraft: saveResearchCharterDraftRecord,
    restoreResearchCharterRevision: restoreResearchCharterRevisionRecord,
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
