// 云端远程 MCP 控制面（Cloudflare Worker + D1）：
// 遵循 docs/contracts/08-cloud-sync.md 的 Local-First 单写者边界：
//   1) 只读工具（kanban_boards / kanban_cards / kanban_card / kanban_review_board 及 dryRun 预览）
//      直接查询 D1 状态镜像——即使本地 Mac 合盖休眠也可 7x24 秒级读取；
//   2) 写入工具（建卡/改卡/移列/完成/时间线/请求审批/归档/合并）在边缘完成结构校验与执行面字段剥离后，
//      作为 `mcp_tool_call` 事件写入 `ingress_inbox`，由本地 Mac 守护器（C3）claim → 回放至
//      `~/.dsh-kanban/data.json` → 再增量同步回 D1，彻底杜绝双写脑裂，且绝不触碰本地 cwd/会话。
import { randomUUID } from 'node:crypto'
import {
  APPROVAL_OUTCOMES,
  APPROVAL_TONES,
  COLUMNS,
  COLUMN_LABELS,
  COLUMN_OF_STATUS,
  DEFAULT_BOARD_ID,
  LIMITS,
  PRIORITIES,
  STATUSES,
  DomainError,
  archiveCards,
  cleanText,
  countsFor,
  isCardId,
  mergeCards,
  newCardId,
  normalizePriority,
  normalizeProgress,
  normalizeStatus,
  restoreCards,
  reviewBoard,
} from './domain.js'
import { CloudSyncError, verifyBearer } from './cloud-sync-protocol.js'

export const CLOUD_MCP_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
])
export const DEFAULT_CLOUD_MCP_PROTOCOL_VERSION = '2025-03-26'

export const CLOUD_MCP_SERVER_INFO = Object.freeze({
  name: 'dsh-kanban-cloud-mcp',
  version: '0.28.0',
})

export const CLOUD_MCP_WRITE_TOOLS = Object.freeze([
  'kanban_create_card',
  'kanban_update_card',
  'kanban_move_card',
  'kanban_add_activity',
  'kanban_request_approval',
  'kanban_complete_card',
  'kanban_merge_cards',
  'kanban_archive_cards',
])

export const CLOUD_MCP_READ_TOOLS = Object.freeze([
  'kanban_boards',
  'kanban_cards',
  'kanban_card',
  'kanban_review_board',
])

export const CLOUD_MCP_TOOL_NAMES = Object.freeze([
  ...CLOUD_MCP_READ_TOOLS,
  ...CLOUD_MCP_WRITE_TOOLS,
])

const ACTIVITY_INPUT_TYPES = Object.freeze([
  'progress',
  'comment',
  'checklist',
  'artifact',
  'result',
  'error',
  'ack',
])

/** 云端写入严禁携带的本地执行面字段（纵深防御：边缘入队与本地回放双重剥离）。 */
export const FORBIDDEN_EXECUTION_FIELDS = Object.freeze([
  'cwd',
  'workspaceId',
  'sessionId',
  'sessionIds',
  'sessionMode',
  'waitCondition',
])

const ALLOWED_UPDATE_FIELDS = Object.freeze([
  'title',
  'summary',
  'currentAction',
  'result',
  'status',
  'priority',
  'labels',
  'project',
  'externalRef',
  'parentCardId',
  'dependsOn',
  'autoStart',
  'forceComplete',
  'agent',
  'progress',
  'checklists',
  'artifacts',
  'metadata',
  'handoff',
])

function trimStr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toInt(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertCardId(id, fieldName = 'cardId') {
  if (!isCardId(id)) {
    throw new DomainError('BAD_REQUEST', `${fieldName} 必须是 card-xxxxxxxx 形式的卡片 ID`)
  }
  return id
}

/**
 * 解析远程 MCP 期望的 Bearer 令牌：
 * - 若显式配置了独立的 `MCP_BEARER_TOKEN`，则远程 MCP 仅接受该独立令牌（最小权限隔离，随时可单独轮换）；
 * - 否则默认复用 `CLOUD_SYNC_TOKEN`（零额外配置开箱即用）；
 * - 两者均未配置时返回空串，由 `verifyCloudMcpAuth` fail-closed 返回 503。
 */
export function resolveCloudMcpToken(env) {
  const dedicated = trimStr(env?.MCP_BEARER_TOKEN)
  if (dedicated) return dedicated
  return trimStr(env?.CLOUD_SYNC_TOKEN)
}

/** 校验远程 MCP 请求的 Bearer 令牌（常量时间比较，未配置时 503 fail-closed）。 */
export function verifyCloudMcpAuth(request, env) {
  const expected = resolveCloudMcpToken(env)
  if (!expected) {
    return {
      ok: false,
      code: 'UNAVAILABLE',
      status: 503,
      message: '服务端未配置 MCP_BEARER_TOKEN 或 CLOUD_SYNC_TOKEN，远程 MCP 已关闭（fail-closed）',
    }
  }
  return verifyBearer(request.headers.get('authorization'), expected)
}

export function assertCloudMcpAuthorized(request, env) {
  const result = verifyCloudMcpAuth(request, env)
  if (!result.ok) {
    throw new CloudSyncError(result.code, result.message, { status: result.status })
  }
}

// ---------------------------------------------------------------------------
// 写入参数校验与本地执行面字段剥离（边缘与本地回放共用）
// ---------------------------------------------------------------------------

function sanitizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return undefined
  return artifacts.slice(0, LIMITS.artifacts).map(item => {
    if (!isPlainObject(item)) throw new DomainError('BAD_REQUEST', 'artifacts 项必须是对象')
    const label = cleanText(item.label, LIMITS.artifactLabel)
    if (!label) throw new DomainError('BAD_REQUEST', 'artifact.label 不能为空')
    const out = { label }
    if (typeof item.kind === 'string' && ['file', 'link', 'report', 'commit', 'image'].includes(item.kind)) {
      out.kind = item.kind
    }
    if (typeof item.url === 'string' && item.url.trim()) {
      out.url = cleanText(item.url, 2000)
    }
    // 故意剥离 item.path：云端写入不得注入本机文件路径
    return out
  })
}

