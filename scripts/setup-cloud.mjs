#!/usr/bin/env node
// dsh-kanban 个人私有 Cloudflare Worker + D1 + 远程 MCP 一键初始化与同步脚本
// ---------------------------------------------------------------------------
// 设计目标：
// 1. 零手改 Git 跟踪文件：自动基于 cloudflare/wrangler.toml 生成已加入 .gitignore 的
//    cloudflare/wrangler.local.toml（权限 0600），彻底杜绝开源仓库误提交个人 database_id；
// 2. 幂等可重跑：自动检查 Cloudflare 登录态 → 查找/创建私有 D1 → 执行迁移 → 部署 Worker →
//    生成（或复用）256-bit 随机 CLOUD_SYNC_TOKEN 写入 Worker Secret 与本地 ~/.dsh-kanban/cloud-config.json（0600）；
// 3. 立即首推镜像：若本机已有 ~/.dsh-kanban/data.json，部署完当场以只读方式将现有看板与卡片全量推送至 D1，
//    并尝试热通知本机运行中的 DSH 插件重载云配置，随后对 /v1/mcp 做真实端到端冒烟验证。

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeStore } from '../lib/domain.js'
import { normalizeCloudConfig } from '../lib/cloud-sync-protocol.js'
import { createCloudSyncClient } from '../lib/cloud-sync-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const TEMPLATE_TOML = join(REPO_ROOT, 'cloudflare', 'wrangler.toml')
const LOCAL_TOML = join(REPO_ROOT, 'cloudflare', 'wrangler.local.toml')
const DEFAULT_DB_NAME = 'dsh-kanban-sync'
const PLACEHOLDER_TOKEN = '<REPLACE_WITH_D1_DATABASE_ID>'

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const WORKER_URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.workers\.dev\b/gi

/** 将模板 wrangler.toml 渲染为本地私有的 wrangler.local.toml 内容（不触碰 Git 跟踪模板）。 */
export function renderLocalWranglerToml(templateText, databaseId, databaseName = DEFAULT_DB_NAME) {
  if (typeof templateText !== 'string' || !templateText.includes(PLACEHOLDER_TOKEN)) {
    throw new Error(`模板缺少占位符 ${PLACEHOLDER_TOKEN}`)
  }
  const cleanId = String(databaseId || '').trim()
  if (!UUID_RE.test(cleanId)) {
    throw new Error(`非法的 D1 database_id：${cleanId || '(空)'}`)
  }
  let rendered = templateText.replace(PLACEHOLDER_TOKEN, cleanId)
  if (databaseName && databaseName !== DEFAULT_DB_NAME) {
    rendered = rendered.replace(`database_name = "${DEFAULT_DB_NAME}"`, `database_name = "${databaseName}"`)
  }
  return `# 自动生成（已被 .gitignore 忽略，请勿提交到公开仓库）\n${rendered}`
}

/** 从 wrangler d1 list JSON 或 d1 create 文本输出中提取 D1 UUID。 */
export function extractD1Uuid(rawOutput, databaseName = DEFAULT_DB_NAME) {
  const text = String(rawOutput || '').trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      const hit = parsed.find(item => item && item.name === databaseName && typeof item.uuid === 'string')
      if (hit && UUID_RE.test(hit.uuid)) return hit.uuid.trim()
    }
  } catch {
    // 非纯 JSON 输出时走正则兜底
  }
  const tomlMatch = text.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)
  if (tomlMatch) return tomlMatch[1]
  const anyUuid = text.match(UUID_RE)
  return anyUuid ? anyUuid[1] : ''
}

/** 从 wrangler deploy 输出中提取部署后的 workers.dev URL（取最后一个匹配）。 */
export function extractWorkerUrl(deployOutput) {
  const matches = String(deployOutput || '').match(WORKER_URL_RE)
  if (!matches || matches.length === 0) return ''
  return matches[matches.length - 1].replace(/\/+$/, '')
}

/** 构造并校验本地 cloud-config.json 对象。 */
export function buildInitialCloudConfig({ workerUrl, token, clientId }) {
  const safeHost = String(clientId || hostname() || 'macbook')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'macbook'
  const raw = {
    version: 1,
    enabled: true,
    workerUrl: String(workerUrl || '').trim().replace(/\/+$/, ''),
    token: String(token || '').trim(),
    clientId: safeHost,
    sync: { enabled: true, pushDebounceMs: 2000, pullIntervalMs: 30000 },
    ingress: { enabled: true, claimIntervalMs: 30000, batchSize: 20, leaseSeconds: 120 },
  }
  return normalizeCloudConfig(raw)
}

