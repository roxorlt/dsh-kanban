// 云同步守护器（C3）：本地看板 ↔ 云端控制面的增量镜像与入站回放。
//
// 边界（见 docs/contracts/08-cloud-sync.md）：
// - 本地 `data.json` 是唯一权威写者；云端只是**只读镜像 + 休眠期入站暂存队列**，
//   本模块永不把云端对象写回本地业务状态；
// - 只有 `<dataDir>/cloud-config.json` 存在且 `enabled:true` 时才产生任何网络请求；
//   缺失/关闭/非法配置一律静默降级（不建定时器、不 fetch），本地看板零影响；
// - 仓库零密钥：令牌只从 cloud-config.json 读取，日志与状态接口只用 `describeCloudConfig` 掩码。
//
// 三条后台循环：
// 1) push：Store 变更 → 防抖（默认 2s）+ 定时兜底（30s）→ toCloudSnapshot → diff → 分片串行 push；
// 2) pull：冷启动 / 409 REVISION_CONFLICT 追平 / 云端 epoch 重建后按窗口分页重建「已推送镜像」；
// 3) ingress：定时（默认 30s）/ 唤醒时 claim → 本地 `/api/kanban/ingress` 回放 → ACK（acked/dead/retry）。
//
// 失败语义严格按契约 §5.3 / §10：401 停止重试（提示修配置）；429/5xx/网络错误指数退避
// （1s→60s，含抖动）；400 等业务性错误不自动重试，等下一次本地变更或人工处理。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOUD_CONFIG_FILE_NAME,
  CLOUD_PROTOCOL_VERSION,
  CLOUD_SYNC_LIMITS,
  CloudSyncError,
  applyDeltaToCloudSnapshot,
  buildLocalIngressRequest,
  chunkDelta,
  countDelta,
  describeCloudConfig,
  diffCloudSnapshots,
  emptyCloudSnapshot,
  hashPushId,
  isEmptyDelta,
  isIngressExpired,
  normalizeCloudConfig,
  pullResponseToDelta,
  toCloudSnapshot,
} from './cloud-sync-protocol.js'
import { loadRuntimeOrigin } from './im-notifier.js'

/** 本地（看板服务）云同步状态查询接口；`GET` 只读，不含令牌明文。 */
export const CLOUD_STATUS_PATH = '/api/kanban/cloud/status'

/** 本地入站回放路径（与 lib/routes.js 的 ingressRoute 对齐）。 */
export const LOCAL_INGRESS_PATH = '/api/kanban/ingress'

/**
 * 本地回放返回这些 4xx 错误码时视为「业务上已处理过」→ 按 acked 收口，
 * 避免同一条入站事件在本地无限重试（契约 §8.7「已处理过类 4xx 按 acked」）。
 */
export const INGRESS_HANDLED_4XX_CODES = Object.freeze([
  'CONFLICT',
  'CARD_NOT_FOUND',
  'APPROVAL_NOT_FOUND',
  'NOT_FOUND',
  'ALREADY_RESOLVED',
])

const DEFAULT_TIMING = Object.freeze({
  /** Store 变更后的推送防抖（契约默认 2s）。 */
  pushDebounceMs: 2000,
  /** 定时兜底同步（也是「唤醒间隙」探测点，契约默认 30s）。 */
  pullIntervalMs: 30000,
  /** 入站 claim 轮询间隔（契约默认 30s）。 */
  claimIntervalMs: 30000,
  /** 指数退避基数与上限（契约 §5.3：1s→60s 含抖动）。 */
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  /** 单次云端请求超时。 */
  requestTimeoutMs: 10000,
  /** 单次本地回放请求超时。 */
  localRequestTimeoutMs: 10000,
  /** stop() 给「当前在途 claim 条目」的收尾宽限（读完当前这条就停，不再跑整批）。 */
  stopClaimGraceMs: 2500,
  /** stop() 补发残留 ACK 的最长等待；ACK 网络黑洞时不能把插件卸载拖到请求超时（10s）。 */
  stopFlushAckMs: 2000,
})

const MAX_PUSH_ENTITIES = CLOUD_SYNC_LIMITS.pushEntities
const PUSH_CONFLICT_RETRIES = 2
const PUSH_413_SPLIT_DEPTH = 8
const CONFIG_FILE_MODE_MASK = 0o077

function safeLogger(logger) {
  const sink = logger && typeof logger === 'object' ? logger : {}
  return {
    info: (...args) => { try { sink.info?.(...args) } catch {} },
    warn: (...args) => { try { sink.warn?.(...args) } catch {} },
    error: (...args) => { try { sink.error?.(...args) } catch {} },
  }
}

/** `<dataDir>/cloud-config.json` 的绝对路径；dataDir 缺失时返回 null。 */
export function cloudConfigPath(dataDir) {
  return dataDir ? join(dataDir, CLOUD_CONFIG_FILE_NAME) : null
}

/**
 * 读取并校验本地 `cloud-config.json`（不抛错，返回状态对象供调用方静默降级）：
 *   { status: 'missing' }                              未配置 → 零网络
 *   { status: 'disabled', config }                     显式 enabled:false → 零网络
 *   { status: 'invalid', error, file }                 配置非法/权限不安全 → 零网络 + 警告
 *   { status: 'ready', config, file, warnings }        可启动
 * 权限检查（POSIX）：文件不得有 group/other 位（必须 0600），否则按 fail-closed 拒绝启用，
 * 避免令牌被同机其它用户读取。
 */
