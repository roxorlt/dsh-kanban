import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createRoutes } from '../lib/routes.js'
import { createSuperAgentTurnRunner } from '../lib/index.js'
import { createTools } from '../lib/tools.js'
import { createWatchdog } from '../lib/watchdog.js'
import { handleMcpJsonRpc } from '../lib/mcp-server.js'
import {
  SESSION_TURN_FAILURE,
  completeCard,
  createCard,
  getAutoAdvanceEnabled,
  isTransientTurnError,
  pushActivity,
  recordSessionTurnWatermark,
  requestApproval,
  changeStatus,
  setSuperAgentSessionId,
} from '../lib/domain.js'
import {
  formatImNotification,
  signImActionQuery,
  verifyImActionQuery,
} from '../lib/im-gateway.js'
import {
  createImAutoNotifier,
  createImLocalBridgeServer,
  ensureImActionSecret,
  loadImBridgeOrigin,
  loadImConfig,
  loadRuntimeOrigin,
  saveImConfig,
  saveRuntimeOrigin,
  sendWebhookNotification,
} from '../lib/im-notifier.js'
import { registerSessionTurnSync } from '../lib/session-sync.js'
import {
  WEIXIN_SESSION_EXPIRED_ERRCODE,
  createWeixinChannel,
  formatWeixinChunks,
  loadWeixinCredentials,
  splitWeixinChunks,
} from '../lib/weixin-channel.js'

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-im-wx-'))
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return dir
}

async function startTestServer(t, options) {
  const { routes, close } = createRoutes({ ...options, activateHost: false })
  const apiRoute = routes.find(r => r.path === '/api/kanban')
  const staticRoute = routes.find(r => r.path === '/dsh-kanban')
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/kanban')) return apiRoute.handler(req, res)
    if (req.url?.startsWith('/dsh-kanban')) return staticRoute.handler(req, res)
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(async () => {
    await close()
    await new Promise(resolve => server.close(resolve))
  })
  return { origin: `http://127.0.0.1:${port}`, port }
}

test('钉钉自定义机器人 Markdown 规范渲染：行首 ### 不被关键词破坏、无反引号裸露、双换行分段', () => {
  const card = {
    id: 'card-a1b2c3d4',
    title: '日志流采样录制器验收',
    project: 'stream-engine',
    status: 'needs_you',
    currentAction: '等待确认采样窗口配置',
    result: '已完成 Zstd 帧写入与 CRC 校验',
  }
  const approval = {
    id: 'ap-11223344',
    status: 'pending',
    title: '是否启用全量采样录制？',
    detail: '开启后预计单日磁盘写入约 `1.8GB`',
    options: [
      { id: 'enable_all', label: '立即开启', description: '全量录制并自动归档' },
      { id: 'core_only', label: '仅核心服务', description: '只录核心链路节点' },
    ],
  }

  for (const tpl of ['approval_requested', 'card_blocked', 'card_completed', 'daily_digest']) {
    const payload = formatImNotification(
      {
        template: tpl,
        card,
        approval,
        reason: '上游网关连接超时',
        counts: { running: 2, needs_you: 1, backlog: 3, done: 8 },
        highlights: ['`card-a1b2c3d4` 正在等待确认'],
      },
      {
        provider: 'dingtalk',
        format: 'card',
        keyword: 'superAgent',
        boardUrl: 'http://127.0.0.1:62106',
        actionSecret: 'a'.repeat(64),
      },
    )
    assert.equal(payload.msgtype, 'actionCard')
    const md = payload.actionCard.text
    assert.ok(md.startsWith('### '), `模板 ${tpl} 第一行必须顶格以 "### " 开头，实际为：${md.slice(0, 40)}`)
    assert.ok(!md.includes('`'), `模板 ${tpl} 不应包含钉钉不支持的反引号，实际为：\n${md}`)
    assert.ok(md.includes('\n\n'), `模板 ${tpl} 字段之间必须使用双换行分段`)
    assert.ok(md.includes('superAgent'), `模板 ${tpl} 正文引用行必须包含自定义安全关键词 superAgent`)
    assert.ok(payload.actionCard.title.includes('superAgent'), `模板 ${tpl} 标题必须包含安全关键词`)
  }
})