function parseCliArgs(argv) {
  const out = {
    dataDir: process.env.DSH_KANBAN_DATA_DIR || join(homedir(), '.dsh-kanban'),
    dbName: DEFAULT_DB_NAME,
    workerUrl: '',
    rotateToken: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--rotate-token') out.rotateToken = true
    else if (arg === '--data-dir' && argv[i + 1]) out.dataDir = resolve(argv[++i])
    else if (arg === '--db-name' && argv[i + 1]) out.dbName = String(argv[++i]).trim()
    else if (arg === '--worker-url' && argv[i + 1]) out.workerUrl = String(argv[++i]).trim()
  }
  return out
}

function resolveWranglerRunner() {
  const direct = spawnSync('wrangler', ['--version'], { encoding: 'utf8' })
  if (direct.status === 0) {
    return { cmd: 'wrangler', prefixArgs: [] }
  }
  return { cmd: 'npx', prefixArgs: ['--yes', 'wrangler@3'] }
}

function runWrangler(runner, args, { input, inherit = false, extraEnv = {} } = {}) {
  const res = spawnSync(runner.cmd, [...runner.prefixArgs, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  })
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    combined: `${res.stdout || ''}\n${res.stderr || ''}`.trim(),
  }
}

async function readExistingCloudConfig(configPath) {
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function pushInitialLocalSnapshot({ dataDir, workerUrl, token, clientId }) {
  const dataFile = join(dataDir, 'data.json')
  if (!(await fileExists(dataFile))) {
    return { pushed: false, reason: 'no-local-data-file', cards: 0, boards: 0 }
  }
  const rawData = JSON.parse(await readFile(dataFile, 'utf8'))
  const normalized = normalizeStore(rawData)
  const roStore = {
    dataDir,
    ready: async () => {},
    read: async () => normalized,
    subscribe: () => () => {},
  }
  const tmpCfgPath = join(dataDir, `.cloud-bootstrap-${process.pid}.json`)
  const bootstrapCfg = buildInitialCloudConfig({ workerUrl, token, clientId })
  bootstrapCfg.ingress.enabled = false
  await writeFile(tmpCfgPath, JSON.stringify(bootstrapCfg, null, 2), { mode: 0o600 })
  await chmod(tmpCfgPath, 0o600)
  let finalStatus
  try {
    const syncClient = createCloudSyncClient({
      store: roStore,
      dataDir,
      configFile: tmpCfgPath,
      timing: {
        pushDebounceMs: 50,
        pullIntervalMs: 600_000,
        claimIntervalMs: 600_000,
      },
    })
    await syncClient.start()
    await syncClient.syncNow()
    finalStatus = syncClient.status()
    await syncClient.stop()
  } finally {
    await unlink(tmpCfgPath).catch(() => {})
  }
  return {
    pushed: !finalStatus.sync?.lastError,
    revision: finalStatus.cloudRevision,
    boards: normalized.boards?.length || 0,
    cards: normalized.cards?.length || 0,
    error: finalStatus.sync?.lastError || null,
    workerUrl,
    clientId,
    tokenLength: token.length,
  }
}

async function tryNotifyRunningDsh(dataDir) {
  const runtimeFile = join(dataDir, 'runtime-endpoint.json')
  try {
    const parsed = JSON.parse(await readFile(runtimeFile, 'utf8'))
    const origin = typeof parsed?.origin === 'string' ? parsed.origin.replace(/\/+$/, '') : ''
    if (!origin.startsWith('http://127.0.0.1:') && !origin.startsWith('http://localhost:')) {
      return { notified: false }
    }
    const resp = await fetch(`${origin}/api/kanban/cloud/reload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
    return { notified: resp.ok, status: resp.status, origin }
  } catch {
    return { notified: false }
  }
}

async function verifyRemoteMcp(workerUrl, token) {
  const mcpUrl = `${workerUrl.replace(/\/+$/, '')}/v1/mcp`
  const resp = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'kanban_cards', arguments: { includeArchived: false, limit: 200 } },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok || !json?.result?.content?.[0]?.text) {
    throw new Error(`MCP 冒烟校验未通过（HTTP ${resp.status}）：${JSON.stringify(json)}`)
  }
  const payload = JSON.parse(json.result.content[0].text)
  return {
    mcpUrl,
    totalCards: payload.total ?? (payload.cards?.length || 0),
  }
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts.help) {
    console.log([
      '用法: npm run cloud:setup [-- --rotate-token] [--data-dir <dir>] [--worker-url <url>]',
      '',
      '一键在个人 Cloudflare 账号下创建/更新私有 D1 + Worker (/v1/mcp)，',
      '自动写入 ~/.dsh-kanban/cloud-config.json (0600) 并将本机现有卡片同步上云。',
    ].join('\n'))
    return
  }

  console.log('==> [1/7] 检查 Wrangler 与 Cloudflare 登录状态...')
  const runner = resolveWranglerRunner()
  let whoami = runWrangler(runner, ['whoami'])
  if (!whoami.ok || /not authenticated|wrangler login/i.test(whoami.combined)) {
    console.log('    未检测到 Cloudflare 登录态，正在拉起浏览器完成一次性 OAuth 授权...')
    const login = runWrangler(runner, ['login'], { inherit: true })
    if (!login.ok) {
      throw new Error('Cloudflare OAuth 登录未完成，请重试 npm run cloud:setup')
    }
    whoami = runWrangler(runner, ['whoami'])
    if (!whoami.ok) {
      throw new Error(`无法验证 Cloudflare 账号状态：\n${whoami.combined}`)
    }
  }
  console.log('    ✓ Cloudflare 账号已就绪')

  console.log(`==> [2/7] 查找或创建私有 D1 数据库 (${opts.dbName})...`)
  let databaseId = ''
  const listRes = runWrangler(runner, ['d1', 'list', '--json'])
  if (listRes.ok) {
    databaseId = extractD1Uuid(listRes.stdout, opts.dbName)
  }
  if (!databaseId) {
    const createRes = runWrangler(runner, ['d1', 'create', opts.dbName])
    if (!createRes.ok && !/already exists/i.test(createRes.combined)) {
      throw new Error(`创建 D1 数据库失败：\n${createRes.combined}`)
    }
    databaseId = extractD1Uuid(createRes.combined, opts.dbName)
    if (!databaseId) {
      const retryList = runWrangler(runner, ['d1', 'list', '--json'])
      databaseId = extractD1Uuid(retryList.stdout, opts.dbName)
    }
  }
  if (!databaseId) {
    throw new Error(`未能解析 D1 数据库 ${opts.dbName} 的 UUID，请检查 Cloudflare 控制台权限`)
  }
  console.log(`    ✓ D1 已就绪 (${opts.dbName}: ${databaseId.slice(0, 8)}…)`)

  console.log('==> [3/7] 生成本地私有配置 cloudflare/wrangler.local.toml（已被 Git 忽略）...')
  const templateText = await readFile(TEMPLATE_TOML, 'utf8')
  const localTomlText = renderLocalWranglerToml(templateText, databaseId, opts.dbName)
  await writeFile(LOCAL_TOML, localTomlText, { mode: 0o600 })
  await chmod(LOCAL_TOML, 0o600)
  console.log(`    ✓ 已写入 ${LOCAL_TOML}`)

  console.log('==> [4/7] 应用 D1 数据表迁移（幂等）...')
  const migrateRes = runWrangler(
    runner,
    ['d1', 'migrations', 'apply', opts.dbName, '--remote', '--config', LOCAL_TOML],
    { extraEnv: { CI: '1' } },
  )
  if (!migrateRes.ok) {
    throw new Error(`应用 D1 迁移失败：\n${migrateRes.combined}`)
  }
  console.log('    ✓ D1 Schema 迁移完成')

  console.log('==> [5/7] 部署 Cloudflare Worker（含 /v1/mcp 远程 MCP 端点）...')
  const deployRes = runWrangler(runner, ['deploy', '--config', LOCAL_TOML])
  if (!deployRes.ok) {
    throw new Error(`部署 Worker 失败：\n${deployRes.combined}`)
  }

  const configPath = join(opts.dataDir, 'cloud-config.json')
  const existingCfg = await readExistingCloudConfig(configPath)
  const workerUrl = (
    opts.workerUrl ||
    extractWorkerUrl(deployRes.combined) ||
    (typeof existingCfg?.workerUrl === 'string' ? existingCfg.workerUrl.trim() : '')
  ).replace(/\/+$/, '')

  if (!workerUrl) {
    throw new Error(
      '已部署 Worker，但未从输出中识别到 *.workers.dev 域名（可能账号尚未在 Cloudflare Workers 控制台激活默认子域）。\n' +
      '请在 Cloudflare Dashboard -> Workers & Pages 确认子域后重跑：npm run cloud:setup -- --worker-url https://dsh-kanban-sync.<子域>.workers.dev',
    )
  }
  console.log(`    ✓ Worker 已上线：${workerUrl}`)

  console.log('==> [6/7] 配置高强度 Bearer 密钥并写入本地 cloud-config.json (0600)...')
  const reuseToken = !opts.rotateToken && typeof existingCfg?.token === 'string' && existingCfg.token.trim().length >= 32
  const token = reuseToken ? existingCfg.token.trim() : randomBytes(32).toString('hex')
  const secretRes = runWrangler(
    runner,
    ['secret', 'put', 'CLOUD_SYNC_TOKEN', '--config', LOCAL_TOML],
    { input: token, extraEnv: { CI: '1' } },
  )
  if (!secretRes.ok) {
    throw new Error(`上传 Worker Secret CLOUD_SYNC_TOKEN 失败：\n${secretRes.combined}`)
  }

  const normalizedCfg = buildInitialCloudConfig({
    workerUrl,
    token,
    clientId: existingCfg?.clientId || hostname(),
  })
  await mkdir(opts.dataDir, { recursive: true, mode: 0o700 })
  await writeFile(configPath, `${JSON.stringify(normalizedCfg, null, 2)}\n`, { mode: 0o600 })
  await chmod(configPath, 0o600)
  console.log(`    ✓ 本地配置已保存：${configPath}（权限 0600）`)

  console.log('==> [7/7] 推送本机现有看板数据至私有 D1 并校验 /v1/mcp...')
  const pushSummary = await pushInitialLocalSnapshot({
    dataDir: opts.dataDir,
    workerUrl,
    token,
    clientId: normalizedCfg.clientId,
  })
  if (pushSummary.pushed) {
    console.log(`    ✓ 本机快照已同步至 D1（${pushSummary.boards} 个看板，${pushSummary.cards} 张卡片，revision=${pushSummary.revision}）`)
  } else if (pushSummary.reason === 'no-local-data-file') {
    console.log('    ℹ 本机尚未生成 data.json，跳过初始快照推送')
  } else if (pushSummary.error) {
    console.warn(`    ! 初始推送返回告警（后续由 DSH 守护器自动重试）：${JSON.stringify(pushSummary.error)}`)
  }

  const dshReload = await tryNotifyRunningDsh(opts.dataDir)
  if (dshReload.notified) {
    console.log('    ✓ 已热通知本机运行中的 DSH 看板激活后台同步')
  }

  const mcpCheck = await verifyRemoteMcp(workerUrl, token)
  console.log(`    ✓ /v1/mcp 端到端鉴权与读取验证通过（云端当前可见活跃卡片：${mcpCheck.totalCards} 张）`)

  const workerHost = new URL(workerUrl).host
  console.log('\n========================================================================')
  console.log('🎉 个人私有 dsh-kanban 云端 MCP 部署完成！请将以下 3 项填入 Antigravity：')
  console.log('------------------------------------------------------------------------')
  console.log(`1. Allowed Hosts（出站域名白名单）:\n   ${workerHost}`)
  console.log(`\n2. Customizations -> MCP Servers -> Name / URL:\n   Name: dsh-kanban\n   URL : ${mcpCheck.mcpUrl}`)
  console.log(`\n3. Customizations -> MCP Servers -> Headers:\n   Authorization: Bearer ${token}`)
  console.log('------------------------------------------------------------------------')
  if (!dshReload.notified) {
    console.log('提示：首次更新代码后，重启一次 DSH 客户端即可开启后台自动同步与入站回放。')
  }
  console.log('========================================================================\n')
}

const isDirectMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectMain) {
  main().catch(err => {
    console.error(`\n✗ 部署中止：${err?.message || err}`)
    process.exitCode = 1
  })
}