export function readCloudConfig(dataDir, { configFile, checkPermissions = true, logger } = {}) {
  const file = configFile || cloudConfigPath(dataDir)
  if (!file) return { status: 'missing', file: null }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', file }
    const message = `读取 ${CLOUD_CONFIG_FILE_NAME} 失败：${error?.message || error}`
    safeLogger(logger).warn(`[dsh-kanban] 云同步：${message}`)
    return { status: 'invalid', file, error: { code: 'BAD_CONFIG', message } }
  }
  if (checkPermissions && process.platform !== 'win32') {
    try {
      const mode = statSync(file).mode & 0o777
      if ((mode & CONFIG_FILE_MODE_MASK) !== 0) {
        const message = `${CLOUD_CONFIG_FILE_NAME} 权限应为 0600（当前 ${mode.toString(8).padStart(3, '0')}），已拒绝启用云同步；请执行 chmod 600`
        safeLogger(logger).warn(`[dsh-kanban] 云同步：${message}`)
        return { status: 'invalid', file, error: { code: 'BAD_CONFIG', message } }
      }
    } catch (error) {
      const message = `无法检查 ${CLOUD_CONFIG_FILE_NAME} 权限：${error?.message || error}`
      safeLogger(logger).warn(`[dsh-kanban] 云同步：${message}`)
      return { status: 'invalid', file, error: { code: 'BAD_CONFIG', message } }
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const message = `${CLOUD_CONFIG_FILE_NAME} 不是合法 JSON`
    safeLogger(logger).warn(`[dsh-kanban] 云同步：${message}`)
    return { status: 'invalid', file, error: { code: 'BAD_CONFIG', message } }
  }
  try {
    const config = normalizeCloudConfig(parsed)
    return { status: config.enabled ? 'ready' : 'disabled', config, file, warnings: [] }
  } catch (error) {
    const message = error?.message || 'cloud-config.json 校验失败'
    safeLogger(logger).warn(`[dsh-kanban] 云同步：${message}`)
    return {
      status: 'invalid',
      file,
      error: { code: error?.code || 'BAD_CONFIG', message },
    }
  }
}

/**
 * 指数退避（契约 §5.3）：第 n 次连续失败 → base * 2^(n-1)，上限 maxMs，含 ±20% 抖动。
 * 纯函数，抽出来便于确定性单测；`random` 可注入。
 */
export function cloudRetryDelay(failures, { baseMs = DEFAULT_TIMING.retryBaseMs, maxMs = DEFAULT_TIMING.retryMaxMs, random = Math.random } = {}) {
  const count = Math.max(1, Math.floor(Number(failures) || 1))
  const base = Math.max(1, Math.floor(Number(baseMs) || DEFAULT_TIMING.retryBaseMs))
  const cap = Math.max(base, Math.floor(Number(maxMs) || DEFAULT_TIMING.retryMaxMs))
  const exponent = Math.min(16, count - 1)
  const raw = Math.min(cap, base * 2 ** exponent)
  const jitter = 0.8 + Math.min(1, Math.max(0, Number(random()) || 0)) * 0.4
  return Math.max(1, Math.round(Math.min(cap, raw * jitter)))
}

/**
 * 把本地 `/api/kanban/ingress` 的响应映射为 ACK outcome（契约 §8.5）：
 * - 2xx → acked；
 * - 4xx 且为「已处理过」类业务错误 → acked；
 * - 其它 4xx / 3xx → dead（不可重试，避免死循环）；
 * - 5xx / 网络错误（status=0）→ retry（云端按 nextIngressAttempt 退避，20 次后 dead）。
 */
export function classifyLocalIngressResponse({ status = 0, body, error } = {}) {
  const numeric = Number(status) || 0
  if (numeric >= 200 && numeric < 300) return { outcome: 'acked' }
  if (numeric >= 500) return { outcome: 'retry', error: error || `本地看板 HTTP ${numeric}` }
  if (numeric === 0) return { outcome: 'retry', error: error || '本地看板不可达' }
  if (numeric >= 400 && numeric < 500) {
    const code = body && typeof body === 'object' ? body?.error?.code : ''
    if (code && INGRESS_HANDLED_4XX_CODES.includes(code)) {
      return { outcome: 'acked', note: `本地已处理过（${code}）` }
    }
    const message = body && typeof body === 'object' && body?.error?.message
      ? body.error.message
      : `本地看板 HTTP ${numeric}`
    return { outcome: 'dead', error: String(message).slice(0, 500) }
  }
  return { outcome: 'dead', error: `本地看板非预期响应 HTTP ${numeric}` }
}

function networkError(message) {
  const error = new CloudSyncError('NETWORK', String(message || '网络不可达'), { status: 0 })
  error.retryable = true
  return error
}

function errorStatus(error) {
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status
  return 0
}

function isRetryableError(error) {
  if (error?.retryable === true) return true
  const status = errorStatus(error)
  if (status === 0 || status === 429 || status >= 500) return true
  return error?.code === 'UNAVAILABLE' || error?.code === 'NETWORK'
}

/**
 * 本地回放地址必须是本机回环（http/https + 127.0.0.1 / localhost / ::1）：
 * runtime-endpoint.json 与 localOrigin 都可能被本机文件篡改，限制在回环可避免
 * 把云端暂存的入站载荷（可能含 IM 消息内容）POST 到任意远端地址。
 */
function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string') return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

function briefError(error) {
  return {
    code: error?.code || 'UNKNOWN',
    message: String(error?.message || error || '未知错误').slice(0, 500),
    status: errorStatus(error) || undefined,
  }
}

