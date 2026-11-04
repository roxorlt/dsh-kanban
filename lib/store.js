// 存储层：~/.dsh-kanban/data.json 的原子写 + 进程内串行队列 + 读缓存 + 订阅广播。
// 设计要点：
// - 所有写操作经 update() 串行执行，失败不会污染队列，也不会写半份文件；
// - 写盘先写同目录 tmp 文件再 rename，进程崩溃不会留下残缺 JSON；
// - 损坏 JSON 备份为 data.json.corrupt-<ts> 后用种子重建，绝不直接覆盖用户数据；
// - schemaVersion 策略：等于当前版本→规范化后加载；低于/缺失→迁移（规范化成功即写回）；
//   高于当前版本→拒绝启动（不覆盖新版数据，提示升级插件）；
// - 决策日志（v0.10）：每次 update 若 domain 收集了决策事件，先 append decisions.jsonl（fsync）
//   再原子写 data.json——日志可能领先于数据，但不会少记。
import { watch as watchDir } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SCHEMA_VERSION, createSeed, normalizeStore, takePendingDecisions } from './domain.js'
import { DECISION_FILE_NAME, createDecisionLog } from './decisions.js'

export const DEFAULT_DATA_DIR = join(homedir(), '.dsh-kanban')
export const DEFAULT_FILE_NAME = 'data.json'

const storeError = (code, message, cause) => Object.assign(new Error(message), { code, cause })

async function writeAtomic(file, data) {
  const dir = dirname(file)
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const text = JSON.stringify(data, null, 2) + '\n'
  let handle
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, file)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw storeError('STORE_IO', `写入数据文件失败：${error.message}`, error)
  }
}

/** 单进程内共享同一实例，避免同一 dataDir 出现两条写队列。 */
const stores = new Map()