function sanitizeHandoff(handoff) {
  if (handoff === null) return null
  if (!isPlainObject(handoff)) throw new DomainError('BAD_REQUEST', 'handoff 必须是对象或 null')
  const summary = cleanText(handoff.summary, LIMITS.handoffSummary)
  if (!summary) throw new DomainError('BAD_REQUEST', 'handoff.summary 不能为空')
  const nextSteps = cleanText(handoff.nextSteps, LIMITS.handoffNextSteps)
  // 故意剥离 handoff.sessionId
  return {
    summary,
    ...(nextSteps ? { nextSteps } : {}),
  }
}

function collectStrippedExecutionFields(rawArgs) {
  if (!isPlainObject(rawArgs)) return []
  return FORBIDDEN_EXECUTION_FIELDS.filter(key => rawArgs[key] !== undefined)
}

/**
 * 校验并净化云端 MCP 写工具入参。
 * 返回 `{ args, strippedFields }`；不合法直接抛 `DomainError('BAD_REQUEST', ...)`。
 */
export function sanitizeCloudMcpWriteArgs(toolName, rawArgs = {}) {
  if (!isPlainObject(rawArgs)) {
    throw new DomainError('BAD_REQUEST', '工具参数必须是 JSON 对象')
  }
  const strippedFields = collectStrippedExecutionFields(rawArgs)

  switch (toolName) {
    case 'kanban_create_card': {
      const title = cleanText(rawArgs.title, LIMITS.title)
      if (!title) throw new DomainError('BAD_REQUEST', '卡片标题 title 不能为空')
      const status = rawArgs.status === undefined ? 'backlog' : normalizeStatus(rawArgs.status)
      const priority = rawArgs.priority === undefined ? 'none' : normalizePriority(rawArgs.priority)
      if (rawArgs.parentCardId !== undefined && rawArgs.parentCardId !== null) {
        assertCardId(rawArgs.parentCardId, 'parentCardId')
      }
      if (rawArgs.dependsOn !== undefined) {
        if (!Array.isArray(rawArgs.dependsOn) || rawArgs.dependsOn.length > LIMITS.dependsOn) {
          throw new DomainError('BAD_REQUEST', `dependsOn 必须是最多 ${LIMITS.dependsOn} 个卡片 ID 的数组`)
        }
        for (const depId of rawArgs.dependsOn) assertCardId(depId, 'dependsOn[]')
      }
      const args = {
        ...(cleanText(rawArgs.boardId, 120) ? { boardId: cleanText(rawArgs.boardId, 120) } : {}),
        title,
        ...(typeof rawArgs.summary === 'string' ? { summary: cleanText(rawArgs.summary, LIMITS.summary) } : {}),
        status,
        priority,
        ...(Array.isArray(rawArgs.labels)
          ? { labels: rawArgs.labels.filter(x => typeof x === 'string').map(x => cleanText(x, LIMITS.label)).filter(Boolean).slice(0, LIMITS.labels) }
          : {}),
        ...(cleanText(rawArgs.project, 120) ? { project: cleanText(rawArgs.project, 120) } : {}),
        ...(cleanText(rawArgs.externalRef, 200) ? { externalRef: cleanText(rawArgs.externalRef, 200) } : {}),
        ...(rawArgs.parentCardId !== undefined ? { parentCardId: rawArgs.parentCardId } : {}),
        ...(Array.isArray(rawArgs.dependsOn) ? { dependsOn: [...new Set(rawArgs.dependsOn)] } : {}),
        ...(typeof rawArgs.autoStart === 'boolean' ? { autoStart: rawArgs.autoStart } : {}),
        ...(Array.isArray(rawArgs.checklists) ? { checklists: rawArgs.checklists.slice(0, LIMITS.checklists) } : {}),
        ...(rawArgs.forceNew === true ? { forceNew: true } : {}),
      }
      return { args, strippedFields }
    }

    case 'kanban_update_card': {
      assertCardId(rawArgs.cardId)
      const changes = {}
      for (const key of ALLOWED_UPDATE_FIELDS) {
        if (rawArgs[key] === undefined) continue
        if (key === 'status') {
          changes.status = normalizeStatus(rawArgs.status)
        } else if (key === 'priority') {
          changes.priority = normalizePriority(rawArgs.priority)
        } else if (key === 'parentCardId') {
          if (rawArgs.parentCardId !== null) assertCardId(rawArgs.parentCardId, 'parentCardId')
          changes.parentCardId = rawArgs.parentCardId
        } else if (key === 'dependsOn') {
          if (!Array.isArray(rawArgs.dependsOn) || rawArgs.dependsOn.length > LIMITS.dependsOn) {
            throw new DomainError('BAD_REQUEST', `dependsOn 必须是最多 ${LIMITS.dependsOn} 个卡片 ID 的数组`)
          }
          for (const depId of rawArgs.dependsOn) assertCardId(depId, 'dependsOn[]')
          changes.dependsOn = [...new Set(rawArgs.dependsOn)]
        } else if (key === 'progress') {
          if (typeof rawArgs.progress === 'number' && Number.isFinite(rawArgs.progress)) {
            changes.progress = normalizeProgress({ percent: Math.max(0, Math.min(100, Math.round(rawArgs.progress))) })
          } else {
            changes.progress = normalizeProgress(rawArgs.progress)
          }
        } else if (key === 'artifacts') {
          changes.artifacts = sanitizeArtifacts(rawArgs.artifacts)
        } else if (key === 'handoff') {
          changes.handoff = sanitizeHandoff(rawArgs.handoff)
        } else {
          changes[key] = rawArgs[key]
        }
      }
      const updatableKeys = Object.keys(changes).filter(k => k !== 'forceComplete')
      if (updatableKeys.length === 0) {
        throw new DomainError('BAD_REQUEST', '没有可更新的字段')
      }
      return { args: { cardId: rawArgs.cardId, ...changes }, strippedFields }
    }

    case 'kanban_move_card': {
      assertCardId(rawArgs.cardId)
      if (rawArgs.column === undefined && rawArgs.status === undefined) {
        throw new DomainError('BAD_REQUEST', '需要提供 column 或 status')
      }
      if (rawArgs.column !== undefined && !COLUMNS.includes(rawArgs.column)) {
        throw new DomainError('BAD_REQUEST', `未知列：${String(rawArgs.column)}`)
      }
      if (rawArgs.status !== undefined) normalizeStatus(rawArgs.status)
      const args = {
        cardId: rawArgs.cardId,
        ...(rawArgs.column !== undefined ? { column: rawArgs.column } : {}),
        ...(rawArgs.status !== undefined ? { status: rawArgs.status } : {}),
        ...(typeof rawArgs.text === 'string' ? { text: cleanText(rawArgs.text, 200) } : {}),
        ...(rawArgs.forceComplete === true ? { forceComplete: true } : {}),
      }
      return { args, strippedFields }
    }

    case 'kanban_add_activity': {
      assertCardId(rawArgs.cardId)
      const type = rawArgs.type === undefined ? 'progress' : rawArgs.type
      if (!ACTIVITY_INPUT_TYPES.includes(type)) {
        throw new DomainError('BAD_REQUEST', '不支持的时间线类型')
      }
      const text = cleanText(rawArgs.text, LIMITS.activityText)
      if (!text) throw new DomainError('BAD_REQUEST', 'text 不能为空')
      const args = {
        cardId: rawArgs.cardId,
        text,
        type,
        ...(isPlainObject(rawArgs.data) ? { data: rawArgs.data } : {}),
        ...(isPlainObject(rawArgs.metadata) ? { metadata: rawArgs.metadata } : {}),
      }
      return { args, strippedFields }
    }

    case 'kanban_request_approval': {
      assertCardId(rawArgs.cardId)
      const hasQuestions = Array.isArray(rawArgs.questions) && rawArgs.questions.length > 0
      const hasSingle = Boolean(cleanText(rawArgs.title, LIMITS.approvalTitle))
        && Array.isArray(rawArgs.options)
        && rawArgs.options.length > 0
      if (!hasQuestions && !hasSingle) {
        throw new DomainError('BAD_REQUEST', '需要提供 title + options（单题审批）或 questions[]（多题审批）')
      }
      if (hasQuestions && rawArgs.questions.length > LIMITS.approvalQuestions) {
        throw new DomainError('BAD_REQUEST', `questions 最多 ${LIMITS.approvalQuestions} 题`)
      }
      if (Array.isArray(rawArgs.options) && rawArgs.options.length > LIMITS.approvalOptions) {
        throw new DomainError('BAD_REQUEST', `options 最多 ${LIMITS.approvalOptions} 个`)
      }
      const args = {
        cardId: rawArgs.cardId,
        ...(typeof rawArgs.title === 'string' ? { title: cleanText(rawArgs.title, LIMITS.approvalTitle) } : {}),
        ...(typeof rawArgs.detail === 'string' ? { detail: cleanText(rawArgs.detail, LIMITS.approvalDetail) } : {}),
        ...(Array.isArray(rawArgs.options) ? { options: rawArgs.options } : {}),
        ...(typeof rawArgs.multiSelect === 'boolean' ? { multiSelect: rawArgs.multiSelect } : {}),
        ...(hasQuestions ? { questions: rawArgs.questions } : {}),
      }
      return { args, strippedFields }
    }

    case 'kanban_complete_card': {
      assertCardId(rawArgs.cardId)
      const result = cleanText(rawArgs.result, LIMITS.result)
      if (!result) throw new DomainError('BAD_REQUEST', 'result 不能为空')
      return {
        args: {
          cardId: rawArgs.cardId,
          result,
          ...(rawArgs.force === true ? { force: true } : {}),
        },
        strippedFields,
      }
    }

    case 'kanban_merge_cards': {
      assertCardId(rawArgs.sourceCardId, 'sourceCardId')
      assertCardId(rawArgs.targetCardId, 'targetCardId')
      if (rawArgs.sourceCardId === rawArgs.targetCardId) {
        throw new DomainError('BAD_REQUEST', '不能把卡片合并到自己')
      }
      return {
        args: {
          sourceCardId: rawArgs.sourceCardId,
          targetCardId: rawArgs.targetCardId,
          ...(typeof rawArgs.title === 'string' ? { title: cleanText(rawArgs.title, LIMITS.title) } : {}),
        },
        strippedFields,
      }
    }

    case 'kanban_archive_cards': {
      if (!Array.isArray(rawArgs.cardIds) || rawArgs.cardIds.length < 1 || rawArgs.cardIds.length > LIMITS.batchCards) {
        throw new DomainError('BAD_REQUEST', `cardIds 需要是 1-${LIMITS.batchCards} 个卡片 ID 的数组`)
      }
      const uniqueIds = [...new Set(rawArgs.cardIds.map(id => assertCardId(id, 'cardIds[]')))]
      return {
        args: {
          cardIds: uniqueIds,
          ...(typeof rawArgs.reason === 'string' ? { reason: cleanText(rawArgs.reason, 200) } : {}),
          ...(rawArgs.restore === true ? { restore: true } : {}),
        },
        strippedFields,
      }
    }

    default:
      throw new DomainError('BAD_REQUEST', `不支持的云端写入工具：${String(toolName)}`)
  }
}