test('钉钉按钮全链路闭环：动态端口自发现 + 跨源打开拉起定位 + 防爬虫只读 GET + 签名 POST 审批与幂等重放', async t => {
  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()

  let createdCard = null
  let createdApproval = null
  await store.update(draft => {
    const { card } = createCard(draft, {
      title: '云端控制面 Schema 审批测试',
      project: 'dsh-kanban',
      status: 'running',
      cwd: '/workspace/dsh-kanban',
      sessionId: 'session-worker-dt-01',
    })
    const reqRes = requestApproval(draft, card.id, {
      title: '确认 D1 表结构迁移方案',
      detail: '仅同步脱敏卡片状态镜像，不含业务代码仓',
      options: [
        { id: 'approve_d1', label: '批准执行', outcome: 'running' },
        { id: 'hold_d1', label: '暂缓修改', outcome: 'backlog' },
      ],
    })
    createdCard = reqRes.card
    createdApproval = reqRes.approval
  })

  const { origin } = await startTestServer(t, { store, staticRoot: join(dataDir, 'static') })

  // 1) 模拟 DSH 客户端轮询一次接口 → 自动记录动态运行端口到 runtime-endpoint.json
  const healthRes = await fetch(`${origin}/api/kanban/health`)
  assert.equal(healthRes.status, 200)
  assert.equal(loadRuntimeOrigin(dataDir), origin)

  // 2) 通过 sendWebhookNotification 生成钉钉通知（不显式传 boardUrl，验证自动采用动态端口 + HMAC 签名按钮）
  let capturedDingtalkPayload = null
  const sendRes = await sendWebhookNotification(
    { template: 'approval_requested', card: createdCard, approval: createdApproval },
    { id: 'dt', provider: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=mock', keyword: 'superAgent' },
    {
      dataDir,
      fetchImpl: async (_url, init) => {
        capturedDingtalkPayload = JSON.parse(init.body)
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      },
    },
  )
  assert.equal(sendRes.ok, true)
  const btns = capturedDingtalkPayload.actionCard.btns
  assert.equal(btns.length, 3)
  const approveUrl = btns[0].actionURL
  const openBoardUrl = btns[2].actionURL
  assert.ok(approveUrl.startsWith(`${origin}/api/kanban/im/act?`), `审批按钮应指向本机动态端口签名端点: ${approveUrl}`)
  assert.equal(openBoardUrl, `${origin}/api/kanban/im/open?cardId=${createdCard.id}`)

  // 3) 点击「在 DSH 看板中查看」（带外部浏览器 Sec-Fetch-Site: cross-site 请求头）
  const openRes = await fetch(openBoardUrl, {
    headers: { 'sec-fetch-site': 'cross-site', accept: 'text/html' },
  })
  assert.equal(openRes.status, 200)
  const openHtml = await openRes.text()
  assert.ok(openHtml.includes(createdCard.title))
  assert.ok(openHtml.includes(`/dsh-kanban/?cardId=${createdCard.id}`))
  assert.ok(openHtml.includes(`dsh://kanban?cardId=${createdCard.id}`))

  // 验证 DSH 桌面端后台轮询 `/api/kanban/outbox/lease` 能立即拿到 pendingFocus 切面板指令
  const leaseFocusRes = await fetch(`${origin}/api/kanban/outbox/lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 0, lastFocusSeq: 0 }),
  })
  const leaseFocusData = await leaseFocusRes.json()
  assert.equal(leaseFocusData.pendingFocus?.cardId, createdCard.id)

  // 未知卡片分支返回 404 引导页
  const missingOpenRes = await fetch(`${origin}/api/kanban/im/open?cardId=card-deadbeef`, {
    headers: { 'sec-fetch-site': 'cross-site', accept: 'text/html' },
  })
  assert.equal(missingOpenRes.status, 404)

  // 4) 防预览爬虫误触验证：外部 GET / HEAD 请求审批链接严禁修改审批状态！
  const headPreview = await fetch(approveUrl, { method: 'HEAD', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(headPreview.status, 200)
  const getPreview = await fetch(approveUrl, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site', accept: 'text/html' } })
  assert.equal(getPreview.status, 200)
  const landingHtml = await getPreview.text()
  assert.ok(landingHtml.includes('确认提交：「批准执行」'))

  const snapAfterGet = await store.read()
  const cardAfterGet = snapAfterGet.cards.find(c => c.id === createdCard.id)
  assert.equal(cardAfterGet.status, 'needs_you', '仅访问 GET 落地页不应改变卡片待确认状态')
  assert.equal(cardAfterGet.approvals[0].status, 'pending', '仅访问 GET 落地页不应把审批标为 resolved')

  // 5) 安全拦截验证：篡改签名 → 403，链接过期 → 410
  const parsedApproveUrl = new URL(approveUrl)
  const validParams = Object.fromEntries(parsedApproveUrl.searchParams.entries())

  const tamperedRes = await fetch(`${origin}/api/kanban/im/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ ...validParams, optionId: 'hold_d1' }), // 篡改选项导致签名不匹配
  })
  assert.equal(tamperedRes.status, 403)

  const secret = ensureImActionSecret(dataDir)
  const expiredSigned = signImActionQuery({
    cardId: createdCard.id,
    approvalId: createdApproval.id,
    optionId: 'approve_d1',
    exp: Date.now() - 5000,
  }, secret)
  assert.equal(verifyImActionQuery(expiredSigned, secret, Date.now()).code, 'ACTION_EXPIRED')
  const expiredRes = await fetch(`${origin}/api/kanban/im/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(expiredSigned),
  })
  assert.equal(expiredRes.status, 410)

  // 6) 真实点击提交审批（POST /api/kanban/im/act）→ 审批 resolved + 卡片回 running + Outbox 唤醒主会话
  const postActRes = await fetch(`${origin}/api/kanban/im/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(validParams),
  })
  assert.equal(postActRes.status, 200)
  const postActData = await postActRes.json()
  assert.equal(postActData.ok, true)
  assert.equal(postActData.alreadyResolved, false)
  assert.equal(postActData.card.status, 'running')
  assert.equal(postActData.approval.status, 'approved')
  assert.deepEqual(postActData.approval.resolution.optionIds, ['approve_d1'])

  const snapAfterPost = await store.read()
  const outboxWake = (snapAfterPost.outbox || []).find(
    e => e.cardId === createdCard.id && e.kind === 'approval' && e.status === 'pending',
  )
  assert.ok(outboxWake, '钉钉按钮审批通过后必须向绑定会话入队 Outbox 唤醒消息')
  assert.equal(outboxWake.target.sessionId, 'session-worker-dt-01')

  // 7) 幂等重放验证：重复点击同一审批按钮（含 HTML form 提交）返回 200 alreadyResolved: true 且不重复入队
  const replayJsonRes = await fetch(`${origin}/api/kanban/im/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(validParams),
  })
  assert.equal(replayJsonRes.status, 200)
  const replayJsonData = await replayJsonRes.json()
  assert.equal(replayJsonData.alreadyResolved, true)

  const formBody = new URLSearchParams(validParams).toString()
  const replayFormRes = await fetch(`${origin}/api/kanban/im/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
    body: formBody,
  })
  assert.equal(replayFormRes.status, 200)
  const replayHtml = await replayFormRes.text()
  assert.ok(replayHtml.includes('已处理'))
})