export function createStore(options = {}) {
  const dataDir = resolve(options.dataDir || DEFAULT_DATA_DIR)
  const file = options.file
    ? (isAbsolute(options.file) ? options.file : resolve(dataDir, options.file))
    : join(dataDir, DEFAULT_FILE_NAME)
  const seedMode = options.seedMode === 'empty' ? 'empty' : 'demo'
  const logger = options.logger
  // 决策日志：默认与 data.json 同目录的 decisions.jsonl；传入 decisionLog 对象可接管，false 可关闭（测试用）。
  const decisionLog = options.decisionLog === false
    ? null
    : options.decisionLog || createDecisionLog({
        file: options.decisionLogFile
          ? (isAbsolute(options.decisionLogFile) ? options.decisionLogFile : resolve(dataDir, options.decisionLogFile))
          : join(dataDir, DECISION_FILE_NAME),
        logger,
      })
  const existing = stores.get(file)
  if (existing && !options.forceNew) return existing

  let cache = null
  let diskSig = null
  let loading = null
  let queue = Promise.resolve()
  let closed = false
  let dirWatcher = null
  let watchDebounce = null
  const targetBaseName = basename(file)
  const listeners = new Set()

  const warn = message => { try { logger?.warn?.(message) } catch {} }

  async function readDiskSig() {
    try {
      const st = await stat(file)
      return `${st.ino}:${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  function startDirWatcher() {
    if (dirWatcher || closed || options.watchDisk === false) return
    try {
      dirWatcher = watchDir(dirname(file), { persistent: false }, (_eventType, filename) => {
        if (closed) return
        if (filename && String(filename) !== targetBaseName) return
        if (watchDebounce) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => {
          watchDebounce = null
          if (!closed && listeners.size > 0) void ensure().catch(() => {})
        }, 120)
        watchDebounce.unref?.()
      })
      dirWatcher.unref?.()
    } catch {
      dirWatcher = null
    }
  }

  function backupCorrupt(rawText) {
    const stamp = Date.now()
    let backup = `${file}.corrupt-${stamp}`
    return (async () => {
      for (let attempt = 2; ; attempt++) {
        try {
          await rename(file, backup)
          return backup
        } catch (error) {
          if (error.code === 'ENOENT') return null
          // 极少数情况下同毫秒重名：加序号重试一次，仍失败则放弃（绝不覆盖）
          if (error.code === 'EEXIST' || error.code === 'EPERM') { backup = `${file}.corrupt-${stamp}-${attempt}`; continue }
          throw storeError('STORE_CORRUPT', `数据文件损坏且无法备份（${error.message}），已拒绝启动以保护原数据`, error)
        }
      }
    })()
  }

  async function load() {
    await mkdir(dirname(file), { recursive: true })
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw storeError('STORE_IO', `读取数据文件失败：${error.message}`, error)
      const seed = normalizeStore(createSeed(seedMode))
      await writeAtomic(file, seed)
      warn(`首次启动，已用 ${seedMode} 种子创建 ${file}`)
      return seed
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      const backup = await backupCorrupt(text)
      const seed = normalizeStore(createSeed(seedMode))
      await writeAtomic(file, seed)
      warn(`数据文件 JSON 损坏，已备份为 ${backup}，并用 ${seedMode} 种子重建`)
      return seed
    }
    if (raw && Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) {
      throw storeError('STORE_SCHEMA_NEWER', `数据文件 schemaVersion=${raw.schemaVersion} 高于当前支持的 ${SCHEMA_VERSION}，请升级插件后再启动`)
    }
    let data
    try {
      data = normalizeStore(raw)
    } catch (error) {
      const backup = await backupCorrupt(text)
      const seed = normalizeStore(createSeed(seedMode))
      await writeAtomic(file, seed)
      warn(`数据文件结构不可修复（${error.message}），已备份为 ${backup}，并用 ${seedMode} 种子重建`)
      return seed
    }
    if (raw?.schemaVersion !== SCHEMA_VERSION) {
      await writeAtomic(file, data)
      warn(`已把数据文件从 schemaVersion=${raw?.schemaVersion ?? '缺失'} 迁移到 ${SCHEMA_VERSION}`)
    }
    diskSig = await readDiskSig()
    return data
  }

  async function loadSeedAware() {
    const data = await load()
    if (!diskSig) diskSig = await readDiskSig()
    return data
  }

  async function ensure() {
    if (cache) {
      const currentSig = await readDiskSig()
      if (currentSig && diskSig && currentSig === diskSig) return cache
      if (currentSig && currentSig !== diskSig && !loading) {
        const prevRev = cache.meta?.revision ?? 0
        loading = loadSeedAware().then(
          data => {
            cache = data
            loading = null
            if ((data.meta?.revision ?? 0) !== prevRev && listeners.size > 0) {
              const event = { revision: data.meta.revision, at: data.meta.updatedAt, data }
              for (const listener of [...listeners]) {
                try { listener(event) } catch (error) { warn(`看板订阅回调失败：${error.message}`) }
              }
            }
            return data
          },
          error => { loading = null; throw error },
        )
        return loading
      }
      if (!currentSig) return cache
    }
    if (!loading) {
      loading = loadSeedAware().then(
        data => { cache = data; loading = null; return data },
        error => { loading = null; throw error },
      )
    }
    return loading
  }

  async function read() {
    const data = await ensure()
    return structuredClone(data)
  }

  async function snapshot() {
    const data = await ensure()
    return { revision: data.meta.revision, at: data.meta.updatedAt, data: structuredClone(data) }
  }

  /** 串行写：fn(draft) 可以返回任意结果；落盘成功后 revision+1 并广播。 */
  function update(fn) {
    if (closed) return Promise.reject(storeError('STORE_CLOSED', '存储已关闭'))
    if (typeof fn !== 'function') return Promise.reject(storeError('STORE_INVALID', 'update 需要函数'))
    const run = async () => {
      if (closed) throw storeError('STORE_CLOSED', '存储已关闭')
      const current = await ensure()
      const draft = structuredClone(current)
      const result = await fn(draft)
      // domain 收集的决策事件不写进 data.json：先落 decisions.jsonl，再原子写数据文件。
      const pendingDecisions = takePendingDecisions(draft)
      draft.schemaVersion = SCHEMA_VERSION
      draft.meta = {
        ...draft.meta,
        updatedAt: Date.now(),
        revision: (draft.meta?.revision || 0) + 1,
      }
      if (pendingDecisions.length && decisionLog) {
        try {
          await decisionLog.append(pendingDecisions, { revision: draft.meta.revision })
        } catch (error) {
          throw storeError('DECISION_LOG_IO', `决策日志写入失败，本次操作未提交：${error.message}`, error)
        }
      }
      await writeAtomic(file, draft)
      diskSig = await readDiskSig()
      cache = draft
      const event = { revision: draft.meta.revision, at: draft.meta.updatedAt, data: draft }
      for (const listener of [...listeners]) {
        try { listener(event) } catch (error) { warn(`看板订阅回调失败：${error.message}`) }
      }
      return { result, revision: event.revision, data: draft }
    }
    const committed = queue.then(run, run)
    queue = committed.then(() => {}, () => {})
    return committed
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    startDirWatcher()
    return () => listeners.delete(listener)
  }

  /** 关闭：等待进行中的写入完成，并清空订阅。 */
  async function close() {
    closed = true
    if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null }
    if (dirWatcher) { try { dirWatcher.close() } catch {}; dirWatcher = null }
    await queue.catch(() => {})
    listeners.clear()
    await decisionLog?.close().catch(() => {})
    if (stores.get(file) === store) stores.delete(file)
  }

  const store = {
    dataDir, file, seedMode,
    decisionLog,
    get decisionFile() { return decisionLog?.file ?? null },
    get revision() { return cache?.meta?.revision ?? 0 },
    get loaded() { return cache !== null },
    ready: ensure,
    read,
    snapshot,
    update,
    subscribe,
    close,
    /** 测试/诊断用：当前状态是否已落盘（不产生 IO）。 */
    peek() { return cache },
  }
  if (!options.forceNew) stores.set(file, store)
  return store
}

/** 测试辅助：清理共享实例表。 */
export function clearStoreRegistry() { stores.clear() }