// ---------------------------------------------------------------------------
// D1 镜像读取与实体整形
// ---------------------------------------------------------------------------

function rowsOf(result) {
  return Array.isArray(result?.results) ? result.results : []
}

function hydrateBoard(row) {
  let parsed = {}
  try { parsed = JSON.parse(String(row?.payload ?? '{}')) } catch { parsed = {} }
  return {
    id: String(parsed.id || row.id || DEFAULT_BOARD_ID),
    name: String(parsed.name || row.name || '主看板'),
    ...(parsed.description || row.description ? { description: String(parsed.description || row.description) } : {}),
    cardOrder: isPlainObject(parsed.cardOrder)
      ? parsed.cardOrder
      : { backlog: [], running: [], needs_you: [], done: [] },
    archived: Boolean(parsed.archived || Number(row?.archived) === 1),
    createdAt: toInt(parsed.createdAt ?? row.created_at),
    updatedAt: toInt(parsed.updatedAt ?? row.updated_at),
  }
}

function hydrateCard(row) {
  let parsed = {}
  try { parsed = JSON.parse(String(row?.payload ?? '{}')) } catch { parsed = {} }
  return {
    ...parsed,
    id: String(parsed.id || row.id),
    boardId: String(parsed.boardId || row.board_id || DEFAULT_BOARD_ID),
    title: String(parsed.title || row.title || ''),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    status: String(parsed.status || row.status || 'backlog'),
    priority: String(parsed.priority || row.priority || 'none'),
    labels: Array.isArray(parsed.labels) ? parsed.labels : [],
    ...(parsed.project || row.project ? { project: String(parsed.project || row.project) } : {}),
    ...(parsed.externalRef || row.external_ref ? { externalRef: String(parsed.externalRef || row.external_ref) } : {}),
    parentCardId: parsed.parentCardId ?? row.parent_card_id ?? null,
    dependsOn: Array.isArray(parsed.dependsOn) ? parsed.dependsOn : [],
    sessionIds: [],
    checklists: Array.isArray(parsed.checklists) ? parsed.checklists : [],
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    metadata: isPlainObject(parsed.metadata) ? parsed.metadata : { toolCalls: 0, searches: 0 },
    archived: Boolean(parsed.archived || Number(row?.archived) === 1),
    version: toInt(parsed.version ?? row.version, 1),
    createdAt: toInt(parsed.createdAt ?? row.created_at),
    updatedAt: toInt(parsed.updatedAt ?? row.updated_at),
    ...(parsed.completedAt != null || row.completed_at != null
      ? { completedAt: toInt(parsed.completedAt ?? row.completed_at) }
      : {}),
  }
}