test('原生独立微信通道（腾讯 iLink Bot 协议）：扫码登录 + 入站建卡/追问/数字拍板 + 出站分片推送 + 会话过期处理', async t => {
  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()

  const sentMessages = []
  let qrStage = 'scaned'

  const mockFetch = async (urlStr, init = {}) => {
    const u = new URL(urlStr)
    if (u.pathname.endsWith('/ilink/bot/get_bot_qrcode')) {
      return new Response(JSON.stringify({
        qrcode: 'qr-token-001',
        qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/mock-001',
      }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/get_qrcode_status')) {
      if (qrStage === 'scaned') {
        return new Response(JSON.stringify({ status: 'scaned' }), { status: 200 })
      }
      return new Response(JSON.stringify({
        status: 'confirmed',
        bot_token: 'wx-bot-secret-token',
        ilink_bot_id: 'wxbot_kanban@im.bot',
        ilink_user_id: 'wxuser_demo@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/sendmessage')) {
      const parsedBody = JSON.parse(init.body)
      sentMessages.push({
        headers: init.headers,
        body: parsedBody,
      })
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/getupdates')) {
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'buf-1' }), { status: 200 })
    }
    throw new Error(`Unexpected URL: ${urlStr}`)
  }

  const weixinChannel = createWeixinChannel({
    store,
    dataDir,
    enabled: true,
    pollEnabled: false,
    fetchImpl: mockFetch,
  })
  t.after(() => weixinChannel.stop())

  const { origin } = await startTestServer(t, {
    store,
    staticRoot: join(dataDir, 'static'),
    weixinChannel,
  })

  // 1) 通过 HTTP 接口发起微信扫码登录并轮询确认
  const qrStartRes = await fetch(`${origin}/api/kanban/im/weixin/qr`, { method: 'POST' })
  assert.equal(qrStartRes.status, 200)
  const qrStartData = await qrStartRes.json()
  assert.equal(qrStartData.qrcode, 'qr-token-001')
  assert.equal(qrStartData.qrcodeUrl, 'https://ilinkai.weixin.qq.com/qr/mock-001')

  const scanRes = await fetch(`${origin}/api/kanban/im/weixin/qr-status?qrcode=qr-token-001`)
  assert.equal((await scanRes.json()).status, 'scaned')

  qrStage = 'confirmed'
  const confirmRes = await fetch(`${origin}/api/kanban/im/weixin/qr-status?qrcode=qr-token-001`)
  const confirmData = await confirmRes.json()
  assert.equal(confirmData.loggedIn, true)
  assert.equal(confirmData.accountId, 'wxbot_kanban@im.bot')

  // 验证凭证文件权限为 0600 且隔离在 dataDir/weixin/credentials.json
  const savedCreds = loadWeixinCredentials(dataDir)
  assert.equal(savedCreds.token, 'wx-bot-secret-token')
  const mode = statSync(join(dataDir, 'weixin', 'credentials.json')).mode & 0o777
  assert.equal(mode, 0o600)

  // 2) 模拟收到用户微信入站消息：工程任务自动建卡并携带 context_token 回复用户
  const inboundTask = await weixinChannel.handleRawUpdateMessage({
    message_id: 'wx-msg-1001',
    from_user_id: 'wxuser_demo@im.wechat',
    message_type: 1, // USER
    context_token: 'ctx-token-live-abc',
    item_list: [
      { type: 1, text_item: { text: '帮我新建任务：实现日志引擎 10x 确定性回放基准测试' } },
    ],
  })
  assert.equal(inboundTask.handled, true)
  assert.ok(inboundTask.cardId)
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].headers.Authorization, 'Bearer wx-bot-secret-token')
  assert.equal(sentMessages[0].body.msg.to_user_id, 'wxuser_demo@im.wechat')
  assert.equal(sentMessages[0].body.msg.context_token, 'ctx-token-live-abc')
  assert.ok(sentMessages[0].body.msg.item_list[0].text_item.text.includes(inboundTask.cardId))

  // 重复消息去重幂等
  const dupRes = await weixinChannel.handleRawUpdateMessage({
    message_id: 'wx-msg-1001',
    from_user_id: 'wxuser_demo@im.wechat',
    message_type: 1,
    context_token: 'ctx-token-live-abc',
    item_list: [{ type: 1, text_item: { text: '重复投递' } }],
  })
  assert.equal(dupRes.handled, false)
  assert.equal(dupRes.reason, 'duplicate')

  // 3) 绑定会话并发起审批 → 自动通过原生微信通道推送通知 → 用户在微信直接回复数字 "2" 完成审批并唤醒会话！
  const notifier = createImAutoNotifier({
    store,
    dataDir,
    weixinChannel,
    fetchImpl: mockFetch,
  })
  t.after(() => notifier.dispose())
  await notifier.checkTransitions() // 初始化基线

  await store.update(draft => {
    const card = draft.cards.find(c => c.id === inboundTask.cardId)
    card.sessionIds = ['session-wx-worker-1']
    requestApproval(draft, card.id, {
      title: '回放数据源选择',
      options: [
        { id: 'sample_40', label: '先跑小规模样本', outcome: 'running' },
        { id: 'full_80', label: '直接跑全量样本', outcome: 'running' },
      ],
    })
  })
  await notifier.checkTransitions()

  // 自动通知已推送到微信
  assert.equal(sentMessages.length, 2)
  const approvalPushText = sentMessages[1].body.msg.item_list[0].text_item.text
  assert.ok(approvalPushText.includes('直接回复数字 1-2'))

  // 用户在微信回复数字 "2" 一键拍板第 2 个选项
  const numericReply = await weixinChannel.handleRawUpdateMessage({
    message_id: 'wx-msg-1002',
    from_user_id: 'wxuser_demo@im.wechat',
    message_type: 1,
    context_token: 'ctx-token-live-def',
    item_list: [{ type: 1, text_item: { text: '2' } }],
  })
  assert.equal(numericReply.handled, true)
  assert.equal(numericReply.route, 'approval_reply')

  const snapAfterWxApprove = await store.read()
  const updatedCard = snapAfterWxApprove.cards.find(c => c.id === inboundTask.cardId)
  assert.equal(updatedCard.status, 'running')
  assert.deepEqual(updatedCard.approvals[0].resolution.optionIds, ['full_80'])
  assert.ok((snapAfterWxApprove.outbox || []).some(e => e.cardId === updatedCard.id && e.kind === 'approval'))

  // 4) 超长消息分片验证（> 2000 字符自动切分并标注 (1/2)、(2/2)）
  const longText = `${'段落A'.repeat(450)}\n\n${'段落B'.repeat(450)}`
  const chunks = formatWeixinChunks(splitWeixinChunks(longText, 2000))
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].endsWith('(1/2)'))
  assert.ok(chunks[1].endsWith('(2/2)'))
  assert.equal(WEIXIN_SESSION_EXPIRED_ERRCODE, -14)
})