function bodyToJson(text) {
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * 创建云同步守护器。构造本身**零 I/O、零网络**；只有 start() 在配置就绪后才启动循环。
 *
 * @param {object} options
 * @param {object} options.store                     本地 Store（需提供 read/subscribe/ready）
 * @param {string} [options.dataDir]                 数据目录（默认取 store.dataDir）
 * @param {object} [options.logger]                  宿主 logger（info/warn/error）
 * @param {Function} [options.fetchImpl]             云端请求实现（默认 globalThis.fetch；测试可注入）
 * @param {Function} [options.localFetchImpl]        本地回放请求实现（默认同 fetchImpl）
 * @param {string} [options.configFile]              cloud-config.json 路径覆盖（测试/多实例）
 * @param {string} [options.localOrigin]             本地看板 origin 覆盖（默认读 runtime-endpoint.json）
 * @param {Function} [options.now]                   时钟注入（测试用）
 * @param {object} [options.timing]                  时序覆盖（测试用；优先级高于 config 默认值）
 */
export function createCloudSyncClient(options = {}) {
  const store = options.store
  if (!store || typeof store.read !== 'function') throw new Error('createCloudSyncClient 需要 store')
  const dataDir = options.dataDir || store.dataDir || ''
  const logger = safeLogger(options.logger)
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (...args) => globalThis.fetch(...args)
  const localFetchImpl = typeof options.localFetchImpl === 'function'
    ? options.localFetchImpl
    : fetchImpl
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timingOverrides = options.timing && typeof options.timing === 'object' ? options.timing : {}
  const configFile = options.configFile || cloudConfigPath(dataDir)

  /** 显式注入的本地 origin（测试/高级用法）；生产从 runtime-endpoint.json 发现。 */
  let localOriginOverride = isLoopbackOrigin(options.localOrigin)
    ? options.localOrigin.replace(/\/+$/, '')
    : ''

  let configInfo = { status: 'missing', file: configFile }
  let timing = { ...DEFAULT_TIMING, ...timingOverrides }
  let running = false
  let stopped = false
  let started = false
  let unsubscribe = null

  /** 云端副本镜像：最近一次成功 push/pull 后的脱敏快照（永不由它改写本地状态）。 */
  let mirror = null
  let baseRevision = 0
  let epoch = ''

  let pushRunning = false
  let pushQueued = false
  let pushChain = Promise.resolve()
  let claimRunning = false
  let claimQueued = false
  let claimChain = Promise.resolve()
  let pushRetryTimer = null
  let claimRetryTimer = null
  let debounceTimer = null
  let syncInterval = null
  let claimInterval = null
  const activeControllers = new Set()
  const lastTickAt = { sync: 0, claim: 0 }

  const state = {
    phase: 'idle',
    paused: false,
    pauseReason: '',
    running: false,
    configStatus: 'missing',
    clientId: '',
    baseRevision: 0,
    cloudRevision: 0,
    epoch: '',
    lastSyncAt: 0,
    lastPushAt: 0,
    lastPushStatus: '',
    lastPushEntities: 0,
    lastPullAt: 0,
    lastWakeAt: 0,
    lastWakeReason: '',
    debouncePending: false,
    pushFailures: 0,
    nextPushRetryAt: 0,
    lastPushError: null,
    claimFailures: 0,
    nextClaimRetryAt: 0,
    lastClaimError: null,
    claim: {
      lastClaimAt: 0,
      lastClaimed: 0,
      acked: 0,
      retried: 0,
      dead: 0,
      lastAckAt: 0,
      lastAckIgnored: 0,
    },
    haltedCode: '',
  }

  const config = () => (configInfo.status === 'ready' ? configInfo.config : null)

  function canUseCloud() {
    return running && !state.paused && Boolean(config())
  }

  /** 状态镜像是否启用（cloud-config.json 的 sync.enabled，默认 true）。 */
  function syncEnabled() {
    const cfg = config()
    return Boolean(cfg && cfg.sync.enabled !== false)
  }

  /** 入站回放是否启用（cloud-config.json 的 ingress.enabled，默认 true）。 */
  function ingressEnabled() {
    const cfg = config()
    return Boolean(cfg && cfg.ingress.enabled !== false)
  }

  function setPhase(phase) {
    state.phase = phase
  }

  function clearTimer(timer) {
    if (timer) clearTimeout(timer)
    return null
  }

  function abortActiveRequests() {
    for (const controller of activeControllers) {
      try { controller.abort() } catch {}
    }
    activeControllers.clear()
  }

  function applyTiming() {
    const cfg = config()
    timing = {
      ...DEFAULT_TIMING,
      ...(cfg ? {
        pushDebounceMs: cfg.sync.pushDebounceMs,
        pullIntervalMs: cfg.sync.pullIntervalMs,
        claimIntervalMs: cfg.ingress.claimIntervalMs,
      } : {}),
      ...timingOverrides,
    }
  }

  function resolveLocalOrigin() {
    if (localOriginOverride && isLoopbackOrigin(localOriginOverride)) return localOriginOverride
    if (typeof options.resolveLocalOrigin === 'function') {
      try {
        const resolved = options.resolveLocalOrigin()
        if (isLoopbackOrigin(resolved)) return resolved.replace(/\/+$/, '')
      } catch {}
    }
    if (!dataDir) return ''
    const discovered = loadRuntimeOrigin(dataDir, 'http://127.0.0.1:4599')
    return isLoopbackOrigin(discovered) ? discovered.replace(/\/+$/, '') : ''
  }

  // ---------------------------------------------------------------------
  // HTTP：云端（Bearer）与本地回放
  // ---------------------------------------------------------------------

  async function cloudRequest(pathname, { method = 'GET', body } = {}) {
    const cfg = config()
    if (!cfg) throw new CloudSyncError('BAD_CONFIG', '云同步未配置')
    const controller = new AbortController()
    activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timing.requestTimeoutMs)
    timer.unref?.()
    let response
    try {
      response = await fetchImpl(`${cfg.workerUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (error) {
      throw networkError(`云端请求失败（${pathname}）：${error?.message || error}`)
    } finally {
      clearTimeout(timer)
      activeControllers.delete(controller)
    }
    let text = ''
    try { text = await response.text() } catch {}
    const json = bodyToJson(text)
    if (!response.ok || json?.ok === false) {
      const code = json?.error?.code || 'HTTP_ERROR'
      const message = json?.error?.message || `云端响应 HTTP ${response.status}`
      throw new CloudSyncError(code, String(message).slice(0, 500), {
        status: response.status,
        details: json?.error?.details,
      })
    }
    return { status: response.status, json: json || {}, headers: response.headers }
  }

  async function localRequest(url, { headers, body } = {}) {
    const controller = new AbortController()
    activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timing.localRequestTimeoutMs)
    timer.unref?.()
    try {
      const response = await localFetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      let text = ''
      try { text = await response.text() } catch {}
      return { status: response.status, body: bodyToJson(text), text }
    } catch (error) {
      // 本地看板不可达：按可重试失败处理（守护器/路由可能尚未起来）
      return { status: 0, body: undefined, error: `本地看板不可达：${error?.message || error}` }
    } finally {
      clearTimeout(timer)
      activeControllers.delete(controller)
    }
  }

  // ---------------------------------------------------------------------
  // pull：分页重建云端镜像
  // ---------------------------------------------------------------------

  async function pullAll(reason = 'pull') {
    let since = 0
    let until = null
    let cursor = ''
    let snapshot = emptyCloudSnapshot()
    let seenEpoch = ''
    let pages = 0
    const limit = CLOUD_SYNC_LIMITS.pullEntities
    // 200 行/页 × 10000 页 = 200 万实体，远高于个人看板量级；触顶说明云端异常或游标失效，
    // 报可诊断错误（含已读页数）而不是静默无限重试。
    const maxPages = 10000
    for (;;) {
      if (!canUseCloud()) throw new CloudSyncError('BAD_CONFIG', '云同步已停止')
      const query = new URLSearchParams({ since: String(since), limit: String(limit) })
      if (until !== null) query.set('until', String(until))
      if (cursor) query.set('cursor', cursor)
      const { json } = await cloudRequest(`/v1/sync/pull?${query.toString()}`)
      seenEpoch = typeof json.epoch === 'string' ? json.epoch : seenEpoch
      until = Number.isInteger(json.until) ? json.until : since
      snapshot = applyDeltaToCloudSnapshot(snapshot, pullResponseToDelta(json), { revision: until })
      pages += 1
      if (!json.hasMore) break
      cursor = typeof json.cursor === 'string' ? json.cursor : (json.cursors?.cards || '')
      if (!cursor) throw new CloudSyncError('BAD_REQUEST', 'pull 分页缺少游标')
      if (pages >= maxPages) {
        throw new CloudSyncError('INTERNAL', `pull 分页超过 ${maxPages} 页仍未结束（可能云端游标异常或镜像规模超出预期），已中止本次重建`)
      }
    }
    mirror = snapshot
    baseRevision = until ?? 0
    epoch = seenEpoch || epoch
    state.baseRevision = baseRevision
    state.cloudRevision = baseRevision
    state.epoch = epoch
    state.lastPullAt = now()
    logger.info(`[dsh-kanban] 云同步：已拉取云端镜像 ${pages} 页至 revision=${baseRevision}（${reason}）`)
    return { revision: baseRevision, pages }
  }

  async function ensureMirror(reason) {
    if (mirror) return
    await pullAll(reason)
  }

  // ---------------------------------------------------------------------
  // push：增量 diff → 分片串行推送 → 维护镜像与 baseRevision
  // ---------------------------------------------------------------------

  async function pushOneChunk(chunk, { reset = false, splitDepth = 0 } = {}) {
    const cfg = config()
    if (!cfg) throw new CloudSyncError('BAD_CONFIG', '云同步未配置')
    const pushId = hashPushId({ clientId: cfg.clientId, baseRevision, delta: chunk })
    const payload = {
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      clientId: cfg.clientId,
      pushId,
      baseRevision,
      ...(epoch ? { epoch } : {}),
      ...(reset ? { reset: true } : {}),
      delta: chunk,
    }
    try {
      const { json } = await cloudRequest('/v1/sync/push', { method: 'POST', body: payload })
      const status = json.status
      if (status === 'applied' || status === 'duplicate') {
        const revision = Number.isInteger(json.revision) ? json.revision : baseRevision
        if (!reset) mirror = applyDeltaToCloudSnapshot(mirror, chunk, { revision })
        baseRevision = revision
        epoch = typeof json.epoch === 'string' && json.epoch ? json.epoch : epoch
        state.baseRevision = baseRevision
        state.cloudRevision = baseRevision
        state.epoch = epoch
        state.lastPushAt = now()
        state.lastPushStatus = status
        state.lastPushEntities = countDelta(chunk).total
        return { status, revision }
      }
      if (status === 'noop') {
        // 非空 delta 被判定 noop 说明云端视图与本地镜像不一致（并发写者/丢失响应），
        // 按冲突处理：pull 追平后由上层重算 delta 重试。
        await pullAll('noop-recover')
        throw new CloudSyncError('REVISION_CONFLICT', '云端返回 noop 但本地有增量，已重新拉取镜像')
      }
      throw new CloudSyncError('INTERNAL', `云端 push 返回未知状态：${status || '(空)'}`, { status: 500 })
    } catch (error) {
      // 413：按实体数分片仍可能超过 256 KiB 字节上限 → 继续二分，直到单实体（每片独立 push，语义不变）。
      // 200 实体最深 8 层可拆到 1 个实体；单实体仍 413 说明是异常巨大的字段，只能挂起等人工处理。
      if (errorStatus(error) === 413) {
        const total = countDelta(chunk).total
        if (total > 1 && splitDepth < PUSH_413_SPLIT_DEPTH) {
          const halves = chunkDelta(chunk, Math.ceil(total / 2))
          for (let index = 0; index < halves.length; index++) {
            // reset 只允许作用在第一个分片：后续分片是普通增量，否则会二次清空镜像
            await pushOneChunk(halves[index], { reset: reset && index === 0, splitDepth: splitDepth + 1 })
          }
          return { status: 'applied', revision: baseRevision, split: true }
        }
        if (total === 1) {
          const oversized = new CloudSyncError(
            'PAYLOAD_TOO_LARGE',
            `单个实体超过云端 push 体积上限（256 KiB），已停止自动重试：请检查该卡片/时间线节点是否存在异常巨大的字段（artifacts/approvals/summary 等）`,
            { status: 413, details: { entityTotal: total } },
          )
          oversized.retryable = false
          throw oversized
        }
      }
      throw error
    }
  }

  async function pushDelta(delta) {
    const chunks = chunkDelta(delta, MAX_PUSH_ENTITIES)
    for (const chunk of chunks) await pushOneChunk(chunk)
  }

  /** epoch 变化 / reset:true：用本地全量快照重建云端镜像。 */
  async function pushReset(snapshot) {
    const full = {
      boards: { upserts: snapshot.boards, deletes: [] },
      cards: { upserts: snapshot.cards, deletes: [] },
      activities: { upserts: snapshot.activities, deletes: [] },
    }
    const chunks = chunkDelta(full, MAX_PUSH_ENTITIES)
    if (chunks.length === 0) chunks.push({ boards: { upserts: [], deletes: [] }, cards: { upserts: [], deletes: [] }, activities: { upserts: [], deletes: [] } })
    let revision = baseRevision
    for (let index = 0; index < chunks.length; index++) {
      const result = await pushOneChunk(chunks[index], { reset: index === 0 })
      revision = result.revision
    }
    mirror = { ...snapshot, revision }
    baseRevision = revision
    state.baseRevision = baseRevision
    state.cloudRevision = baseRevision
    state.lastPushStatus = 'reset'
    state.lastPushEntities = countDelta(full).total
    state.lastPushAt = now()
    logger.warn(`[dsh-kanban] 云同步：云端 epoch 已变化，已用本地全量快照 reset 重建镜像（revision=${revision}）`)
  }

  function markSynced() {
    state.pushFailures = 0
    state.nextPushRetryAt = 0
    state.lastPushError = null
    state.haltedCode = ''
    state.lastSyncAt = now()
    setPhase('idle')
  }

  async function pushNow(reason = 'manual') {
    if (!canUseCloud() || !syncEnabled()) return { skipped: true, reason: 'sync-disabled' }
    if (state.haltedCode) return { skipped: true, haltedCode: state.haltedCode }
    setPhase('syncing')
    try {
      await ensureMirror(reason)
      const snapshot = toCloudSnapshot(await store.read())
      for (let attempt = 0; attempt <= PUSH_CONFLICT_RETRIES; attempt++) {
        const delta = diffCloudSnapshots(mirror, snapshot)
        if (isEmptyDelta(delta)) {
          // 空增量不产生 push 请求，也不应覆盖上一次「真正推送」的状态（契约 §5.3：noop 仅刷新节流）
          markSynced()
          return { status: 'noop' }
        }
        try {
          await pushDelta(delta)
          markSynced()
          return { status: state.lastPushStatus, entities: state.lastPushEntities }
        } catch (error) {
          if (error?.code === 'REVISION_CONFLICT' && attempt < PUSH_CONFLICT_RETRIES) {
            logger.warn('[dsh-kanban] 云同步：push 遇到 revision 冲突，拉取云端镜像后重算增量重试')
            await pullAll('conflict')
            continue
          }
          if (error?.code === 'SYNC_EPOCH_MISMATCH') {
            // 契约 §6.3：云端 D1 被重建（epoch 变化）→ 丢弃本地「已推送镜像」，
            // 以本地权威全量快照做 reset 推送。注意 Worker 的 epoch 校验先于一切写操作，
            // reset 请求本身也必须**不带旧 epoch**；baseRevision 用 409 返回的 serverRevision
            // 作为 CAS 基准，拿不到 details 时先 pull 一次（pull 不携带 epoch，可安全使用）。
            const serverRevision = Number.isInteger(error?.details?.serverRevision) ? error.details.serverRevision : null
            if (serverRevision !== null) {
              baseRevision = serverRevision
              epoch = ''
              state.baseRevision = baseRevision
              state.epoch = ''
            } else {
              await pullAll('epoch-rebuild')
            }
            try {
              await pushReset(snapshot)
            } catch (error) {
              // reset 多分片只成功了一部分时，云端镜像可能只重建了前半段；
              // 必须丢弃本地镜像让下一次 sync 走 pull 全量重建，否则会「以为已同步」而永久漏推。
              mirror = null
              throw error
            }
            markSynced()
            return { status: 'reset' }
          }
          throw error
        }
      }
      const exhausted = new CloudSyncError('REVISION_CONFLICT', 'push 冲突重试次数已用尽')
      exhausted.retryable = true
      throw exhausted
    } catch (error) {
      handleCloudFailure('push', error)
      return { error: briefError(error) }
    }
  }

  // ---------------------------------------------------------------------
  // ingress：claim → 本地 replay → ack
  // ---------------------------------------------------------------------

  async function consumeIngressItem(item) {
    const id = typeof item?.id === 'string' ? item.id : ''
    const leaseToken = typeof item?.leaseToken === 'string' ? item.leaseToken : ''
    if (!id) return null
    if (isIngressExpired(item, now())) {
      return { id, outcome: 'dead', error: '入站事件已过期（超过保留期）', ...(leaseToken ? { leaseToken } : {}) }
    }
    const origin = resolveLocalOrigin()
    if (!origin) {
      return { id, outcome: 'retry', error: '本地看板地址未知（runtime-endpoint.json 尚未生成）', ...(leaseToken ? { leaseToken } : {}) }
    }
    const request = buildLocalIngressRequest(item)
    const result = await localRequest(`${origin}${request.path || LOCAL_INGRESS_PATH}`, {
      headers: request.headers,
      body: request.body,
    })
    const classified = classifyLocalIngressResponse(result)
    const failure = classified.error ? `：${classified.error}` : ''
    if (classified.outcome !== 'acked') {
      logger.warn(`[dsh-kanban] 云同步：入站回放 ${id}（${request.provider || '?'}）→ ${classified.outcome}${failure}`)
    }
    return {
      id,
      outcome: classified.outcome,
      ...(classified.error ? { error: String(classified.error).slice(0, 500) } : {}),
      ...(leaseToken ? { leaseToken } : {}),
    }
  }

  /**
   * 本地已成功消费、但 ACK 网络失败的结果先留在内存里：下一轮 claim 之前**先重试 ACK**，
   * 避免「本地已建卡/已审批 + ACK 丢失 → 租约到期后云端重发 → 本地重复消费」。
   * 进程崩溃时该内存丢失（契约 §8.7 的至少一次投递语义），属于已知窗口。
   */
  let pendingAckResults = []

  async function sendAck(results) {
    const cfg = config()
    pendingAckResults = results
    const ack = await cloudRequest('/v1/inbox/ack', {
      method: 'POST',
      body: { consumerId: cfg.clientId, results },
    })
    pendingAckResults = []
    return ack.json || {}
  }

  function applyAckCounters(ackJson, results, reason) {
    const acked = Array.isArray(ackJson.acked) ? ackJson.acked.length : results.filter(r => r.outcome === 'acked').length
    const dead = Array.isArray(ackJson.dead) ? ackJson.dead.length : results.filter(r => r.outcome === 'dead').length
    const retried = Array.isArray(ackJson.retried) ? ackJson.retried.length : results.filter(r => r.outcome === 'retry').length
    state.claim.acked += acked
    state.claim.dead += dead
    state.claim.retried += retried
    state.claim.lastAckAt = now()
    state.claim.lastAckIgnored = Array.isArray(ackJson.ignored) ? ackJson.ignored.length : 0
    if (acked || dead || retried) {
      logger.info(`[dsh-kanban] 云同步：入站回放完成 acked=${acked} retried=${retried} dead=${dead}（${reason}）`)
    }
    return { acked, retried, dead }
  }

  async function flushPendingAck(reason) {
    if (pendingAckResults.length === 0) return null
    const results = pendingAckResults
    const ackJson = await sendAck(results)
    return applyAckCounters(ackJson, results, `${reason}:pending-ack`)
  }

  async function claimInboxNow(reason = 'manual') {
    if (!canUseCloud() || !ingressEnabled()) return { skipped: true, reason: 'ingress-disabled' }
    const cfg = config()
    setPhase(state.phase === 'syncing' ? state.phase : 'claiming')
    try {
      // ACK 丢失的补发先于新 claim：保证「本地已消费」不会因租约到期而被重复回放。
      await flushPendingAck(reason)
      const { json } = await cloudRequest('/v1/inbox/claim', {
        method: 'POST',
        body: {
          consumerId: cfg.clientId,
          limit: cfg.ingress.batchSize,
          leaseSeconds: cfg.ingress.leaseSeconds,
        },
      })
      const items = Array.isArray(json.items) ? json.items : []
      state.claim.lastClaimAt = now()
      state.claim.lastClaimed = items.length
      state.claimFailures = 0
      state.nextClaimRetryAt = 0
      state.lastClaimError = null
      if (state.phase === 'claiming') setPhase('idle')
      if (items.length === 0) return { claimed: 0 }

      const results = []
      for (const item of items) {
        // stop() 期间不再为剩余条目新建本地回放请求：未消费条目保持租约，到期后由下一次启动重新 claim。
        if (stopped || !running) break
        const result = await consumeIngressItem(item)
        if (result) results.push(result)
      }
      if (results.length === 0) return { claimed: items.length, consumed: 0 }

      // 已消费（含被 stop 中断后判定为 retry）的结果仍要补一次 ACK：
      // 避免租约到期后云端重发已消费事件，对非幂等的 IM 文本任务造成重复建卡。
      const ackJson = await sendAck(results)
      const counts = applyAckCounters(ackJson, results, reason)
      if (state.phase === 'claiming') setPhase('idle')
      return { claimed: items.length, ...counts }
    } catch (error) {
      handleCloudFailure('claim', error)
      return { error: briefError(error) }
    }
  }

  // ---------------------------------------------------------------------
  // 失败处理：401 停止、可重试错误指数退避、业务错误不自动重试
  // ---------------------------------------------------------------------

  function pauseForAuth(error, scope = 'push') {
    state.paused = true
    state.pauseReason = 'unauthorized'
    state.phase = 'paused'
    if (scope === 'claim') state.lastClaimError = briefError(error)
    else state.lastPushError = briefError(error)
    logger.warn(`[dsh-kanban] 云同步：鉴权失败（${error?.code || 401}），已停止重试；请检查 ~/.dsh-kanban/${CLOUD_CONFIG_FILE_NAME} 中的 token 后重启插件`)
  }

  function handleCloudFailure(scope, error) {
    const brief = briefError(error)
    if (scope === 'claim') {
      state.lastClaimError = brief
      state.claimFailures += 1
    } else {
      state.lastPushError = brief
      state.pushFailures += 1
    }
    const status = errorStatus(error)
    if (status === 401) {
      pauseForAuth(error, scope)
      return
    }
    if (!isRetryableError(error)) {
      // 业务性错误（400/404/413 未分片成功等）：不自动重试，等下一次本地变更/人工处理。
      // push 用 haltedCode 挂起，直到本地再次变更；claim 由固定的 claimIntervalMs 轮询自然重试。
      state.phase = 'error'
      if (scope === 'push') state.haltedCode = error?.code || 'ERROR'
      logger.warn(`[dsh-kanban] 云同步：${scope} 失败（${brief.code} ${brief.message}），已停止自动重试`)
      return
    }
    state.phase = 'backoff'
    const failures = scope === 'claim' ? state.claimFailures : state.pushFailures
    const delay = cloudRetryDelay(failures, { baseMs: timing.retryBaseMs, maxMs: timing.retryMaxMs })
    if (scope === 'claim') {
      state.nextClaimRetryAt = now() + delay
      scheduleClaimRetry()
    } else {
      state.nextPushRetryAt = now() + delay
      schedulePushRetry()
    }
    logger.warn(`[dsh-kanban] 云同步：${scope} 失败（${brief.code} ${brief.message}），${delay}ms 后重试（第 ${failures} 次）`)
  }

  function schedulePushRetry() {
    pushRetryTimer = clearTimer(pushRetryTimer)
    if (!running || state.paused) return
    const delay = Math.max(1, state.nextPushRetryAt - now())
    pushRetryTimer = setTimeout(() => {
      pushRetryTimer = null
      void queuePush('retry')
    }, delay)
    pushRetryTimer.unref?.()
  }

  function scheduleClaimRetry() {
    claimRetryTimer = clearTimer(claimRetryTimer)
    if (!running || state.paused) return
    const delay = Math.max(1, state.nextClaimRetryAt - now())
    claimRetryTimer = setTimeout(() => {
      claimRetryTimer = null
      void queueClaim('retry')
    }, delay)
    claimRetryTimer.unref?.()
  }

  // ---------------------------------------------------------------------
  // 调度：防抖 push、定时兜底、唤醒探测
  // ---------------------------------------------------------------------

  function queuePush(reason) {
    if (!canUseCloud() || !syncEnabled() || state.haltedCode) return Promise.resolve({ skipped: true })
    if (pushRunning) {
      pushQueued = true
      return pushChain
    }
    pushRunning = true
    pushChain = (async () => {
      try {
        return await pushNow(reason)
      } finally {
        pushRunning = false
        if (pushQueued) {
          pushQueued = false
          void queuePush('queued')
        }
      }
    })()
    return pushChain
  }

  function queueClaim(reason) {
    if (!canUseCloud()) return Promise.resolve({ skipped: true })
    if (claimRunning) {
      claimQueued = true
      return claimChain
    }
    claimRunning = true
    claimChain = (async () => {
      try {
        return await claimInboxNow(reason)
      } finally {
        claimRunning = false
        if (claimQueued) {
          claimQueued = false
          void queueClaim('queued')
        }
      }
    })()
    return claimChain
  }

  function onStoreChange() {
    if (!running) return
    if (state.haltedCode) state.haltedCode = '' // 本地有新变更 → 解除业务错误挂起，尝试再同步
    state.debouncePending = true
    debounceTimer = clearTimer(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      state.debouncePending = false
      void queuePush('store-change')
    }, Math.max(1, timing.pushDebounceMs))
    debounceTimer.unref?.()
  }

  /** 关机/合盖不算失败：定时器间隔明显拉长时视为「唤醒」，立即对齐云端并消费入站。 */
  function detectWakeGap(kind) {
    const interval = kind === 'claim' ? timing.claimIntervalMs : timing.pullIntervalMs
    const current = now()
    const previous = lastTickAt[kind]
    lastTickAt[kind] = current
    if (!previous || interval <= 0) return false
    return current - previous > interval * 2 + 5000
  }

  function resetBackoff() {
    state.pushFailures = 0
    state.nextPushRetryAt = 0
    state.claimFailures = 0
    state.nextClaimRetryAt = 0
    pushRetryTimer = clearTimer(pushRetryTimer)
    claimRetryTimer = clearTimer(claimRetryTimer)
  }

  /** 唤醒：清空退避并立即对齐状态 + 消费云端暂存的入站事件（可手动触发）。 */
  function handleWake(source = 'manual') {
    if (!running) return { skipped: true }
    state.lastWakeAt = now()
    state.lastWakeReason = source
    resetBackoff()
    logger.info(`[dsh-kanban] 云同步：检测到本机唤醒/重连（${source}），立即拉取入站并同步增量`)
    if (syncEnabled()) void queuePush('wake')
    if (ingressEnabled()) void queueClaim('wake')
    return { ok: true, source }
  }

  function startTimers() {
    stopTimers()
    // 以启动时刻作为首个间隔基准：即使宿主在第一次定时器触发前就合盖休眠，
    // 唤醒后的第一次 tick 也能通过「间隔明显拉长」识别出唤醒。
    lastTickAt.sync = now()
    lastTickAt.claim = now()
    if (syncEnabled() && timing.pullIntervalMs > 0) {
      syncInterval = setInterval(() => {
        if (!canUseCloud()) return
        if (detectWakeGap('sync')) {
          handleWake('timer-gap')
          return
        }
        void queuePush('interval')
      }, timing.pullIntervalMs)
      syncInterval.unref?.()
    }
    if (ingressEnabled() && timing.claimIntervalMs > 0) {
      claimInterval = setInterval(() => {
        if (!canUseCloud()) return
        if (detectWakeGap('claim')) {
          handleWake('timer-gap')
          return
        }
        void queueClaim('interval')
      }, timing.claimIntervalMs)
      claimInterval.unref?.()
    }
  }

  function stopTimers() {
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null }
    if (claimInterval) { clearInterval(claimInterval); claimInterval = null }
    debounceTimer = clearTimer(debounceTimer)
    pushRetryTimer = clearTimer(pushRetryTimer)
    claimRetryTimer = clearTimer(claimRetryTimer)
    state.debouncePending = false
  }

  // ---------------------------------------------------------------------
  // 生命周期与状态
  // ---------------------------------------------------------------------

  function refreshStateFromConfig() {
    const cfg = config()
    state.configStatus = configInfo.status
    state.enabled = Boolean(cfg && cfg.enabled)
    state.configured = Boolean(cfg && cfg.enabled)
    state.clientId = cfg?.clientId || ''
    state.baseRevision = baseRevision
    state.cloudRevision = baseRevision
    state.epoch = epoch
  }

  async function start() {
    if (started) return status()
    started = true
    try {
      configInfo = readCloudConfig(dataDir, { configFile, logger })
      refreshStateFromConfig()
      if (configInfo.status !== 'ready') {
        const why = configInfo.status === 'missing'
          ? '未配置 cloud-config.json'
          : configInfo.status === 'disabled' ? 'cloud-config.json 已关闭（enabled:false）' : 'cloud-config.json 非法'
        state.phase = 'idle'
        logger.info(`[dsh-kanban] 云同步：${why}，本地照常运行（零网络开销）`)
        return status()
      }
      applyTiming()
      try {
        await store.ready?.()
      } catch (error) {
        logger.warn(`[dsh-kanban] 云同步：本地数据加载失败，守护器未启动：${error?.message || error}`)
        return status()
      }
      if (stopped) return status()
      running = true
      state.running = true
      state.phase = 'idle'
      if (typeof store.subscribe === 'function') unsubscribe = store.subscribe(onStoreChange)
      startTimers()
      const described = describeCloudConfig(configInfo.config)
      logger.info(`[dsh-kanban] 云同步守护器已启动：workerUrl=${described.workerUrl} clientId=${described.clientId} token=${described.token}`)
      if (syncEnabled()) void queuePush('startup')
      if (ingressEnabled()) void queueClaim('startup')
      return status()
    } catch (error) {
      // 守护器是可选能力：任何未预期异常都不能冒泡到插件启动流程
      state.phase = 'error'
      state.lastPushError = briefError(error)
      logger.warn(`[dsh-kanban] 云同步守护器启动失败（本地看板不受影响）：${error?.message || error}`)
      return status()
    }
  }

  /** 等待 promise 最多 graceMs 毫秒（用于 stop 时给「当前这一条」在途请求一点收尾时间）。 */
  async function settleWithGrace(promise, graceMs) {
    let timer = null
    const grace = new Promise(resolve => {
      timer = setTimeout(resolve, graceMs)
      timer.unref?.()
    })
    try {
      await Promise.race([Promise.resolve(promise).catch(() => {}), grace])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function stop() {
    if (stopped) return status()
    stopped = true
    running = false
    state.running = false
    try { stopTimers() } catch {}
    if (typeof unsubscribe === 'function') {
      try { unsubscribe() } catch {}
      unsubscribe = null
    }
    // 先给当前在途的 claim 条目一点收尾宽限（完成本地回放并 ACK），再中止所有请求：
    // 既不会像整批那样被 20×超时拖住，也降低「本地已消费但响应被 abort」的重复回放窗口。
    await settleWithGrace(claimChain, timing.stopClaimGraceMs)
    abortActiveRequests()
    try { await claimChain } catch {}
    try { await pushChain } catch {}
    // claim 批次被中断时可能残留未发出的 ACK：停止前尽力补发一次，但**最多等 stopFlushAckMs**。
    // ACK 网络黑洞时不能把插件卸载拖到 10s 请求超时；补发失败就随进程退出丢弃，
    // 下一次启动由「租约重投 + 本地幂等」兜底（契约 §8.7 已知窗口）。
    try { await settleWithGrace(flushPendingAck('stop'), timing.stopFlushAckMs) } catch {}
    // 收尾后确保没有任何在途请求残留（含超时未返回的 ACK 补发），进程/插件卸载可以干净退出。
    abortActiveRequests()
    state.phase = 'stopped'
    logger.info('[dsh-kanban] 云同步守护器已停止')
    return status()
  }

  /**
   * 热重载 `cloud-config.json`（首次执行 `npm run cloud:setup` 或轮换令牌后无需重启 DSH 即可激活守护器）。
   * 若插件已卸载（`stopped === true`）则不执行。
   */
  async function reload() {
    if (stopped) return status()
    running = false
    state.running = false
    try { stopTimers() } catch {}
    if (typeof unsubscribe === 'function') {
      try { unsubscribe() } catch {}
      unsubscribe = null
    }
    abortActiveRequests()
    try { await claimChain } catch {}
    try { await pushChain } catch {}
    mirror = null
    baseRevision = 0
    epoch = ''
    state.paused = false
    state.pauseReason = ''
    state.haltedCode = ''
    state.pushFailures = 0
    state.nextPushRetryAt = 0
    state.lastPushError = null
    state.claimFailures = 0
    state.nextClaimRetryAt = 0
    state.lastClaimError = null
    started = false
    return start()
  }

  function status() {
    const cfg = config()
    return {
      ok: true,
      enabled: Boolean(cfg && cfg.enabled && running),
      configured: Boolean(cfg && cfg.enabled),
      running,
      paused: state.paused,
      pauseReason: state.pauseReason || '',
      phase: state.phase,
      configStatus: state.configStatus,
      configFile: configFile || null,
      config: cfg ? describeCloudConfig(cfg) : null,
      clientId: cfg?.clientId || '',
      baseRevision,
      cloudRevision: state.cloudRevision,
      epoch,
      lastSyncAt: state.lastSyncAt,
      lastWakeAt: state.lastWakeAt,
      lastWakeReason: state.lastWakeReason,
      configError: configInfo.status === 'invalid' ? (configInfo.error || null) : null,
      sync: {
        enabled: syncEnabled(),
        pending: state.debouncePending,
        lastPushAt: state.lastPushAt,
        lastPushStatus: state.lastPushStatus,
        lastPushEntities: state.lastPushEntities,
        lastPullAt: state.lastPullAt,
        consecutiveFailures: state.pushFailures,
        nextRetryAt: state.nextPushRetryAt || 0,
        lastError: state.lastPushError,
      },
      ingress: {
        enabled: Boolean(cfg && cfg.ingress.enabled && running),
        lastClaimAt: state.claim.lastClaimAt,
        lastClaimed: state.claim.lastClaimed,
        acked: state.claim.acked,
        retried: state.claim.retried,
        dead: state.claim.dead,
        lastAckAt: state.claim.lastAckAt,
        lastAckIgnored: state.claim.lastAckIgnored,
        consecutiveFailures: state.claimFailures,
        nextRetryAt: state.nextClaimRetryAt || 0,
        lastError: state.lastClaimError,
      },
      haltedCode: state.haltedCode || '',
    }
  }

  return {
    start,
    stop,
    reload,
    status,
    /** 手动触发一次对齐（pull 冷启动 + diff push；测试/运维可用）。 */
    syncNow() { return queuePush('manual') },
    /** 手动触发一次入站领取与回放。 */
    claimInboxNow() { return queueClaim('manual') },
    /** 唤醒处理（合盖唤醒/网络恢复时可由宿主调用）。 */
    handleWake,
    /** 显式指定本地看板 origin（测试/多实例场景；生产默认从 runtime-endpoint.json 发现）。 */
    setLocalOrigin(origin) {
      if (isLoopbackOrigin(origin)) {
        localOriginOverride = origin.replace(/\/+$/, '')
        return localOriginOverride
      }
      return ''
    },
    /** 诊断用：本地 origin 当前解析结果（不含令牌）。 */
    resolveLocalOrigin,
  }
}

export { DEFAULT_TIMING as CLOUD_SYNC_DEFAULT_TIMING }