function hydrateActivity(row) {
  let parsed = {}
  try { parsed = JSON.parse(String(row?.payload ?? '{}')) } catch { parsed = {} }
  return {
    ...parsed,
    id: String(parsed.id || row.id),
    cardId: String(parsed.cardId || row.card_id),
    boardId: String(parsed.boardId || row.board_id || DEFAULT_BOARD_ID),
    type: String(parsed.type || row.type || 'progress'),
    actor: isPlainObject(parsed.actor)
      ? parsed.actor
      : { kind: String(row.actor_kind || 'agent'), name: String(row.actor_name || 'Agent') },
    text: String(parsed.text || row.text || ''),
    at: toInt(parsed.at ?? row.at),
  }
}

function cardBrief(card) {
  const pending = (card.approvals || []).find(approval => approval.status === 'pending')
  return {
    id: card.id,
    boardId: card.boardId,
    title: card.title,
    summary: card.summary,
    currentAction: card.currentAction,
    status: card.status,
    column: COLUMN_OF_STATUS[card.status] || 'backlog',
    columnLabel: COLUMN_LABELS[COLUMN_OF_STATUS[card.status]] || '待办',
    priority: card.priority,
    labels: card.labels,
    project: card.project,
    parentCardId: card.parentCardId ?? null,
    dependsOn: card.dependsOn || [],
    ...(card.autoStart === true ? { autoStart: true } : {}),
    progress: card.progress,
    handoff: card.handoff,
    metadata: card.metadata,
    ...(card.archived ? { archived: true, archivedAt: card.archivedAt } : {}),
    ...(pending ? {
      pendingApproval: {
        id: pending.id,
        title: pending.title,
        multiSelect: pending.multiSelect === true,
        questionCount: Array.isArray(pending.questions) ? pending.questions.length : 0,
      },
    } : {}),
    version: card.version,
    updatedAt: card.updatedAt,
  }
}

function hintFor(card) {
  if (card.status === 'needs_you') {
    const pending = (card.approvals || []).find(approval => approval.status === 'pending')
    const questionCount = Array.isArray(pending?.questions) ? pending.questions.length : 0
    if (questionCount > 1) return `卡片有 ${questionCount} 题的待确认审批；用户会在看板逐题作答，不要自行替用户回答。`
    return '卡片正在等待用户确认；不要自行推进，等用户在看板处理审批。'
  }
  if (card.status === 'done') {
    return '卡片已完成；同一交付物的追问微调请直接重开本卡（kanban_move_card 到 running），只有开启全新独立交付物时才新建一张卡片。'
  }
  return '执行中可用 kanban_update_card 更新 currentAction/progress，关键节点用 kanban_add_activity 记录。'
}

async function loadD1Snapshot(db, now) {
  const [metaRes, boardsRes, cardsRes, pendingRes] = await db.batch([
    db.prepare('SELECT revision, epoch FROM sync_meta WHERE id = 1'),
    db.prepare('SELECT id, name, description, archived, created_at, updated_at, payload FROM boards WHERE archived = 0 ORDER BY created_at ASC, id ASC'),
    db.prepare('SELECT id, board_id, title, status, priority, project, external_ref, parent_card_id, version, archived, created_at, updated_at, completed_at, payload FROM cards ORDER BY updated_at DESC, id ASC'),
    db.prepare("SELECT COUNT(*) AS cnt FROM ingress_inbox WHERE event_type = 'mcp_tool_call' AND status IN ('pending', 'leased') AND expires_at > ?").bind(now),
  ])
  const metaRow = rowsOf(metaRes)[0]
  if (!metaRow) {
    throw new CloudSyncError('UNAVAILABLE', 'sync_meta 未初始化：请先执行 wrangler d1 migrations apply', { status: 503 })
  }
  const boards = rowsOf(boardsRes).map(hydrateBoard)
  if (boards.length === 0) {
    boards.push({
      id: DEFAULT_BOARD_ID,
      name: '主看板',
      cardOrder: { backlog: [], running: [], needs_you: [], done: [] },
      archived: false,
      createdAt: 0,
      updatedAt: 0,
    })
  }
  const cards = rowsOf(cardsRes).map(hydrateCard)
  const pendingRow = rowsOf(pendingRes)[0]
  const pendingCloudWrites = toInt(pendingRow?.cnt, 0)
  return {
    boards,
    cards,
    activities: [],
    meta: {
      revision: toInt(metaRow.revision, 0),
      epoch: trimStr(metaRow.epoch),
    },
    pendingCloudWrites,
  }
}

function pendingSyncExtra(pendingCloudWrites) {
  if (!pendingCloudWrites) return { pendingCloudWrites: 0 }
  return {
    pendingCloudWrites,
    syncHint: `当前有 ${pendingCloudWrites} 条云端 MCP 写操作已在 ingress_inbox 排队，待本地 Mac 看板守护器 claim 回放后自动同步回 D1。`,
  }
}

function queuedWriteHint(strippedFields) {
  const base = '写操作已安全入队云端 ingress_inbox：本地 Mac 在线时将在数秒内回放至 ~/.dsh-kanban/data.json 并同步回 D1；Mac 合盖休眠时零丢失暂存，唤醒后自动按序回放。'
  if (!strippedFields?.length) return base
  return `${base}（已按云同步安全契约自动忽略本地执行面字段：${strippedFields.join(', ')}）`
}

// ---------------------------------------------------------------------------
// 工具 Schema 与执行定义
// ---------------------------------------------------------------------------

const cardIdProperty = {
  type: 'string',
  pattern: '^card-[a-f0-9]{6,8}$',
  description: '卡片 ID，例如 card-1a2b3c4d',
}
const boardIdProperty = {
  type: 'string',
  description: '看板 ID；缺省使用第一个看板',
}
const limitProperty = (max, fallback, description) => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
  description,
})