test('全局「自动推进（Autopilot）」总开关（REST + MCP + Watchdog + 依赖唤醒）与 DeepSeek 瞬时错误识别', async t => {
  assert.equal(isTransientTurnError('SERVER', 'Service is too busy. Please try again later.'), true)
  assert.equal(isTransientTurnError('STREAM_CLOSED', 'DeepSeek Messages stream ended before message_stop'), true)
  assert.equal(isTransientTurnError('AUTH_INVALID', 'Invalid API key'), false)

  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()
  saveImConfig(dataDir, { targets: [] })

  const watchdog = createWatchdog({ store, autoSchedule: false })
  const { origin } = await startTestServer(t, { store, staticRoot: join(dataDir, 'static') })

  // 默认全局自动推进为 true
  const stateRes1 = await fetch(`${origin}/api/kanban/state`)
  const stateData1 = await stateRes1.json()
  assert.equal(stateData1.autoAdvanceEnabled, true)

  // 1) 通过 REST 关闭全局自动推进
  const pauseRes = await fetch(`${origin}/api/kanban/autopilot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(pauseRes.status, 200)
  assert.equal((await pauseRes.json()).autoAdvanceEnabled, false)
  assert.equal(getAutoAdvanceEnabled(await store.read()), false)

  // 创建前置卡 A（running）与依赖卡 B（blocked + autoStart: true）
  let cardA = null
  let cardB = null
  await store.update(draft => {
    cardA = createCard(draft, {
      title: '前置录制卡 R1',
      status: 'running',
      cwd: '/workspace/stream-engine',
      sessionId: 'sess-r1',
    }).card
    cardB = createCard(draft, {
      title: '下游回放卡 R2',
      status: 'blocked',
      dependsOn: [cardA.id],
      autoStart: true,
      cwd: '/workspace/stream-engine',
      sessionId: 'sess-r2',
    }).card
  })

  // 暂停期间完成前置卡 A：B 必须解阻回到 backlog 并注入 handoff，但绝不自动升入 running，且保留 B.autoStart === true！
  await store.update(draft => {
    completeCard(draft, cardA.id, { result: '已完成样本录制' })
  })
  const snapPaused = await store.read()
  const bPaused = snapPaused.cards.find(c => c.id === cardB.id)
  assert.equal(bPaused.status, 'backlog', '全局自动推进暂停时，依赖就绪卡只退回 backlog，不自动升入 running')
  assert.equal(bPaused.autoStart, true, '暂停全局自动推进不得丢失单卡原有的 autoStart 设置')
  assert.ok(bPaused.handoff?.summary.includes('已完成样本录制'), '上游交接摘要仍正常合成')

  // Watchdog 在全局暂停期间不会自动点火 B
  const pausedTick = await watchdog.tick()
  assert.equal(pausedTick.started.length, 0)

  // 2) 通过 MCP `kanban_autopilot` 重新开启全局自动推进 → Watchdog 立即点火启动 B，并对瞬时 STREAM_CLOSED 错误排入重试！
  const mcpEnable = await handleMcpJsonRpc(store, {
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: {
      name: 'kanban_autopilot',
      arguments: { enabled: true },
    },
  })
  const mcpPayload = JSON.parse(mcpEnable.result.content[0].text)
  assert.equal(mcpPayload.autoAdvanceEnabled, true)

  const resumedTick = await watchdog.tick()
  assert.equal(resumedTick.started.length, 1)
  assert.equal(resumedTick.started[0].id, cardB.id)

  // 模拟 B 在执行中遭遇 DeepSeek `STREAM_CLOSED` 瞬时中断 → Watchdog 自动排入第 1/2 次退避重试
  const tFail = Date.now()
  await store.update(draft => {
    const b = draft.cards.find(c => c.id === cardB.id)
    pushActivity(draft, b, {
      type: 'error',
      text: '会话执行失败：DeepSeek Messages stream ended before message_stop',
      data: {
        kind: SESSION_TURN_FAILURE,
        code: 'STREAM_CLOSED',
        message: 'DeepSeek Messages stream ended before message_stop',
        sessionId: 'sess-r2',
        turn: 1,
      },
      at: tFail,
    })
    changeStatus(draft, b, 'failed', {
      text: '因会话异常进入失败',
      data: { reason: SESSION_TURN_FAILURE },
      now: tFail,
    })
  })

  const retryTick = await watchdog.tick(tFail + 1000)
  assert.equal(retryTick.retried.length, 1)
  assert.equal(retryTick.retried[0].id, cardB.id)
})

test('固定本地 IM 桥接监听 + 钉钉 Markdown 右边界/多行加固：兼容旧版 `/?cardId=...` 且宿主重启换端口不断联', async t => {
  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()

  // 模拟 DSH 宿主上一次运行的动态端口为 53242
  saveRuntimeOrigin(dataDir, 'http://127.0.0.1:53242')

  let targetCard = null
  await store.update(draft => {
    const { card } = createCard(draft, {
      title: 'C2 Cloudflare Worker + D1 同步服务端',
      summary: '已完成 `cloudflare/worker.mjs` 与 `# schema.sql`\n第二行：26 个单测全绿',
      status: 'done',
      project: 'dsh-kanban',
    })
    targetCard = card
  })

  const { routes, close } = createRoutes({ store, activateHost: false })
  t.after(() => close())

  const bridge = createImLocalBridgeServer({
    routes,
    port: 0,
    host: '127.0.0.1',
    dataDir,
  })
  t.after(() => bridge.close())

  const bridgeOrigin = await bridge.ready
  assert.ok(bridgeOrigin && bridgeOrigin.startsWith('http://127.0.0.1:'))
  assert.equal(loadImBridgeOrigin(dataDir), bridgeOrigin)
  assert.equal(loadRuntimeOrigin(dataDir), 'http://127.0.0.1:53242', '启动固定桥接不得覆盖宿主真实动态端口')

  // 1) 历史钉钉卡片中的旧链接 `http://127.0.0.1:<bridge>/?cardId=card-xxx` 直接打通并触发聚焦指令
  const legacyRes = await fetch(`${bridgeOrigin}/?cardId=${targetCard.id}`, {
    headers: { 'sec-fetch-site': 'cross-site', accept: 'text/html' },
  })
  assert.equal(legacyRes.status, 200)
  const legacyHtml = await legacyRes.text()
  assert.ok(legacyHtml.includes(targetCard.title))
  assert.ok(legacyHtml.includes(`dsh://kanban?cardId=${targetCard.id}`))
  assert.ok(legacyHtml.includes(`/dsh-kanban/?cardId=${targetCard.id}`))
  assert.equal(loadRuntimeOrigin(dataDir), 'http://127.0.0.1:53242', '访问固定桥接端口不得污染宿主 origin')

  // 2) 新发出的钉钉通知优先采用固定 bridgeOrigin（而非易变动态端口），且 Markdown 冒号置于粗体外、保留多行空行、清洗反引号与井号
  let capturedBody = null
  const sendRes = await sendWebhookNotification(
    {
      template: 'card_completed',
      card: targetCard,
      result: '交付 `cloudflare/worker.mjs`\n### 子标题已清洗为粗体安全段落',
    },
    {
      id: 'dt-bridge-test',
      provider: 'dingtalk',
      url: 'https://oapi.dingtalk.com/robot/send?access_token=mock_token_bridge',
      keyword: 'superAgent',
    },
    {
      dataDir,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      },
    },
  )

  assert.equal(sendRes.ok, true)
  const mdText = capturedBody.actionCard.text
  assert.ok(!mdText.includes('`'), `钉钉 Markdown 不应残留反引号:\n${mdText}`)
  assert.ok(mdText.includes('**所属项目**：') && mdText.includes('**交付结论**：'), '粗体闭合标记不应包裹全角冒号，确保钉钉移动端 CommonMark 稳定加粗')
  assert.ok(mdText.includes('\n\n'), '多行摘要/结果应转换为钉钉可渲染的双换行段落')
  assert.equal(
    capturedBody.actionCard.singleURL,
    `${bridgeOrigin}/api/kanban/im/open?cardId=${targetCard.id}`,
    '钉钉按钮应优先指向固定桥接端口，避免宿主重启后连接被拒',
  )
})

