// 宿主会话归档适配器：把 DSH `workspaceRegistry` 的归档能力包装成路由层可用的接口。
// 设计约束（docs/11-session-archive-linkage.md §12）：
// - 只暴露「可逆」能力：宿主没有 unarchiveSession 时 available=false，路由返回 501 并隐藏入口；
// - 宿主活动检查（turn/job/subagent/schedule）由 registry 自己完成，这里只把错误翻译成稳定错误码；
// - 不缓存归档集合（单一事实源在宿主），每次操作/读取都现取。
import { DomainError } from './domain.js'

const ACTIVE_ERROR_NAMES = new Set(['WorkspaceActiveSessionError'])
const UNKNOWN_ERROR_NAMES = new Set(['WorkspaceUnknownSessionError'])

function errorName(error) {
  return error && typeof error === 'object' && typeof error.name === 'string' ? error.name : ''
}

/** 归档活动条目：宿主 provider 返回 `{kind, items?:[{id,label?}]}`，这里只做浅拷贝与长度防御。 */
function normalizeActivity(activity) {
  if (!Array.isArray(activity)) return []
  return activity
    .filter(item => item && typeof item === 'object' && typeof item.kind === 'string')
    .slice(0, 16)
    .map(item => ({
      kind: item.kind,
      ...(Array.isArray(item.items)
        ? {
            items: item.items
              .filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string')
              .slice(0, 20)
              .map(entry => ({ id: entry.id, ...(typeof entry.label === 'string' ? { label: entry.label } : {}) })),
          }
        : {}),
    }))
}

function unknownSession(sessionId) {
  return new DomainError('SESSION_NOT_FOUND', '会话不存在或已被删除', 404, { sessionId })
}

/**
 * 创建会话归档适配器。
 * @param {object} options
 * @param {() => object | null} [options.getRegistry] 返回宿主 workspaceRegistry（可能尚未注入）。
 * @param {object} [options.logger] 插件 logger，用于记录宿主异常。
 */
export function createSessionArchive({ getRegistry, logger } = {}) {
  const registry = () => {
    try {
      return typeof getRegistry === 'function' ? getRegistry() : null
    } catch {
      return null
    }
  }

  const warn = message => { try { logger?.warn?.(message) } catch {} }

  function requireReversible() {
    const current = registry()
    if (!current || typeof current.archiveSession !== 'function') {
      throw new DomainError('SESSION_ARCHIVE_UNAVAILABLE', '当前 DSH 版本不支持会话归档', 501)
    }
    if (typeof current.unarchiveSession !== 'function') {
      throw new DomainError('SESSION_ARCHIVE_UNAVAILABLE', '当前 DSH 版本不支持取消归档，已隐藏归档入口（需可逆才提供）', 501)
    }
    return current
  }

  /** 宿主是否提供可逆归档（DSH 0.2.1+）。 */
  function available() {
    const current = registry()
    return Boolean(current && typeof current.archiveSession === 'function' && typeof current.unarchiveSession === 'function')
  }

  /** 当前归档集合（宿主不可用时返回空数组）。 */
  function archivedSessionIds() {
    const current = registry()
    if (!current) return []
    try {
      const ids = current.archivedSessionIds
      return Array.isArray(ids) ? ids.map(String) : []
    } catch (error) {
      warn(`[dsh-kanban] 读取已归档会话集合失败：${error?.message || error}`)
      return []
    }
  }

  /**
   * 归档一个会话。
   * @param {string} sessionId 会话 id。
   * @param {{stopActivity?: boolean}} [options] stopActivity=true 时先停活再归档（仅用户确认后使用）。
   * @returns {Promise<string[]>} 操作后的完整归档集合。
   */
  async function archive(sessionId, { stopActivity = false } = {}) {
    const current = requireReversible()
    try {
      await current.archiveSession(sessionId, stopActivity === true ? { stopActivity: true } : {})
    } catch (error) {
      const name = errorName(error)
      if (UNKNOWN_ERROR_NAMES.has(name)) throw unknownSession(sessionId)
      if (ACTIVE_ERROR_NAMES.has(name)) {
        throw new DomainError('SESSION_ACTIVE', '会话仍有进行中的工作，结束后再归档', 409, {
          sessionId,
          activity: normalizeActivity(error.activity),
        })
      }
      warn(`[dsh-kanban] 归档会话 ${sessionId} 失败：${error?.message || error}`)
      throw new DomainError('SESSION_ARCHIVE_FAILED', `归档会话失败：${error?.message || error}`, 500, { sessionId })
    }
    return archivedSessionIds()
  }

  /**
   * 取消归档（幂等）。
   * @param {string} sessionId 会话 id。
   * @returns {Promise<string[]>} 操作后的完整归档集合。
   */
  async function unarchive(sessionId) {
    const current = requireReversible()
    try {
      await current.unarchiveSession(sessionId)
    } catch (error) {
      const name = errorName(error)
      if (UNKNOWN_ERROR_NAMES.has(name)) throw unknownSession(sessionId)
      warn(`[dsh-kanban] 取消归档会话 ${sessionId} 失败：${error?.message || error}`)
      throw new DomainError('SESSION_ARCHIVE_FAILED', `取消归档失败：${error?.message || error}`, 500, { sessionId })
    }
    return archivedSessionIds()
  }

  return { available, archivedSessionIds, archive, unarchive }
}