const approvalOptionSchema = {
  oneOf: [
    { type: 'string', maxLength: LIMITS.approvalOption },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', maxLength: 40 },
        label: { type: 'string', maxLength: LIMITS.approvalOption },
        description: { type: 'string', maxLength: 300 },
        tone: { type: 'string', enum: APPROVAL_TONES },
        outcome: { type: 'string', enum: APPROVAL_OUTCOMES },
      },
      required: ['label'],
    },
  ],
}

const approvalOptionsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: LIMITS.approvalOptions,
  items: approvalOptionSchema,
  description: '1-8 个审批选项',
}

function toolOk(payload) {
  return JSON.stringify({ ok: true, ...payload })
}

function toolErr(error) {
  if (error instanceof DomainError) {
    return JSON.stringify({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.extra !== undefined ? { extra: error.extra } : {}),
      },
    })
  }
  if (error instanceof CloudSyncError) throw error
  const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'INTERNAL'
  const message = code === 'INTERNAL' ? '云端看板操作未完成，请稍后重试' : String(error?.message || '操作失败')
  return JSON.stringify({ ok: false, error: { code, message } })
}

async function runTool(work) {
  try {
    return toolOk(await work())
  } catch (error) {
    return toolErr(error)
  }
}

/**
 * 构造云端 MCP 工具注册表。
 * @param {object} options
 * @param {object} options.db             Cloudflare D1 绑定
 * @param {Function} options.enqueueWrite `({ tool, args, preferredCardId, agentName, now }) => Promise<{ id, seq, duplicate, receivedAt }>`
 * @param {number} [options.now]
 */