test('宿主重启恢复闭环：孤儿 running 卡片自动入队恢复（不耗催办配额）+ 懒加载 Super Agent 会话首轮前补齐提示词', async t => {
  assert.equal(isTransientTurnError('INTERRUPTED', '进程在本轮结束前退出'), true)
  assert.equal(isTransientTurnError('', '进程在本轮结束前退出'), true)

  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()

  const preBootAt = 1_700_000_000_000
  const bootedAt = preBootAt + 60_000

  let stuckCard = null
  await store.update(draft => {
    setSuperAgentSessionId(draft, 'session-super-lazy-01')
    const { card } = createCard(draft, {
      title: 'C3 本地增量同步守护器',
      status: 'running',
      cwd: '/tmp/dsh-kanban',
      sessionId: 'session-worker-c3',
      now: preBootAt - 10_000,
    })
    stuckCard = card
    recordSessionTurnWatermark(draft, {
      sessionId: 'session-worker-c3',
      turn: 3,
      phase: 'running',
      at: preBootAt,
    })
  })

  const watchdog = createWatchdog({
    store,
    now: () => bootedAt + 1_000,
  })

  // 未恢复前，普通 tick 会因 phase === 'running' 误判会话仍在推理而跳过
  const beforeRecoverTick = await watchdog.tick(bootedAt + 300_000)
  assert.equal(beforeRecoverTick.nudged.length, 0)

  // 执行启动断流恢复：精准识别 at < bootedAt 的孤儿 running 卡，重置水位并入队 restart_resume
  const recovery = await watchdog.recoverInterruptedRuns({ customBootedAt: bootedAt })
  assert.equal(recovery.recovered.length, 1)
  assert.equal(recovery.recovered[0].id, stuckCard.id)

  const snapAfterRecover = await store.read()
  const recoveredCard = snapAfterRecover.cards.find(c => c.id === stuckCard.id)
  assert.equal(recoveredCard.runtime.turnWatermark.phase, 'idle')
  assert.equal(recoveredCard.runtime.budget.nudgesUsed, 0, '宿主重启恢复不应消耗静默催办额度')
  const resumeEntry = (snapAfterRecover.outbox || []).find(
    e => e.cardId === stuckCard.id && e.kind === 'restart_resume' && e.status === 'pending',
  )
  assert.ok(resumeEntry, '应入队 restart_resume Outbox 消息唤醒被重启打断的卡片会话')
  assert.equal(resumeEntry.target.sessionId, 'session-worker-c3')

  // 再次调用幂等不重复入队
  const secondRecovery = await watchdog.recoverInterruptedRuns({ customBootedAt: bootedAt })
  assert.equal(secondRecovery.recovered.length, 0)

  // 验证懒加载会话在 turn/start 时可触发 onSessionTurnStart 补齐 Super Agent 提示词
  let listener = null
  const decoratedSessions = []
  registerSessionTurnSync(
    {
      on(eventName, fn) {
        if (eventName === 'session/event') listener = fn
        return () => {}
      },
    },
    {
      store,
      watchdog,
      onSessionTurnStart: async session => {
        decoratedSessions.push(session.id)
      },
    },
  )
  assert.equal(typeof listener, 'function')
  await listener({ id: 'session-super-lazy-01' }, { type: 'turn/start', turn: 1 })
  assert.deepEqual(decoratedSessions, ['session-super-lazy-01'])
})

