import path from 'node:path';

import { pathKey } from './path-boundary.js';

export function createResearchProjectLifecycle({
  productRepository,
  configStore,
  validateResearchWorkspace,
  onConfigSyncError = () => {},
}) {
  if (!productRepository || !configStore?.update || !configStore?.updateOrReset) {
    throw new Error('Research Project lifecycle dependencies are incomplete.');
  }
  if (typeof validateResearchWorkspace !== 'function') {
    throw new Error('Research Project lifecycle dependencies are incomplete: Research Workspace validation is required.');
  }

  async function trySyncActiveResearchWorkspaceConfig() {
    const workspace = productRepository.getActiveResearchWorkspacePath();
    try {
      await configStore.update((config) => (
        config.workspace === workspace ? config : { ...config, workspace }
      ));
    } catch (error) {
      try {
        await Promise.resolve(onConfigSyncError(error));
      } catch {
        // best-effort reporting must never break lifecycle consistency
      }
    }
    return productRepository.loadState();
  }

  function requireResearchProject(id, missingMessage) {
    const researchProject = productRepository.getProject(id);
    if (!researchProject) throw new Error(missingMessage);
    return researchProject;
  }

  function mutateResearchProjectAndSync(mutation) {
    mutation();
    return trySyncActiveResearchWorkspaceConfig();
  }

  async function activateResearchProject(id) {
    const researchProject = requireResearchProject(id, '无法选择不存在的 Research Project。');
    await validateResearchWorkspace(researchProject.workspacePath);
    return mutateResearchProjectAndSync(() => productRepository.setActiveProject(id));
  }

  function archiveResearchProject(id) {
    requireResearchProject(id, '无法归档不存在的 Research Project。');
    return mutateResearchProjectAndSync(() => productRepository.archiveProject(id));
  }

  function restoreResearchProject(id) {
    requireResearchProject(id, '无法恢复不存在的 Research Project。');
    return mutateResearchProjectAndSync(() => productRepository.restoreProject(id));
  }

  async function deleteResearchProject({ id, confirmationName, cleanupManagedResearchWorkspace }) {
    const researchProject = requireResearchProject(id, '无法删除不存在的 Research Project。');
    if (researchProject.workspaceKind === 'managed' && typeof cleanupManagedResearchWorkspace !== 'function') {
      throw new Error('删除受管理 Research Project 时必须提供 Research Workspace 清理操作。');
    }
    const result = productRepository.deleteProject({ id, confirmationName });
    let researchWorkspaceCleanupWarning = '';
    if (researchProject.workspaceKind === 'managed') {
      try {
        await cleanupManagedResearchWorkspace(researchProject);
      } catch (error) {
        researchWorkspaceCleanupWarning = error?.message || '受管理 Research Workspace 未能删除。';
      }
    }
    const state = await trySyncActiveResearchWorkspaceConfig();
    return { ...state, ...result, researchWorkspaceCleanupWarning };
  }

  async function initializeResearchProjectState({ configuredResearchWorkspace, ensureResearchWorkspace }) {
    const initialState = productRepository.loadState();
    const pendingBootstrapResearchProject = initialState.requiresResearchWorkspaceBinding;
    const requestedResearchWorkspace = initialState.project?.workspacePath || (pendingBootstrapResearchProject ? configuredResearchWorkspace : '');
    const researchWorkspace = requestedResearchWorkspace ? await ensureResearchWorkspace(requestedResearchWorkspace) : '';
    if (pendingBootstrapResearchProject && researchWorkspace) productRepository.bindPendingBootstrapResearchProject({ workspacePath: researchWorkspace });
    return trySyncActiveResearchWorkspaceConfig();
  }

  async function createResearchProject(value) {
    if (productRepository.loadState().requiresResearchWorkspaceBinding) {
      throw new Error('请先为待绑定的 Research Project 选择 Research Workspace。');
    }
    await validateResearchWorkspace(value?.workspacePath);
    return mutateResearchProjectAndSync(() => productRepository.createProject(value));
  }

  function normalizeRequestedResearchWorkspace(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error('请选择一个 Research Workspace。');
    }
    return path.resolve(value);
  }

  function assertResearchWorkspaceBinding(requestedResearchWorkspace, canonicalResearchWorkspace) {
    if (pathKey(requestedResearchWorkspace) !== pathKey(canonicalResearchWorkspace)) {
      throw new Error('Research Project 的 Research Workspace 绑定在创建后不可更换。');
    }
  }

  function resolveBoundResearchWorkspace(requestedResearchWorkspace) {
    const canonicalResearchWorkspace = productRepository.getActiveResearchWorkspacePath();
    if (canonicalResearchWorkspace) {
      assertResearchWorkspaceBinding(requestedResearchWorkspace, canonicalResearchWorkspace);
    }
    return canonicalResearchWorkspace;
  }

  async function saveConfiguration({ requestedResearchWorkspace, configurationValues = {}, ensureResearchWorkspace }) {
    const requested = normalizeRequestedResearchWorkspace(requestedResearchWorkspace);
    if (typeof ensureResearchWorkspace !== 'function') {
      throw new Error('Research Project lifecycle dependencies are incomplete: Research Workspace preparation is required.');
    }
    let researchWorkspaceBindingCommitted = false;
    try {
      const configuration = await configStore.updateOrReset(async (previous) => {
        const currentResearchWorkspace = resolveBoundResearchWorkspace(requested);
        const preparedResearchWorkspace = await ensureResearchWorkspace(path.resolve(currentResearchWorkspace || requested));
        const latestResearchWorkspace = resolveBoundResearchWorkspace(requested);
        if (!latestResearchWorkspace) {
          productRepository.bindPendingBootstrapResearchProject({ workspacePath: preparedResearchWorkspace });
          resolveBoundResearchWorkspace(requested);
        }
        if (typeof preparedResearchWorkspace !== 'string' || !preparedResearchWorkspace) {
          throw new Error('Research Workspace 准备失败。');
        }
        researchWorkspaceBindingCommitted = true;
        return { ...previous, ...configurationValues, workspace: preparedResearchWorkspace };
      });
      return {
        productState: productRepository.loadState(),
        configuration,
        configError: null,
      };
    } catch (error) {
      if (!researchWorkspaceBindingCommitted) throw error;
      return {
        productState: productRepository.loadState(),
        configuration: null,
        configError: error,
      };
    }
  }

  return {
    initializeResearchProjectState,
    createResearchProject,
    saveConfiguration,
    activateResearchProject,
    archiveResearchProject,
    restoreResearchProject,
    deleteResearchProject,
  };
}