export function createCloudMcpRegistry({ db, enqueueWrite, now = Date.now() } = {}) {
  const queueToolCall = async (tool, rawArgs, exec, { preferredCardId } = {}) => {
    const { args, strippedFields } = sanitizeCloudMcpWriteArgs(tool, rawArgs)
    const agentName = trimStr(exec?.agent?.name) || 'Cloud MCP Agent'
    const queued = await enqueueWrite({
      tool,
      args,
      ...(preferredCardId ? { preferredCardId } : {}),
      agentName,
      now,
    })
    return {
      queued: true,
      inboxId: queued.id,
      seq: queued.seq,
      duplicate: Boolean(queued.duplicate),
      receivedAt: queued.receivedAt,
      tool,
      ...(strippedFields.length ? { strippedFields } : {}),
      hint: queuedWriteHint(strippedFields),
    }
  }

  const tools = [
    {
      name: 'kanban_boards',
      description: '列出 DSH 看板及每个看板四列（待办/进行中/待你确认/已完成）的卡片数量（直读云端 D1 镜像，Mac 休眠也可实时读取）。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => runTool(async () => {
        const data = await loadD1Snapshot(db, now)
        const activeCards = data.cards.filter(card => !card.archived)
        return {
          boards: data.boards.map(board => ({
            id: board.id,
            name: board.name,
            ...(board.description ? { description: board.description } : {}),
            counts: countsFor(activeCards, board.id),
            updatedAt: board.updatedAt,
          })),
          revision: data.meta.revision,
          source: 'cloud-d1',
          ...pendingSyncExtra(data.pendingCloudWrites),
          hint: '用 kanban_cards 按看板/项目/状态查询卡片；用 kanban_card 看单卡详情与时间线。',
        }
      }),
    },

    {
      name: 'kanban_cards',
      description: '查询看板卡片摘要列表，支持按看板、状态、项目、标签、关键词过滤（直读云端 D1 镜像，只读）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boardId: boardIdProperty,
          status: { type: 'string', enum: STATUSES, description: '按状态精确过滤' },
          project: { type: 'string', maxLength: 120, description: '按项目名过滤（不区分大小写，如 dsh-kanban）' },
          label: { type: 'string', maxLength: 24, description: '按标签过滤（不区分大小写）' },
          q: { type: 'string', maxLength: 200, description: '关键词，匹配标题/摘要/当前动作/项目/标签' },
          includeArchived: { type: 'boolean', default: false, description: '是否包含已归档卡片，默认 false' },
          limit: limitProperty(100, 20, '最多返回多少张，默认 20'),
        },
      },
      execute: args => runTool(async () => {
        const data = await loadD1Snapshot(db, now)
        const boardId = cleanText(args.boardId, 120) || data.boards[0]?.id || DEFAULT_BOARD_ID
        if (!data.boards.some(board => board.id === boardId)) {
          throw new DomainError('BOARD_NOT_FOUND', '看板不存在', 404)
        }
        if (args.status !== undefined) normalizeStatus(args.status)
        const project = cleanText(args.project, 120).toLowerCase()
        const label = cleanText(args.label, 24).toLowerCase()
        const query = cleanText(args.q, 200).toLowerCase()
        const includeArchived = args.includeArchived === true
        const limit = Math.min(100, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20))

        const matched = data.cards.filter(card => {
          if (card.boardId !== boardId) return false
          if (!includeArchived && card.archived) return false
          if (args.status && card.status !== args.status) return false
          if (project && String(card.project || '').toLowerCase() !== project) return false
          if (label && !(card.labels || []).some(item => String(item).toLowerCase() === label)) return false
          if (query) {
            const haystack = [
              card.title,
              card.summary,
              card.currentAction,
              card.project,
              ...(card.labels || []),
            ].join('\n').toLowerCase()
            if (!haystack.includes(query)) return false
          }
          return true
        }).sort((a, b) => b.updatedAt - a.updatedAt)

        const activeCards = data.cards.filter(card => !card.archived)
        return {
          boardId,
          cards: matched.slice(0, limit).map(cardBrief),
          total: matched.length,
          counts: countsFor(activeCards, boardId),
          revision: data.meta.revision,
          source: 'cloud-d1',
          ...pendingSyncExtra(data.pendingCloudWrites),
        }
      }),
    },

    {
      name: 'kanban_card',
      description: '读取单张卡片完整详情：摘要、当前动作、checklist、待决策审批、产物、父子/依赖关系与最近时间线（直读云端 D1 镜像）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: cardIdProperty,
          activityLimit: limitProperty(100, 30, '返回最近多少条时间线节点，默认 30'),
        },
        required: ['cardId'],
      },
      execute: args => runTool(async () => {
        assertCardId(args.cardId)
        const limit = Math.min(100, Math.max(1, Number.isInteger(args.activityLimit) ? args.activityLimit : 30))
        const [metaRes, cardRes, actRes, childrenRes, pendingRes] = await db.batch([
          db.prepare('SELECT revision FROM sync_meta WHERE id = 1'),
          db.prepare('SELECT id, board_id, title, status, priority, project, external_ref, parent_card_id, version, archived, created_at, updated_at, completed_at, payload FROM cards WHERE id = ?').bind(args.cardId),
          db.prepare('SELECT id, card_id, board_id, type, actor_kind, actor_name, text, at, payload FROM activities WHERE card_id = ? ORDER BY at DESC, id DESC LIMIT ?').bind(args.cardId, limit),
          db.prepare('SELECT id, board_id, title, status, priority, project, external_ref, parent_card_id, version, archived, created_at, updated_at, completed_at, payload FROM cards WHERE parent_card_id = ? AND archived = 0 ORDER BY updated_at DESC').bind(args.cardId),
          db.prepare("SELECT COUNT(*) AS cnt FROM ingress_inbox WHERE event_type = 'mcp_tool_call' AND status IN ('pending', 'leased') AND expires_at > ?").bind(now),
        ])
        const metaRow = rowsOf(metaRes)[0]
        if (!metaRow) {
          throw new CloudSyncError('UNAVAILABLE', 'sync_meta 未初始化：请先执行 wrangler d1 migrations apply', { status: 503 })
        }
        const cardRow = rowsOf(cardRes)[0]
        if (!cardRow) {
          throw new DomainError('CARD_NOT_FOUND', '卡片不存在或尚未同步到云端镜像', 404)
        }
        const card = hydrateCard(cardRow)
        if (card.archived) {
          throw new DomainError('CARD_NOT_FOUND', '卡片已归档（如需查看归档卡，可在 kanban_cards 传 includeArchived:true）', 404)
        }
        const activities = rowsOf(actRes).map(hydrateActivity)
        const children = rowsOf(childrenRes).map(hydrateCard).map(cardBrief)

        let dependsOnCards = []
        if (Array.isArray(card.dependsOn) && card.dependsOn.length > 0) {
          const depIds = card.dependsOn.slice(0, LIMITS.dependsOn)
          const placeholders = depIds.map(() => '?').join(', ')
          const depRows = rowsOf(await db.prepare(
            `SELECT id, board_id, title, status, priority, project, external_ref, parent_card_id, version, archived, created_at, updated_at, completed_at, payload FROM cards WHERE id IN (${placeholders})`,
          ).bind(...depIds).all())
          const depMap = new Map(depRows.map(row => {
            const hydrated = hydrateCard(row)
            return [hydrated.id, cardBrief(hydrated)]
          }))
          dependsOnCards = depIds.map(depId => depMap.get(depId) || { id: depId, missing: true })
        }

        const pending = (card.approvals || []).find(approval => approval.status === 'pending')
        const openChildren = children.filter(item => item.status !== 'done' && item.status !== 'canceled')
        const pendingCloudWrites = toInt(rowsOf(pendingRes)[0]?.cnt, 0)

        return {
          card,
          activities,
          pendingApproval: pending || null,
          questions: pending?.questions ?? [],
          children,
          dependsOnCards,
          revision: toInt(metaRow.revision, 0),
          source: 'cloud-d1',
          ...pendingSyncExtra(pendingCloudWrites),
          hint: openChildren.length
            ? `${hintFor(card)} 还有 ${openChildren.length} 张未收口子卡，完成前需先收口（或 force 强完成）。`
            : hintFor(card),
        }
      }),
    },

    {
      name: 'kanban_review_board',
      description: '看板收敛巡检（只读，基于云端 D1 镜像）：找出陈旧待办、已完成未归档与疑似重复卡片。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boardId: boardIdProperty,
          staleDays: limitProperty(365, 7, '待办超过多少天未更新算陈旧，默认 7'),
          limit: limitProperty(100, 20, '每个分组最多返回多少条样例，默认 20'),
        },
      },
      execute: args => runTool(async () => {
        const data = await loadD1Snapshot(db, now)
        const report = reviewBoard(data, {
          boardId: cleanText(args.boardId, 120) || undefined,
          staleDays: args.staleDays,
          limit: args.limit,
          now,
        })
        // 云端镜像按契约剥离了 cwd 与 sessionIds，剔除由脱敏引起的假孤儿提示
        const filteredSuggestions = (report.suggestions || []).filter(text => !text.includes('没有执行目录（cwd）'))
        return {
          ...report,
          orphans: { count: 0, sample: [], cloudRedacted: true },
          suggestions: filteredSuggestions,
          revision: data.meta.revision,
          source: 'cloud-d1',
          ...pendingSyncExtra(data.pendingCloudWrites),
          cloudMirrorNote: '云端镜像已按安全契约脱敏剥离 cwd 与 sessionIds，仅统计陈旧待办、已完成未归档与疑似重复卡。',
        }
      }),
    },

    {
      name: 'kanban_create_card',
      description: '创建一张新看板卡片（云端安全入队，预分配确定性 cardId 可立即供后续工具串联调用；本地 Mac 在线/唤醒后自动回放落盘）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boardId: boardIdProperty,
          title: { type: 'string', maxLength: LIMITS.title, description: '卡片标题（必填，≤120 字）' },
          summary: { type: 'string', maxLength: LIMITS.summary, description: '摘要（≤600 字）' },
          status: { type: 'string', enum: STATUSES, default: 'backlog' },
          priority: { type: 'string', enum: PRIORITIES, default: 'none' },
          labels: { type: 'array', items: { type: 'string', maxLength: LIMITS.label }, maxItems: LIMITS.labels },
          project: { type: 'string', maxLength: 120, description: '项目名，如 dsh-kanban' },
          externalRef: { type: 'string', maxLength: 200 },
          parentCardId: {
            oneOf: [
              { type: 'string', maxLength: 160 },
              { type: 'null' },
            ],
          },
          dependsOn: { type: 'array', items: cardIdProperty, maxItems: LIMITS.dependsOn },
          autoStart: { type: 'boolean', default: false },
          checklists: {
            type: 'array',
            maxItems: LIMITS.checklists,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                text: { type: 'string', maxLength: LIMITS.checklistText },
                done: { type: 'boolean' },
              },
              required: ['text'],
            },
          },
          forceNew: { type: 'boolean', default: false },
        },
        required: ['title'],
      },
      execute: (args, exec) => runTool(async () => {
        const preferredCardId = newCardId()
        const { args: cleanArgs } = sanitizeCloudMcpWriteArgs('kanban_create_card', args)
        const queued = await queueToolCall('kanban_create_card', args, exec, { preferredCardId })
        return {
          ...queued,
          cardId: preferredCardId,
          card: {
            id: preferredCardId,
            boardId: cleanArgs.boardId || DEFAULT_BOARD_ID,
            title: cleanArgs.title,
            summary: cleanArgs.summary || '',
            status: cleanArgs.status || 'backlog',
            priority: cleanArgs.priority || 'none',
            labels: cleanArgs.labels || [],
            ...(cleanArgs.project ? { project: cleanArgs.project } : {}),
          },
        }
      }),
    },

    {
      name: 'kanban_update_card',
      description: '更新卡片字段（标题/摘要/currentAction/result/状态/优先级/标签/项目/progress/checklists/artifacts/handoff/父卡/依赖；云端安全入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: cardIdProperty,
          title: { type: 'string', maxLength: LIMITS.title },
          summary: { type: 'string', maxLength: LIMITS.summary },
          currentAction: { type: 'string', maxLength: LIMITS.currentAction },
          result: { type: 'string', maxLength: LIMITS.result },
          status: { type: 'string', enum: STATUSES },
          priority: { type: 'string', enum: PRIORITIES },
          labels: { type: 'array', items: { type: 'string', maxLength: LIMITS.label }, maxItems: LIMITS.labels },
          project: { type: 'string', maxLength: 120 },
          externalRef: { type: 'string', maxLength: 200 },
          parentCardId: { oneOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }] },
          dependsOn: { type: 'array', items: cardIdProperty, maxItems: LIMITS.dependsOn },
          autoStart: { type: 'boolean' },
          forceComplete: { type: 'boolean', default: false },
          agent: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', maxLength: 80 },
              id: { type: 'string', maxLength: 160 },
              harness: { type: 'string', maxLength: 40 },
            },
            required: ['name'],
          },
          progress: {
            type: 'object',
            additionalProperties: false,
            properties: {
              step: { type: 'integer', minimum: 0 },
              total: { type: 'integer', minimum: 0 },
              percent: { type: 'integer', minimum: 0, maximum: 100 },
              text: { type: 'string', maxLength: LIMITS.progressText },
            },
          },
          checklists: {
            type: 'array',
            maxItems: LIMITS.checklists,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                text: { type: 'string', maxLength: LIMITS.checklistText },
                done: { type: 'boolean' },
              },
              required: ['text'],
            },
          },
          artifacts: {
            type: 'array',
            maxItems: LIMITS.artifacts,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['file', 'link', 'report', 'commit', 'image'] },
                label: { type: 'string', maxLength: 120 },
                url: { type: 'string', maxLength: 2000 },
              },
              required: ['label'],
            },
          },
          metadata: {
            type: 'object',
            additionalProperties: false,
            properties: {
              toolCalls: { type: 'integer', minimum: 0 },
              searches: { type: 'integer', minimum: 0 },
              elapsedMs: { type: 'integer', minimum: 0 },
              tokensIn: { type: 'integer', minimum: 0 },
              tokensOut: { type: 'integer', minimum: 0 },
            },
          },
          handoff: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  summary: { type: 'string', maxLength: LIMITS.handoffSummary },
                  nextSteps: { type: 'string', maxLength: LIMITS.handoffNextSteps },
                },
                required: ['summary'],
              },
            ],
          },
        },
        required: ['cardId'],
      },
      execute: (args, exec) => runTool(async () => {
        const queued = await queueToolCall('kanban_update_card', args, exec)
        return { ...queued, cardId: args.cardId }
      }),
    },

    {
      name: 'kanban_move_card',
      description: '把卡片移动到指定列（backlog/running/needs_you/done）或指定状态，并写入时间线（云端安全入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: cardIdProperty,
          column: { type: 'string', enum: COLUMNS },
          status: { type: 'string', enum: STATUSES },
          text: { type: 'string', maxLength: 200 },
          forceComplete: { type: 'boolean', default: false },
        },
        required: ['cardId'],
      },
      execute: (args, exec) => runTool(async () => {
        const queued = await queueToolCall('kanban_move_card', args, exec)
        return { ...queued, cardId: args.cardId }
      }),
    },

    {
      name: 'kanban_add_activity',
      description: '给卡片时间线追加一条进展/评论/结果/错误节点（云端安全入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: cardIdProperty,
          text: { type: 'string', maxLength: LIMITS.activityText },
          type: { type: 'string', enum: ACTIVITY_INPUT_TYPES, default: 'progress' },
          data: { type: 'object' },
          metadata: {
            type: 'object',
            additionalProperties: false,
            properties: {
              toolCalls: { type: 'integer', minimum: 0 },
              searches: { type: 'integer', minimum: 0 },
              elapsedMs: { type: 'integer', minimum: 0 },
              tokensIn: { type: 'integer', minimum: 0 },
              tokensOut: { type: 'integer', minimum: 0 },
            },
          },
        },
        required: ['cardId', 'text'],
      },
      execute: (args, exec) => runTool(async () => {
        const queued = await queueToolCall('kanban_add_activity', args, exec)
        return { ...queued, cardId: args.cardId }
      }),
    },

    {
      name: 'kanban_request_approval',
      description: '向看板请求用户决策审批（卡片进入「待你确认」列；云端安全入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: cardIdProperty,
          title: { type: 'string', maxLength: LIMITS.approvalTitle },
          detail: { type: 'string', maxLength: LIMITS.approvalDetail },
          options: approvalOptionsSchema,
          multiSelect: { type: 'boolean', default: false },
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: LIMITS.approvalQuestions,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', maxLength: 40 },
                header: { type: 'string', maxLength: LIMITS.approvalQuestionHeader },
                question: { type: 'string', maxLength: LIMITS.approvalQuestion },
                multiSelect: { type: 'boolean', default: false },
                options: approvalOptionsSchema,
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['cardId'],
      },
      execute: (args, exec) => runTool(async () => {
        const queued = await queueToolCall('kanban_request_approval', args, exec)
        return { ...queued, cardId: args.cardId }
      }),
    },

    {
      name: 'kanban_complete_card',
      description: '把卡片标记为已完成并写入交付结果与验收说明（云端安全入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: cardIdProperty,
          result: { type: 'string', maxLength: LIMITS.result, description: '完成结果：做了什么、产出在哪、如何验收（必填）' },
          force: { type: 'boolean', default: false },
        },
        required: ['cardId', 'result'],
      },
      execute: (args, exec) => runTool(async () => {
        const queued = await queueToolCall('kanban_complete_card', args, exec)
        return { ...queued, cardId: args.cardId }
      }),
    },

    {
      name: 'kanban_merge_cards',
      description: '把源卡合并进目标卡并归档源卡（dryRun:true 直读 D1 实时预览，dryRun:false 云端入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceCardId: cardIdProperty,
          targetCardId: cardIdProperty,
          title: { type: 'string', maxLength: LIMITS.title },
          dryRun: { type: 'boolean', default: false },
        },
        required: ['sourceCardId', 'targetCardId'],
      },
      execute: (args, exec) => runTool(async () => {
        assertCardId(args.sourceCardId, 'sourceCardId')
        assertCardId(args.targetCardId, 'targetCardId')
        if (args.dryRun === true) {
          const data = await loadD1Snapshot(db, now)
          const preview = mergeCards(data, args.sourceCardId, args.targetCardId, { title: args.title, dryRun: true })
          return {
            dryRun: true,
            source: preview.source,
            target: preview.target,
            willMoveChildren: preview.willMoveChildren,
            willRepointDependsOn: preview.willRepointDependsOn,
            willMoveSessions: preview.willMoveSessions,
            willAppendSummary: preview.willAppendSummary,
            warnings: preview.warnings,
            revision: data.meta.revision,
          }
        }
        return queueToolCall('kanban_merge_cards', args, exec)
      }),
    },

    {
      name: 'kanban_archive_cards',
      description: '批量归档或恢复卡片（dryRun:true 直读 D1 实时预览，dryRun:false 云端入队回放）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardIds: {
            type: 'array',
            minItems: 1,
            maxItems: LIMITS.batchCards,
            items: cardIdProperty,
          },
          reason: { type: 'string', maxLength: 200 },
          restore: { type: 'boolean', default: false },
          dryRun: { type: 'boolean', default: false },
        },
        required: ['cardIds'],
      },
      execute: (args, exec) => runTool(async () => {
        const cardIds = Array.isArray(args.cardIds) ? args.cardIds : []
        const restore = args.restore === true
        if (args.dryRun === true) {
          const data = await loadD1Snapshot(db, now)
          const preview = restore
            ? restoreCards(data, cardIds, { dryRun: true })
            : archiveCards(data, cardIds, { dryRun: true })
          return restore
            ? { dryRun: true, wouldRestore: preview.wouldRestore, skipped: preview.skipped, revision: data.meta.revision }
            : { dryRun: true, wouldArchive: preview.wouldArchive, skipped: preview.skipped, revision: data.meta.revision }
        }
        return queueToolCall('kanban_archive_cards', args, exec)
      }),
    },
  ]

  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return {
    list() {
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
    },
    get(name) {
      return byName.get(name) || null
    },
  }
}