test('IM 可视化配置与退出接口：PUT /im/config 安全局部更新（不覆盖脱敏 URL）+ 首次扫码自动启用 + POST /im/weixin/logout', async t => {
  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()

  const mockFetch = async urlStr => {
    const u = new URL(urlStr)
    if (u.pathname.endsWith('/ilink/bot/get_bot_qrcode')) {
      return new Response(JSON.stringify({
        qrcode: 'qr-ui-001',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=mock-ui-001',
      }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/get_qrcode_status')) {
      return new Response(JSON.stringify({
        status: 'confirmed',
        bot_token: 'wx-ui-bot-token',
        ilink_bot_id: 'wxbot_ui@im.bot',
        ilink_user_id: 'wxuser_ui@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/getupdates')) {
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'buf-ui' }), { status: 200 })
    }
    throw new Error(`Unexpected URL: ${urlStr}`)
  }

  // 初始未启用微信通道（模拟用户首次打开看板点击「生成微信扫码二维码」，pollEnabled 默认 true）
  const weixinChannel = createWeixinChannel({
    store,
    dataDir,
    enabled: false,
    pollEnabled: true,
    fetchImpl: mockFetch,
  })
  t.after(() => weixinChannel.stop())

  const { origin } = await startTestServer(t, {
    store,
    staticRoot: join(dataDir, 'static'),
    weixinChannel,
  })

  // 1) 添加钉钉 Webhook 机器人，返回脱敏 URL，磁盘保留真实 URL 与加签密钥
  const rawSecretUrl = 'https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890fedcba'
  const addRes = await fetch(`${origin}/api/kanban/im/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      addTarget: {
        id: 'dt-ui-bot',
        provider: 'dingtalk',
        name: '研发通知群',
        url: rawSecretUrl,
        keyword: 'superAgent',
        secret: 'SEC_UI_MOCK_999',
      },
    }),
  })
  assert.equal(addRes.status, 200)
  const addData = await addRes.json()
  assert.equal(addData.config.targets.length, 1)
  assert.ok(addData.config.targets[0].urlMasked.includes('****'))
  assert.equal(addData.config.targets[0].hasSecret, true)

  // 2) 切换开关 patchTarget(enabled: false)，绝不破坏磁盘上的原始 URL 与 secret
  const toggleRes = await fetch(`${origin}/api/kanban/im/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patchTarget: { id: 'dt-ui-bot', enabled: false },
    }),
  })
  assert.equal(toggleRes.status, 200)
  const diskCfg = loadImConfig(dataDir)
  assert.equal(diskCfg.targets[0].enabled, false)
  assert.equal(diskCfg.targets[0].url, rawSecretUrl)
  assert.equal(diskCfg.targets[0].secret, 'SEC_UI_MOCK_999')

  // 3) 更新推送偏好事件列表，自动保留 light_text 测试能力
  const rulesRes = await fetch(`${origin}/api/kanban/im/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      events: ['approval_requested', 'card_blocked'],
    }),
  })
  const rulesData = await rulesRes.json()
  assert.deepEqual(rulesData.config.weixin.events, ['approval_requested', 'card_blocked', 'light_text'])

  // 4) 首次扫码确认后，自动激活 enabled=true 并启动后台轮询，无需重启宿主
  await fetch(`${origin}/api/kanban/im/weixin/qr`, { method: 'POST' })
  const confirmRes = await fetch(`${origin}/api/kanban/im/weixin/qr-status?qrcode=qr-ui-001`)
  const confirmData = await confirmRes.json()
  assert.equal(confirmData.loggedIn, true)
  assert.equal(weixinChannel.status().enabled, true)
  assert.equal(weixinChannel.status().running, true)

  // 5) 断开微信连接：停止轮询并清除本地 credentials.json
  const logoutRes = await fetch(`${origin}/api/kanban/im/weixin/logout`, { method: 'POST' })
  assert.equal(logoutRes.status, 200)
  const logoutData = await logoutRes.json()
  assert.equal(logoutData.weixinLive.loggedIn, false)
  assert.equal(logoutData.weixinLive.running, false)
  assert.equal(logoutData.config.weixin.enabled, false)
  assert.equal(loadWeixinCredentials(dataDir), null)

  // 6) 移除 Webhook 机器人
  const removeRes = await fetch(`${origin}/api/kanban/im/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removeTargetId: 'dt-ui-bot' }),
  })
  const removeData = await removeRes.json()
  assert.equal(removeData.config.targets.length, 0)
})