/** 构造一条待写入 `ingress_inbox` 的 `mcp_tool_call` 信封载荷。 */
export function buildCloudMcpIngressPayload({
  tool,
  args,
  preferredCardId,
  agentName = 'Cloud MCP Agent',
  mcpCallId,
  now = Date.now(),
} = {}) {
  const callId = trimStr(mcpCallId) || `mcp-${randomUUID()}`
  return {
    mcpCallId: callId,
    payload: {
      kind: 'mcp_tool_call',
      mcpCallId: callId,
      tool,
      arguments: args,
      ...(preferredCardId ? { preferredCardId } : {}),
      actor: {
        kind: 'agent',
        name: cleanText(agentName, LIMITS.agentName) || 'Cloud MCP Agent',
      },
      requestedAt: now,
    },
  }
}

async function handleSingleMcpMessage(message, { registry, agentName, harness }) {
  if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: isPlainObject(message) && message.id !== undefined ? message.id : null,
      error: { code: -32600, message: 'Invalid Request' },
    }
  }

  const { id, method, params } = message

  // JSON-RPC Notification（例如 notifications/initialized）：无响应体（HTTP 202）
  if (id === undefined) {
    return null
  }

  try {
    if (method === 'initialize') {
      const requestedVersion = trimStr(params?.protocolVersion)
      const negotiatedVersion = CLOUD_MCP_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : DEFAULT_CLOUD_MCP_PROTOCOL_VERSION
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: CLOUD_MCP_SERVER_INFO,
        },
      }
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: registry.list() },
      }
    }

    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    }

    if (method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    }

    if (method === 'tools/call') {
      const toolName = params?.name
      if (params?.arguments !== undefined && !isPlainObject(params.arguments)) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid tool arguments: expected JSON object' },
        }
      }
      const toolArgs = isPlainObject(params?.arguments) ? params.arguments : {}
      const tool = registry.get(toolName)
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${String(toolName)}` },
        }
      }
      const rawOutput = await tool.execute(toolArgs, {
        agent: { id: `${harness}:${agentName}`, name: agentName },
      })
      let parsed = null
      try { parsed = JSON.parse(rawOutput) } catch { parsed = null }
      const isError = Boolean(parsed && parsed.ok === false)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String(rawOutput) }],
          ...(isError ? { isError: true } : {}),
        },
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    }
  } catch (error) {
    if (error instanceof CloudSyncError) throw error
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error?.message || 'Internal MCP server error',
      },
    }
  }
}

/**
 * 处理 Streamable HTTP JSON-RPC 2.0 消息（支持单条对象或批量数组）。
 * 若全部输入均为 notification（无 id），返回 `null`，调用方按规范响应 `202 Accepted`（空响应体）。
 */
export async function handleCloudMcpJsonRpc(message, {
  db,
  enqueueWrite,
  now = Date.now(),
  agentName = 'Cloud MCP Agent',
  harness = 'cloud-mcp',
} = {}) {
  const registry = createCloudMcpRegistry({ db, enqueueWrite, now })
  if (Array.isArray(message)) {
    if (message.length === 0) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } }
    }
    const responses = []
    for (const item of message) {
      const res = await handleSingleMcpMessage(item, { registry, agentName, harness })
      if (res !== null) responses.push(res)
    }
    return responses.length > 0 ? responses : null
  }
  return handleSingleMcpMessage(message, { registry, agentName, harness })
}