test('微信入站真实 ★ Super Agent 推理闭环（调用 kanban_cards/kanban_card 分析卡点）+ 离线富简报兜底 + MCP 状态发现', async t => {
  const dataDir = makeTempDir(t)
  const store = createStore({ dataDir, seedMode: 'empty' })
  await store.ready()

  // 准备两张真实感进行中/受阻卡片（其中一张带有微信个人外部线程 ID，验证 1v1 私聊不会吞噬新查板问题）
  let runningCardId = ''
  let depBlockedCardId = ''
  await store.update(draft => {
    const c1 = createCard(draft, {
      title: '连接池回执与消费吞吐排查',
      project: 'stream-engine',
      status: 'running',
      externalThreadId: 'weixin:wxuser_demo@im.wechat',
      checklists: [
        { text: '复盘压测批次 C 回执', done: true },
        { text: '改造 feed.py 流控', done: false },
      ],
    }, { allowUnboundCard: true }).card
    c1.currentAction = '已定位 75 号请求越过 15s 守卫，正在改造 feed.py 流控'
    runningCardId = c1.id

    const c2 = createCard(draft, {
      title: '高并发档位压测',
      project: 'stream-engine',
      status: 'running',
      dependsOn: [c1.id],
    }, { allowUnboundCard: true }).card
    c2.currentAction = '等待流控补丁合入后点火'
    c2.runtime = {
      generation: 1,
      watchdog: { state: 'stalled', nudgesUsed: 1, retriesUsed: 0 },
    }
    depBlockedCardId = c2.id
  })

  const sentWeixinTexts = []
  const mockFetch = async (urlStr, init = {}) => {
    const u = new URL(urlStr)
    if (u.pathname.endsWith('/ilink/bot/sendmessage')) {
      const parsed = JSON.parse(init.body)
      sentWeixinTexts.push(parsed.msg.item_list[0].text_item.text)
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-sa', qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/sa' }), { status: 200 })
    }
    if (u.pathname.endsWith('/ilink/bot/get_qrcode_status')) {
      return new Response(JSON.stringify({
        status: 'confirmed',
        bot_token: 'wx-sa-token',
        ilink_bot_id: 'wxbot_sa@im.bot',
        ilink_user_id: 'wxuser_demo@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200 })
  }

  // 构建宿主事件总线 + 工具集 + 模拟 sessionController
  const listeners = new Set()
  const emitSessionEvent = (session, event) => {
    for (const fn of [...listeners]) fn(session, event)
  }
  const mockCtx = {
    on(eventName, fn) {
      if (eventName === 'session/event') {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
      return () => {}
    },
  }

  const toolsByName = new Map(createTools({ store }).map(tool => [tool.name, tool]))
  let controllerOnline = true
  const invokedTools = []

  const mockSessionController = {
    async create() {
      return { sessionId: 'session-super-agent-live' }
    },
    async resolveAgent(sessionId) {
      return { agent: { id: sessionId, session: { id: sessionId } } }
    },
    async prompt(req) {
      if (!controllerOnline) throw new Error('host offline')
      const sessionObj = { id: req.sessionId }
      queueMicrotask(async () => {
        emitSessionEvent(sessionObj, { type: 'turn/start', data: { turn: 1 } })
        emitSessionEvent(sessionObj, {
          type: 'user/message',
          data: { source: { kind: 'user', rpcId: req.requestId }, content: req.content },
        })
        emitSessionEvent(sessionObj, { type: 'step/start', data: { turn: 1, step: 1 } })

        // 第 1 步：Super Agent 真实调用 kanban_cards 与 kanban_card 工具
        emitSessionEvent(sessionObj, { type: 'tool/call', data: { name: 'kanban_cards' } })
        invokedTools.push('kanban_cards')
        const listJson = JSON.parse(await toolsByName.get('kanban_cards').execute({ status: 'running' }, {}))

        emitSessionEvent(sessionObj, { type: 'tool/call', data: { name: 'kanban_card' } })
        invokedTools.push('kanban_card')
        const detail1 = JSON.parse(await toolsByName.get('kanban_card').execute({ cardId: runningCardId }, {}))
        const detail2 = JSON.parse(await toolsByName.get('kanban_card').execute({ cardId: depBlockedCardId }, {}))

        const answer = [
          '### 当前进行中卡片与卡点',
          `1. **${detail1.card.title}**（\`${detail1.card.id}\`）`,
          `   - 进展：${detail1.card.currentAction}`,
          `   - 卡点：75 号请求越过 15s 守卫，正在改流控（共 ${listJson.cards.length} 张进行中）`,
          `2. **${detail2.card.title}**（\`${detail2.card.id}\`）`,
          `   - 卡点：受前置依赖 ${runningCardId} 阻塞，且 Watchdog 状态为 ${detail2.card.runtime.watchdog.state}`,
        ].join('\n')

        emitSessionEvent(sessionObj, {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 2,
            message: { content: [{ type: 'text', text: answer }] },
          },
        })
        emitSessionEvent(sessionObj, {
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'completed' } },
        })
      })
      return { accepted: true }
    },
  }

  const runner = createSuperAgentTurnRunner({
    ctx: mockCtx,
    store,
    getSessionController: () => (controllerOnline ? mockSessionController : null),
  })

  const weixinChannel = createWeixinChannel({
    store,
    dataDir,
    enabled: false,
    pollEnabled: false,
    fetchImpl: mockFetch,
    askAgent: runner.ask,
  })
  t.after(() => weixinChannel.stop())

  const { origin } = await startTestServer(t, {
    store,
    staticRoot: join(dataDir, 'static'),
    weixinChannel,
  })

  // 完成扫码登录以保存凭证
  await fetch(`${origin}/api/kanban/im/weixin/qr`, { method: 'POST' })
  await fetch(`${origin}/api/kanban/im/weixin/qr-status?qrcode=qr-sa`)

  // 1) 用户在微信询问「看板里有哪些进行中的卡片，分别有什么卡点」→ 触发 ★ Super Agent 调 kanban_cards + kanban_card
  const queryRes = await weixinChannel.handleRawUpdateMessage({
    message_id: 'wx-sa-q1',
    from_user_id: 'wxuser_demo@im.wechat',
    message_type: 1,
    context_token: 'ctx-sa-1',
    item_list: [{ type: 1, text_item: { text: '看板里有哪些进行中的卡片，分别有什么卡点' } }],
  })
  assert.equal(queryRes.handled, true)
  assert.equal(queryRes.route, 'super_agent')
  assert.equal(queryRes.decisionRoute, 'board_query')
  assert.deepEqual(invokedTools, ['kanban_cards', 'kanban_card'])
  assert.equal(sentWeixinTexts.length, 1)
  assert.ok(sentWeixinTexts[0].includes('【当前进行中卡片与卡点】'), 'Markdown 标题已净化为纯文本书名号')
  assert.ok(!sentWeixinTexts[0].includes('**'), '不应残留原始 Markdown 星号')
  assert.ok(sentWeixinTexts[0].includes('75 号请求越过 15s 守卫'))
  assert.ok(sentWeixinTexts[0].includes('stalled'))

  // 2) 当宿主离线（controllerOnline = false）时，兜底简报依然包含每张卡的进展与具体卡点（不再只列卡片名称）
  controllerOnline = false
  const fallbackRes = await weixinChannel.handleRawUpdateMessage({
    message_id: 'wx-sa-q2',
    from_user_id: 'wxuser_demo@im.wechat',
    message_type: 1,
    context_token: 'ctx-sa-2',
    item_list: [{ type: 1, text_item: { text: '看板里有哪些进行中的卡片，分别有什么卡点' } }],
  })
  assert.equal(fallbackRes.handled, true)
  assert.equal(fallbackRes.route, 'board_query')
  assert.ok(fallbackRes.replyText.includes('进展：已定位 75 号请求越过 15s 守卫'))
  assert.ok(fallbackRes.replyText.includes('Watchdog 静默停滞熔断'))
  assert.ok(fallbackRes.replyText.includes('等待前置卡：连接池回执与消费吞吐排查'))

  // 3) 验证 GET /api/kanban/im/status 暴露 MCP 接入元数据供前端面板直接展示与复制
  const statusRes = await fetch(`${origin}/api/kanban/im/status`)
  const statusData = await statusRes.json()
  assert.equal(statusData.ok, true)
  assert.ok(statusData.mcp)
  assert.equal(statusData.mcp.loopbackEndpoint, 'http://127.0.0.1:4599/api/kanban/mcp')
  assert.ok(statusData.mcp.stdioScriptPath.endsWith('bin/kanban-mcp.mjs'))
  assert.equal(statusData.mcp.toolCount, 20)
})
