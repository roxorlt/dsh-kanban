// Super-Agent 多端 IM 消息格式/模板引擎 + 统一入站网关（GitHub Issue / 飞书 / 钉钉 / 企微 / 微信 cc2im / OneBot）。
// 意图路由管道已解耦至 `./router.js`（支持 `<dataDir>/router-rules.json` 热加载与 `observe` 灰度模式）。
import crypto from 'node:crypto'
import {
  DomainError,
  LIMITS,
  addComment,
  applyCardAgentAttribution,
  archiveCards,
  changeStatus,
  cleanText,
  completeCard,
  countsFor,
  createCard,
  defaultActor,
  enqueueOutbox,
  ensureCardRuntime,
  findConvergentCardForCreate,
  getSuperAgentSessionId,
  isCardId,
  mainSessionId,
  mergeCards,
  moveCard,
  normalizeActor,
  normalizeChecklists,
  patchCard,
  pushActivity,
  requestApproval,
  requireCard,
  resolveAgentAttribution,
  resolveApproval,
  restoreCards,
  touchCard,
  touchMeta,
} from './domain.js'
import { CLOUD_MCP_WRITE_TOOLS, sanitizeCloudMcpWriteArgs } from './cloud-mcp.js'
import {
  SUPER_AGENT_BOOTSTRAP_PROMPT,
  classifySuperAgentIntent,
  composeSuperAgentPrompt,
  createIntentRouter,
  loadRouterRules,
  normalizeRouterRule,
  saveRouterRules,
} from './router.js'

export {
  SUPER_AGENT_BOOTSTRAP_PROMPT,
  classifySuperAgentIntent,
  composeSuperAgentPrompt,
  createIntentRouter,
  loadRouterRules,
  normalizeRouterRule,
  saveRouterRules,
}

export const IM_PROVIDERS = ['feishu', 'dingtalk', 'wecom', 'onebot', 'weixin', 'generic']
export const IM_TEMPLATE_TYPES = [
  'approval_requested',
  'card_blocked',
  'card_completed',
  'daily_digest',
  'light_text',
]

function cleanStr(value, maxLen = 500) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLen)
}

function truncateLightText(text, maxChars = 100) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(1, maxChars - 1)) + '…'
}

function injectKeyword(text, keyword, maxChars = 0) {
  const base = String(text || '')
  const kw = cleanStr(keyword, 64)
  if (!kw || base.includes(kw)) {
    return maxChars > 0 ? truncateLightText(base, maxChars) : base
  }
  const tagged = `[${kw}] ${base}`
  return maxChars > 0 ? truncateLightText(tagged, maxChars) : tagged
}

// ---------------- 多端 IM 签名与多模板消息格式引擎 ----------------

/**
 * 飞书自定义机器人 Webhook 签名：
 * 算法：以 `timestamp + "\n" + secret` 作为 HMAC-SHA256 key，对空字符串计算签名并 Base64 编码。
 */
export function signFeishuWebhook(secret, timestampSec = Math.floor(Date.now() / 1000)) {
  const ts = String(timestampSec)
  const stringToSign = `${ts}\n${secret}`
  const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64')
  return { timestamp: ts, sign }
}

/**
 * 钉钉自定义机器人 Webhook URL 签名：
 * 算法：以 `secret` 作为 HMAC-SHA256 key，对 `timestamp + "\n" + secret` 签名并 Base64 + encodeURIComponent。
 */
export function signDingtalkWebhook(secret, timestampMs = Date.now()) {
  const ts = String(timestampMs)
  const stringToSign = `${ts}\n${secret}`
  const rawSign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64')
  return { timestamp: ts, sign: encodeURIComponent(rawSign) }
}

/** 通用 Webhook HMAC-SHA256 签名（Header: X-Kanban-Signature）。 */
export function signGenericWebhook(payloadText, secret, timestampMs = Date.now()) {
  const ts = String(timestampMs)
  const body = typeof payloadText === 'string' ? payloadText : JSON.stringify(payloadText)
  const digest = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  return { timestamp: ts, signature: `sha256=${digest}` }
}

/**
 * 为钉钉/IM 卡片交互按钮生成带过期时间的 HMAC-SHA256 签名查询串参数（防伪造、防重放过期）：
 * 默认有效期 7 天。
 */
export function signImActionQuery({
  cardId,
  approvalId,
  optionId,
  exp,
}, actionSecret, { now = Date.now(), ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
  const cid = cleanStr(cardId, 64)
  const aid = cleanStr(approvalId, 64)
  const oid = cleanStr(optionId, 64)
  const expiresAt = Number.isFinite(Number(exp)) && Number(exp) > 0 ? Math.trunc(Number(exp)) : (now + ttlMs)
  if (!cid || !aid || !oid || !actionSecret) {
    throw new Error('生成 IM 按钮签名缺少必要参数（cardId / approvalId / optionId / actionSecret）')
  }
  const canonical = `v1:${cid}:${aid}:${oid}:${expiresAt}`
  const sig = crypto.createHmac('sha256', String(actionSecret)).update(canonical).digest('hex')
  return { cardId: cid, approvalId: aid, optionId: oid, exp: String(expiresAt), sig }
}

/**
 * 校验钉钉/IM 卡片交互按钮签名与过期时间（常量时间比较）。
 */
export function verifyImActionQuery(params = {}, actionSecret, now = Date.now()) {
  const cid = cleanStr(params.cardId, 64)
  const aid = cleanStr(params.approvalId, 64)
  const oid = cleanStr(params.optionId, 64)
  const expNum = Number(params.exp)
  const sig = cleanStr(params.sig, 128).toLowerCase()
  if (!cid || !aid || !oid || !Number.isFinite(expNum) || !/^[a-f0-9]{64}$/.test(sig) || !actionSecret) {
    return { ok: false, code: 'INVALID_SIGNATURE', status: 403, message: '按钮签名参数不完整或格式无效' }
  }
  const canonical = `v1:${cid}:${aid}:${oid}:${Math.trunc(expNum)}`
  const expected = crypto.createHmac('sha256', String(actionSecret)).update(canonical).digest('hex')
  const okSig = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  if (!okSig) {
    return { ok: false, code: 'INVALID_SIGNATURE', status: 403, message: '按钮签名校验未通过' }
  }
  if (now > expNum) {
    return { ok: false, code: 'ACTION_EXPIRED', status: 410, message: '该审批按钮链接已过期，请在 DSH 看板中操作' }
  }
  return { ok: true, cardId: cid, approvalId: aid, optionId: oid, exp: Math.trunc(expNum) }
}

function extractBaseOrigin(boardUrl = 'http://127.0.0.1:4599') {
  const raw = String(boardUrl || 'http://127.0.0.1:4599').trim().replace(/\/+$/, '')
  try {
    return new URL(raw).origin
  } catch {
    return raw || 'http://127.0.0.1:4599'
  }
}

function sanitizeDingtalkInline(value, maxLen = 0, { multiline = false } = {}) {
  let text = String(value ?? '')
  // 钉钉自定义机器人不支持 ``` 代码块与 ` 行内反引号：代码块转为引用行，行内代码转为中文直角引号「...」
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, body) => (
    String(body || '')
      .trim()
      .split(/\r?\n/)
      .map(line => `> ${line.replace(/`/g, '')}`)
      .join('\n\n')
  ))
  text = text.replace(/`([^`\r\n]+)`/g, '「$1」')
  text = text.replace(/`/g, '')
  // 清理动态内容里可能混入的行首裸 # 标题或未闭合 **，防止把钉钉整段排版带崩
  text = text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*#{1,6}\s+/, ''))
    .join(multiline ? '\n\n' : ' ')
    .replace(/\n{3,}/g, '\n\n')
  return maxLen > 0 ? cleanStr(text, maxLen) : text.trim()
}

/**
 * 严格遵循钉钉开放平台「自定义机器人 Markdown 子集规范」构造正文：
 * 1) 标题 `### ` 必须顶格在行首（严禁被 `[keyword] ` 前缀挤到行中导致 `###` 裸露）；
 * 2) 钉钉不支持行内反引号 `` `code` ``，一律用无反引号的中文直角引号表达；
 * 3) 全角冒号置于 `**字段名**：` 外侧（符合 CommonMark 右侧强调定界规则，避免钉钉移动端/桌面端加粗失效）；
 * 4) 钉钉普通单换行 `\n` 会被合并为同一段落导致粘连，段落与字段之间统一使用双换行 `\n\n`；
 * 5) 自定义安全关键词（如 `superAgent`）放在底部引用行 `> ...` 与卡片 `title`，既满足钉钉安全校验又不破坏排版。
 */
export function buildDingtalkMarkdown(view, { keyword } = {}) {
  const kw = sanitizeDingtalkInline(keyword, 64)
  const footer = `> ${kw ? `${kw} · ` : ''}DSH Super-Agent 看板实时通知`
  const blocks = [`### ${sanitizeDingtalkInline(view.headerTitle)}`]

  if (view.template === 'approval_requested') {
    blocks.push(`**所属项目**：${sanitizeDingtalkInline(view.project)}（${sanitizeDingtalkInline(view.cardId)}）`)
    blocks.push(`**确认事项**：${sanitizeDingtalkInline(view.questionTitle)}`)
    if (view.detail) {
      blocks.push(`**背景说明**：${sanitizeDingtalkInline(view.detail, 240, { multiline: true })}`)
    }
    if (Array.isArray(view.options) && view.options.length > 0) {
      const optLines = view.options.map((o, idx) => (
        `${idx + 1}. **${sanitizeDingtalkInline(o.label)}**${o.description ? ` — ${sanitizeDingtalkInline(o.description, 80)}` : ''}`
      ))
      blocks.push(`**可选决策**（可直接点击下方按钮提交）：\n\n${optLines.join('\n\n')}`)
    }
  } else if (view.template === 'card_blocked') {
    blocks.push(`**所属项目**：${sanitizeDingtalkInline(view.project)}（${sanitizeDingtalkInline(view.cardId)}）`)
    blocks.push(`**受阻原因**：${sanitizeDingtalkInline(view.reason, 260, { multiline: true })}`)
    blocks.push('**恢复方式**：点击下方按钮拉起 DSH 看板查看详情并恢复推进')
  } else if (view.template === 'card_completed') {
    blocks.push(`**所属项目**：${sanitizeDingtalkInline(view.project)}（${sanitizeDingtalkInline(view.cardId)}）`)
    blocks.push(`**交付结论**：${sanitizeDingtalkInline(view.result, 300, { multiline: true })}`)
  } else if (view.template === 'daily_digest') {
    const c = view.counts || {}
    blocks.push(
      `**全局状态**：进行中 **${c.running || 0}** ｜ 待你确认 **${c.needs_you || 0}** ｜ 待办 **${c.backlog || 0}** ｜ 已完成 **${c.done || 0}**`,
    )
    if (Array.isArray(view.highlights) && view.highlights.length > 0) {
      blocks.push(`**重点事项**：\n\n${view.highlights.map(h => `- ${sanitizeDingtalkInline(h)}`).join('\n\n')}`)
    }
  } else {
    blocks.push(sanitizeDingtalkInline(view.lightText || '', 0, { multiline: true }))
  }

  blocks.push(footer)
  return blocks.filter(Boolean).join('\n\n')
}

function buildNormalizedEventView(event = {}) {
  const template = IM_TEMPLATE_TYPES.includes(event.template) ? event.template : 'light_text'
  const card = event.card || {}
  const approval = event.approval || (Array.isArray(card.approvals) ? card.approvals.find(a => a.status === 'pending') : null)
  const cardId = card.id || event.cardId || 'card-unknown'
  const cardTitle = card.title || event.title || '未命名卡片'
  const project = card.project || event.project || 'default'
  const status = card.status || event.status || 'running'
  const options = Array.isArray(approval?.options) ? approval.options : []

  if (template === 'approval_requested') {
    const qTitle = approval?.title || event.question || '需要你的确认'
    const detail = approval?.detail || card.currentAction || card.summary || ''
    const optSummary = options.map((o, idx) => `${idx + 1}. ${o.label} (\`/approve ${cardId} ${o.id}\`)`).join('\n')
    const lightText = truncateLightText(
      `【待你确认】${cardTitle}：${qTitle}。可回复 /approve ${cardId} ${options[0]?.id || 'yes'}`,
      100,
    )
    return {
      template,
      headerColor: 'orange',
      headerTitle: `🟠 待你确认｜${cardTitle}`,
      cardId,
      cardTitle,
      project,
      status,
      approvalId: approval?.id || null,
      questionTitle: qTitle,
      detail,
      options,
      markdownBody: [
        `**卡片**：\`${cardId}\`（项目：\`${project}\`）`,
        `**确认事项**：${qTitle}`,
        detail ? `**背景说明**：${cleanStr(detail, 240)}` : '',
        optSummary ? `**快捷拍板指令**：\n${optSummary}` : '',
      ].filter(Boolean).join('\n'),
      lightText,
    }
  }

  if (template === 'card_blocked') {
    const reason = event.reason || card.currentAction || '执行受阻或 Watchdog 静默停滞熔断，等待人工介入'
    const lightText = truncateLightText(`【受阻告警】${cardTitle} (${cardId})：${reason}`, 100)
    return {
      template,
      headerColor: 'red',
      headerTitle: `🔴 任务受阻｜${cardTitle}`,
      cardId,
      cardTitle,
      project,
      status: 'blocked',
      reason,
      options: [],
      markdownBody: [
        `**卡片**：\`${cardId}\`（项目：\`${project}\`）`,
        `**受阻原因**：${cleanStr(reason, 260)}`,
        `**恢复方式**：直接在本线程回复处理意见，或在看板点击「重试 / 继续推进」`,
      ].join('\n'),
      lightText,
    }
  }

  if (template === 'card_completed') {
    const resultText = card.result || event.result || card.handoff?.summary || '已完成全部检查项并收口'
    const lightText = truncateLightText(`【已完成】${cardTitle} (${cardId})：${resultText}`, 100)
    return {
      template,
      headerColor: 'green',
      headerTitle: `🟢 任务完成｜${cardTitle}`,
      cardId,
      cardTitle,
      project,
      status: 'done',
      result: resultText,
      options: [],
      markdownBody: [
        `**卡片**：\`${cardId}\`（项目：\`${project}\`）`,
        `**交付结论**：${cleanStr(resultText, 300)}`,
      ].join('\n'),
      lightText,
    }
  }

  if (template === 'daily_digest') {
    const counts = event.counts || { backlog: 0, running: 0, needs_you: 0, done: 0 }
    const highlights = Array.isArray(event.highlights) ? event.highlights.slice(0, 5) : []
    const lightText = truncateLightText(
      `【看板简报】进行中 ${counts.running || 0}｜待确认 ${counts.needs_you || 0}｜待办 ${counts.backlog || 0}｜已完成 ${counts.done || 0}`,
      100,
    )
    return {
      template,
      headerColor: 'blue',
      headerTitle: `📊 Super-Agent 看板简报`,
      cardId,
      cardTitle,
      project,
      status,
      counts,
      highlights,
      options: [],
      markdownBody: [
        `**全局状态**：进行中 **${counts.running || 0}** ｜ 待你确认 **${counts.needs_you || 0}** ｜ 待办 **${counts.backlog || 0}** ｜ 已完成 **${counts.done || 0}**`,
        highlights.length ? `**重点事项**：\n${highlights.map(h => `- ${h}`).join('\n')}` : '',
      ].filter(Boolean).join('\n'),
      lightText,
    }
  }

  const rawText = event.text || card.currentAction || `${cardTitle} 状态更新为 ${status}`
  const lightText = truncateLightText(rawText, 100)
  return {
    template: 'light_text',
    headerColor: 'blue',
    headerTitle: `💬 看板通知｜${cardTitle}`,
    cardId,
    cardTitle,
    project,
    status,
    options: [],
    markdownBody: lightText,
    lightText,
  }
}

/**
 * 将看板事件格式化为指定外部 IM 平台的标准出站 Payload：
 * 支持：
 * - `feishu`：飞书 `interactive` 消息卡片（含彩色 header、markdown 字段、交互按钮 `action`、note 脚注）与 `text` 极简模式；
 * - `dingtalk`：钉钉 `actionCard`（支持独立跳转按钮 `btns` 与单按钮 `singleTitle`）与 `markdown` 模式；
 * - `wecom`：企业微信 `template_card`（`text_notice` 模板）与 `markdown` 模式；
 * - `onebot`：OneBot v11 标准 `send_msg`（适配微信/QQ 桥接器如 LangBot / AstrBot / NapCat）；
 * - `generic`：通用 JSON Webhook。
 */
export function formatImNotification(event = {}, {
  provider = 'feishu',
  format = 'card',
  boardUrl = 'http://127.0.0.1:4599',
  secret,
  actionSecret,
  actionTtlMs,
  keyword,
  timestamp,
  onebotTarget = {},
} = {}) {
  const normalizedProvider = IM_PROVIDERS.includes(provider) ? provider : 'generic'
  const view = buildNormalizedEventView(event)
  const useLightText = format === 'text' || view.template === 'light_text'
  const baseOrigin = extractBaseOrigin(boardUrl)
  const cardLink = `${baseOrigin}/dsh-kanban/?cardId=${encodeURIComponent(view.cardId)}`
  const openInDshUrl = view.template === 'daily_digest'
    ? `${baseOrigin}/api/kanban/im/open`
    : `${baseOrigin}/api/kanban/im/open?cardId=${encodeURIComponent(view.cardId)}`

  if (normalizedProvider === 'feishu') {
    const signFields = secret
      ? signFeishuWebhook(secret, timestamp ? Math.floor(Number(timestamp) / (timestamp > 1e11 ? 1000 : 1)) : undefined)
      : {}
    if (useLightText) {
      return {
        ...signFields,
        msg_type: 'text',
        content: { text: injectKeyword(view.lightText, keyword, 100) },
      }
    }
    const elements = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: view.markdownBody,
        },
      },
    ]
    if (view.options.length > 0) {
      elements.push({
        tag: 'action',
        actions: view.options.slice(0, 4).map(opt => ({
          tag: 'button',
          text: { tag: 'plain_text', content: opt.label },
          type: opt.tone === 'danger' ? 'danger' : opt.tone === 'primary' ? 'primary' : 'default',
          value: {
            action: 'resolve_approval',
            cardId: view.cardId,
            approvalId: view.approvalId,
            optionId: opt.id,
          },
        })),
      })
    }
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `DSH Super-Agent Kanban · ${view.cardId} · 通知摘要 ≤100 字`,
        },
      ],
    })
    return {
      ...signFields,
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true, enable_forward: true },
        header: {
          template: view.headerColor,
          title: { tag: 'plain_text', content: injectKeyword(view.headerTitle, keyword) },
        },
        elements,
      },
    }
  }

  if (normalizedProvider === 'dingtalk') {
    const nowTs = timestamp ? Number(timestamp) : Date.now()
    const signature = secret ? signDingtalkWebhook(secret, nowTs) : null
    const dtTitle = injectKeyword(view.headerTitle, keyword)
    const dtBody = buildDingtalkMarkdown(view, { keyword })
    if (useLightText) {
      return {
        msgtype: 'text',
        text: { content: injectKeyword(view.lightText, keyword, 100) },
        ...(signature ? { _dingtalkQuery: signature } : {}),
      }
    }
    if (view.options.length > 0) {
      const optionBtns = view.options.slice(0, 4).map(opt => {
        let actionURL = `${openInDshUrl}&approvalId=${encodeURIComponent(view.approvalId || '')}&optionId=${encodeURIComponent(opt.id)}`
        if (actionSecret && view.approvalId) {
          const signed = signImActionQuery({
            cardId: view.cardId,
            approvalId: view.approvalId,
            optionId: opt.id,
          }, actionSecret, { now: nowTs, ...(actionTtlMs ? { ttlMs: actionTtlMs } : {}) })
          const qs = new URLSearchParams(signed).toString()
          actionURL = `${baseOrigin}/api/kanban/im/act?${qs}`
        }
        return {
          title: opt.label,
          actionURL,
        }
      })
      const btns = [
        ...optionBtns,
        {
          title: '在 DSH 看板中查看',
          actionURL: openInDshUrl,
        },
      ]
      return {
        msgtype: 'actionCard',
        actionCard: {
          title: dtTitle,
          text: dtBody,
          btnOrientation: '0',
          btns,
        },
        ...(signature ? { _dingtalkQuery: signature } : {}),
      }
    }
    if (format === 'markdown') {
      return {
        msgtype: 'markdown',
        markdown: {
          title: dtTitle,
          text: dtBody,
        },
        ...(signature ? { _dingtalkQuery: signature } : {}),
      }
    }
    return {
      msgtype: 'actionCard',
      actionCard: {
        title: dtTitle,
        text: dtBody,
        singleTitle: '在 DSH 看板中查看',
        singleURL: openInDshUrl,
      },
      ...(signature ? { _dingtalkQuery: signature } : {}),
    }
  }

  if (normalizedProvider === 'wecom') {
    if (useLightText || format === 'markdown') {
      return {
        msgtype: 'markdown',
        markdown: {
          content: useLightText ? view.lightText : `### ${view.headerTitle}\n${view.markdownBody}`,
        },
      }
    }
    return {
      msgtype: 'template_card',
      template_card: {
        card_type: 'text_notice',
        source: {
          desc: 'DSH Super-Agent Kanban',
          desc_color: 0,
        },
        main_title: {
          title: view.cardTitle.slice(0, 36),
          desc: `${view.template} · ${view.cardId}`,
        },
        sub_title_text: cleanStr(view.lightText, 100),
        horizontal_content_list: [
          { keyname: '卡片 ID', value: view.cardId },
          { keyname: '项目', value: view.project },
          { keyname: '状态', value: view.status },
        ],
        jump_list: [
          { type: 1, title: '打开看板详情', url: cardLink },
        ],
        card_action: {
          type: 1,
          url: cardLink,
        },
      },
    }
  }

  if (normalizedProvider === 'onebot') {
    const messageText = useLightText
      ? view.lightText
      : `${view.headerTitle}\n${view.markdownBody.replace(/\*\*/g, '')}`
    return {
      action: 'send_msg',
      params: {
        message_type: onebotTarget.groupId ? 'group' : 'private',
        ...(onebotTarget.groupId ? { group_id: onebotTarget.groupId } : {}),
        ...(onebotTarget.userId ? { user_id: onebotTarget.userId } : {}),
        message: messageText,
      },
    }
  }

  if (normalizedProvider === 'weixin') {
    let messageText = view.lightText
    if (!useLightText) {
      if (view.template === 'approval_requested' && view.options.length > 0) {
        const optLines = view.options.map((o, idx) => `  ${idx + 1}. ${o.label}（指令：/approve ${view.cardId} ${o.id}）`)
        messageText = [
          view.headerTitle,
          `项目：${view.project}（${view.cardId}）`,
          `确认事项：${view.questionTitle}`,
          view.detail ? `背景：${cleanStr(view.detail, 200)}` : '',
          `可选操作：\n${optLines.join('\n')}`,
          `💡 直接回复数字 1-${view.options.length} 或完整 /approve 指令即可拍板`,
        ].filter(Boolean).join('\n')
      } else {
        messageText = `${view.headerTitle}\n${view.markdownBody.replace(/\*\*/g, '').replace(/`/g, '')}`
      }
    }
    return {
      provider: 'weixin',
      template: view.template,
      cardId: view.cardId,
      text: messageText,
      lightText: view.lightText,
    }
  }

  const genericBody = {
    provider: 'generic',
    template: view.template,
    cardId: view.cardId,
    title: injectKeyword(view.headerTitle, keyword),
    lightText: injectKeyword(view.lightText, keyword, 100),
    markdown: view.markdownBody,
    options: view.options,
    url: cardLink,
  }
  if (secret) {
    genericBody.signature = signGenericWebhook(genericBody, secret, timestamp || Date.now())
  }
  return genericBody
}

// ---------------- 统一入站网关（IM 回调 / 文本指令 / GitHub Issue Webhook & Poller） ----------------

/**
 * 处理单条入站事件（在 `store.update` 事务内调用）：
 * 1) 飞书/钉钉 Challenge URL 验证；
 * 2) 飞书/钉钉交互卡片按钮回调（直接完成 `resolveApproval` 并通过 Outbox 唤醒主会话）；
 * 3) GitHub `issues` / `issue_comment` 事件（按 `github:owner/repo#number` 幂等建卡/同步评论/完成卡片）；
 * 4) IM 文本消息与斜杠命令（通过 `classifySuperAgentIntent` 执行路由分流或 Thread 订阅直通）。
 */
export function handleIngressEvent(draft, payload = {}, { now = Date.now(), githubEvent, dataDir, rules } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new DomainError('BAD_REQUEST', '入站 payload 必须是 JSON 对象')
  }

  // 1) 飞书 / 通用 Webhook URL 验证 Challenge
  if (typeof payload.challenge === 'string' && payload.challenge) {
    return { kind: 'challenge', challenge: payload.challenge }
  }

  // 1b) 云端远程 MCP 入队写操作回放（仅白名单看板控制面工具，严禁触碰本地 cwd/会话）
  if (payload.kind === 'mcp_tool_call') {
    return handleMcpToolIngress(draft, payload, { now })
  }

  // 2) 飞书交互卡片按钮点击回调（action.value）或显式 approval_action
  const actionVal = payload.action?.value || (payload.kind === 'approval_action' ? payload : null)
  if (actionVal && actionVal.cardId && actionVal.optionId) {
    const card = (draft.cards || []).find(c => c.id === actionVal.cardId && !c.archived)
    if (!card) throw new DomainError('CARD_NOT_FOUND', `卡片不存在：${actionVal.cardId}`, 404)
    const approvalId = actionVal.approvalId || (card.approvals || []).find(a => a.status === 'pending')?.id
    if (!approvalId) throw new DomainError('APPROVAL_NOT_FOUND', '当前卡片没有待确认的审批', 404)
    const actor = defaultActor('user', payload.operator?.name || payload.user?.name || 'IM 用户')
    const resolved = resolveApproval(draft, card.id, approvalId, {
      optionId: actionVal.optionId,
      comment: actionVal.comment,
      actor,
      now,
    })
    const primarySess = mainSessionId(resolved.card)
    if (primarySess || resolved.card.cwd || resolved.card.workspaceId) {
      enqueueOutbox(draft, {
        idempotencyKey: `im-approval:${resolved.card.id}:${approvalId}`,
        cardId: resolved.card.id,
        expectedGeneration: resolved.card.runtime?.generation ?? 1,
        kind: 'approval',
        target: {
          ...(primarySess ? { sessionId: primarySess } : {}),
          ...(resolved.card.workspaceId ? { workspaceId: resolved.card.workspaceId } : {}),
          ...(resolved.card.cwd ? { cwd: resolved.card.cwd } : {}),
        },
        prompt: `【看板·审批已提交】卡片「${resolved.card.title}」（${resolved.card.id}）的确认请求「${resolved.approval.title}」已由用户拍板：${(resolved.approval.resolution?.labels || []).join('、') || actionVal.optionId}。请继续推进后续任务。`,
        mode: 'queue',
        notBefore: now,
      }, { now })
    }
    const replyText = `已提交确认「${resolved.approval.title}」→ 卡片状态：${resolved.card.status}`
    return {
      kind: 'approval_resolved',
      card: resolved.card,
      approval: resolved.approval,
      replyText,
      reply: formatImNotification({
        template: 'light_text',
        card: resolved.card,
        text: replyText,
      }, { provider: payload.provider || 'feishu', format: 'text' }),
    }
  }

  // 3) GitHub Issue / Issue Comment 事件（Webhook 实时推送或定时 Poller 同步）
  const ghType = githubEvent || payload.githubEvent || (payload.issue && payload.repository ? (payload.comment ? 'issue_comment' : 'issues') : null)
  if (ghType === 'issues' || ghType === 'issue_comment' || payload.source === 'github') {
    return handleGithubIngress(draft, payload, { now, ghType })
  }

  // 4) 批量 GitHub Issues 轮询同步（入口 1 通过入口 5 定时任务拉取 `gh issue list` 后直接灌入）
  if (Array.isArray(payload.githubIssues)) {
    const synced = syncGithubIssuesIntoDraft(draft, payload.githubIssues, {
      repo: payload.repo || 'default/repo',
      project: payload.project,
      autoStart: payload.autoStart === true,
      now,
    })
    return { kind: 'github_poll_sync', ...synced }
  }

  // 5) IM 文本消息路由（飞书 event.message / 钉钉 text.content / 微信 cc2im / OneBot raw_message / 通用 text）
  const text = extractImText(payload)
  const externalThreadId = cleanStr(
    payload.externalThreadId
      || payload.event?.message?.thread_id
      || payload.event?.message?.chat_id
      || payload.conversationId
      || (payload.group_id ? `onebot:group:${payload.group_id}` : payload.user_id ? `onebot:user:${payload.user_id}` : ''),
    200,
  )
  const senderName = cleanStr(
    payload.senderName || payload.sender?.sender_nick || payload.sender?.nickname || payload.user?.name || 'IM 用户',
    60,
  )
  const provider = IM_PROVIDERS.includes(payload.provider) ? payload.provider : 'feishu'
  const actor = defaultActor('user', senderName)

  const trimmedNumMatch = text.trim().match(/^\/?([1-9])$/)
  if (trimmedNumMatch) {
    const idx = Number(trimmedNumMatch[1]) - 1
    const pendingCards = (draft.cards || []).filter(
      c => !c.archived && (c.approvals || []).some(a => a.status === 'pending'),
    )
    const threadPending = externalThreadId
      ? pendingCards.find(c => c.externalThreadId === externalThreadId)
      : null
    const targetCard = threadPending || (pendingCards.length === 1 ? pendingCards[0] : null)
    if (targetCard) {
      const pendingAp = (targetCard.approvals || []).find(a => a.status === 'pending')
      const chosenOpt = pendingAp?.options?.[idx]
      if (pendingAp && chosenOpt) {
        const resolved = resolveApproval(draft, targetCard.id, pendingAp.id, {
          optionId: chosenOpt.id,
          actor,
          now,
        })
        const primarySess = mainSessionId(resolved.card)
        if (primarySess || resolved.card.cwd || resolved.card.workspaceId) {
          enqueueOutbox(draft, {
            idempotencyKey: `im-approval:${resolved.card.id}:${pendingAp.id}`,
            cardId: resolved.card.id,
            expectedGeneration: resolved.card.runtime?.generation ?? 1,
            kind: 'approval',
            target: {
              ...(primarySess ? { sessionId: primarySess } : {}),
              ...(resolved.card.workspaceId ? { workspaceId: resolved.card.workspaceId } : {}),
              ...(resolved.card.cwd ? { cwd: resolved.card.cwd } : {}),
            },
            prompt: `【看板·审批已提交】卡片「${resolved.card.title}」（${resolved.card.id}）的确认请求「${resolved.approval.title}」已由用户拍板：${chosenOpt.label}。请继续推进后续任务。`,
            mode: 'queue',
            notBefore: now,
          }, { now })
        }
        const replyText = `已确认「${chosenOpt.label}」→ 卡片「${resolved.card.title}」（${resolved.card.id}）当前状态：${resolved.card.status}`
        return {
          kind: 'im_routed',
          decision: {
            route: 'approval_reply',
            reason: 'numeric_quick_approval',
            cardId: resolved.card.id,
            approvalId: pendingAp.id,
            optionId: chosenOpt.id,
          },
          card: resolved.card,
          approval: resolved.approval,
          replyText,
          reply: formatImNotification({
            template: 'light_text',
            card: resolved.card,
            text: replyText,
          }, { provider, format: 'text' }),
        }
      }
    } else if (pendingCards.length > 1) {
      const hints = pendingCards.slice(0, 5).map(c => {
        const ap = (c.approvals || []).find(a => a.status === 'pending')
        const firstOpt = ap?.options?.[0]?.id || 'yes'
        return `- ${c.title}：/approve ${c.id} ${firstOpt}`
      }).join('\n')
      const replyText = `当前有 ${pendingCards.length} 张待确认卡片，请指定卡片 ID 拍板：\n${hints}`
      return {
        kind: 'im_routed',
        decision: { route: 'approval_ambiguous', reason: 'multiple_pending_approvals' },
        card: null,
        replyText,
        reply: formatImNotification({ template: 'light_text', text: replyText }, { provider, format: 'text' }),
      }
    }
  }

  const decision = classifySuperAgentIntent(draft, {
    text,
    externalThreadId: externalThreadId || undefined,
    externalRef: payload.externalRef,
    cardId: payload.cardId,
    provider,
  }, { dataDir, rules })

  if (decision.route === 'approval_reply' && decision.cardId && decision.approvalId && decision.optionId) {
    const resolved = resolveApproval(draft, decision.cardId, decision.approvalId, {
      optionId: decision.optionId,
      comment: decision.comment,
      actor,
      now,
    })
    const primarySess = mainSessionId(resolved.card)
    if (primarySess || resolved.card.cwd || resolved.card.workspaceId) {
      enqueueOutbox(draft, {
        idempotencyKey: `im-approval:${resolved.card.id}:${decision.approvalId}`,
        cardId: resolved.card.id,
        expectedGeneration: resolved.card.runtime?.generation ?? 1,
        kind: 'approval',
        target: {
          ...(primarySess ? { sessionId: primarySess } : {}),
          ...(resolved.card.workspaceId ? { workspaceId: resolved.card.workspaceId } : {}),
          ...(resolved.card.cwd ? { cwd: resolved.card.cwd } : {}),
        },
        prompt: `【看板·审批已提交】卡片「${resolved.card.title}」（${resolved.card.id}）的确认请求「${resolved.approval.title}」已由用户拍板：${(resolved.approval.resolution?.labels || []).join('、') || decision.optionId}。请继续推进后续任务。`,
        mode: 'queue',
        notBefore: now,
      }, { now })
    }
    const replyText = `已为你确认卡片 ${resolved.card.id}（${resolved.card.title}），当前状态：${resolved.card.status}`
    return {
      kind: 'im_routed',
      decision,
      card: resolved.card,
      approval: resolved.approval,
      replyText,
      reply: formatImNotification({
        template: 'light_text',
        card: resolved.card,
        text: replyText,
      }, { provider, format: 'text' }),
    }
  }

  if (decision.route === 'board_query') {
    const activeCards = (draft.cards || []).filter(c => !c.archived)
    const cardById = new Map(activeCards.map(c => [c.id, c]))
    const counts = countsFor(draft)
    const STATUS_CN = {
      running: '进行中',
      needs_you: '待确认',
      blocked: '受阻',
      failed: '失败',
      backlog: '待办',
      done: '已完成',
    }
    const focusCards = activeCards
      .filter(c => c.status === 'running' || c.status === 'needs_you' || c.status === 'blocked' || c.status === 'failed')
      .slice(0, 8)
    const highlights = focusCards.map(c => {
      const pending = (c.approvals || []).find(a => a.status === 'pending')
      const unfinishedDeps = (c.dependsOn || [])
        .map(depId => cardById.get(depId))
        .filter(dep => dep && dep.status !== 'done')
      const wdState = c.runtime?.watchdog?.state
      const lastErr = c.runtime?.lastFailure?.message
      const waitReason = c.runtime?.waitCondition?.reason
      const blockers = []
      if (pending) blockers.push(`待你拍板「${cleanStr(pending.title, 80)}」`)
      if (lastErr) blockers.push(`报错：${cleanStr(lastErr, 90)}`)
      if (wdState === 'stalled') blockers.push('Watchdog 静默停滞熔断')
      else if (wdState === 'retry_exhausted') blockers.push('自动重试已达上限')
      if (waitReason) blockers.push(`挂起等待：${cleanStr(waitReason, 60)}`)
      if (unfinishedDeps.length) {
        blockers.push(`等待前置卡：${unfinishedDeps.map(d => `${d.title}(${d.id})`).join('、')}`)
      }
      if (c.status === 'blocked' && !blockers.length) blockers.push('执行受阻，待介入')

      const checklistTotal = Array.isArray(c.checklists) ? c.checklists.length : 0
      const checklistDone = checklistTotal ? c.checklists.filter(i => i?.done).length : 0
      const progressText = cleanStr(c.currentAction || c.summary || '', 140)
      const parts = [`[${STATUS_CN[c.status] || c.status}] ${c.title} (${c.id}${c.project ? ` · ${c.project}` : ''})`]
      if (progressText) parts.push(`  进展：${progressText}${checklistTotal ? `（清单 ${checklistDone}/${checklistTotal}）` : ''}`)
      else if (checklistTotal) parts.push(`  清单：${checklistDone}/${checklistTotal}`)
      parts.push(`  卡点：${blockers.length ? blockers.join('；') : '无硬性审批/报错卡点'}`)
      return parts.join('\n')
    })
    const replyText = [
      `📊 Super-Agent 看板简报`,
      `进行中 ${counts.running || 0} ｜ 待确认 ${counts.needs_you || 0} ｜ 待办 ${counts.backlog || 0} ｜ 已完成 ${counts.done || 0}`,
      ...(highlights.length ? ['活跃卡片进展与卡点：', ...highlights] : ['当前没有进行中或待确认的卡片。']),
    ].join('\n')
    return {
      kind: 'im_routed',
      decision,
      counts,
      replyText,
      reply: formatImNotification({
        template: 'daily_digest',
        counts,
        highlights,
      }, { provider, format: payload.format || 'card' }),
    }
  }

  if (decision.route === 'task_followup' && decision.cardId) {
    const { card, activity } = addComment(draft, decision.cardId, {
      text: `【外部线程追问】${text}`,
      actor,
      now,
    })
    ensureCardRuntime(card).priorityWake = 'person'
    const primarySess = mainSessionId(card)
    if (primarySess || card.cwd || card.workspaceId) {
      enqueueOutbox(draft, {
        idempotencyKey: `im-followup:${card.id}:${activity.id}`,
        cardId: card.id,
        expectedGeneration: card.runtime?.generation ?? 1,
        kind: 'wake',
        target: {
          ...(primarySess ? { sessionId: primarySess } : {}),
          ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
          ...(card.cwd ? { cwd: card.cwd } : {}),
        },
        prompt: `【看板·线程追问直通】卡片「${card.title}」（${card.id}）收到用户新消息：\n${text}`,
        mode: 'queue',
        notBefore: now,
      }, { now })
    }
    const replyText = `已直通追加到卡片「${card.title}」（${card.id}）并优先唤醒绑定的执行会话。`
    return {
      kind: 'im_routed',
      decision,
      card,
      replyText,
      reply: formatImNotification({
        template: 'light_text',
        card,
        text: replyText,
      }, { provider, format: 'text' }),
    }
  }

  if ((decision.route === 'task_dispatch' || decision.route === 'custom_skill') && payload.autoCreateCard !== false && decision.suggestedCard) {
    const superSess = getSuperAgentSessionId(draft)
    const suggested = decision.suggestedCard
    const shouldAutoStart = payload.autoStart !== undefined ? payload.autoStart !== false : suggested.autoStart !== false
    const { card } = createCard(draft, {
      title: suggested.title,
      summary: suggested.summary,
      status: 'backlog',
      autoStart: shouldAutoStart,
      project: payload.project || suggested.project || undefined,
      cwd: payload.cwd || suggested.cwd || undefined,
      workspaceId: payload.workspaceId || suggested.workspaceId || undefined,
      priority: payload.priority || suggested.priority || undefined,
      labels: payload.labels || suggested.labels || undefined,
      harness: payload.harness || suggested.harness || undefined,
      externalThreadId: externalThreadId || undefined,
      externalRef: payload.externalRef || undefined,
      sessionId: payload.sessionId || superSess || undefined,
      checklists: (suggested.checklists || []).map(item => ({ text: item, done: false })),
    }, {
      actor,
      now,
      allowUnboundCard: true,
    })
    // 用户从外部 IM 主动发来的任务享有人工抢占槽位（runtime.priorityWake: 'person'）
    ensureCardRuntime(card).priorityWake = 'person'
    const replyText = `已纳入看板待办「${card.title}」（${card.id}${card.project ? ` · ${card.project}` : ''}）${shouldAutoStart ? '，已开启自动接力' : ''}。`
    return {
      kind: 'im_routed',
      decision,
      card,
      replyText,
      reply: formatImNotification({
        template: 'light_text',
        card,
        text: replyText,
      }, { provider, format: 'text' }),
    }
  }

  const replyText = '收到！这条消息属于轻量问答/寒暄，未创建看板卡片；如需查看板可发「看板」，如需派发任务可直接描述需求。'
  return {
    kind: 'im_routed',
    decision,
    card: null,
    replyText,
    reply: formatImNotification({
      template: 'light_text',
      text: replyText,
    }, { provider, format: 'text' }),
  }
}

function extractImText(payload) {
  if (typeof payload.text === 'string') return payload.text
  if (payload.text && typeof payload.text.content === 'string') return payload.text.content
  if (typeof payload.raw_message === 'string') return payload.raw_message
  if (typeof payload.message === 'string') return payload.message
  const feishuContent = payload.event?.message?.content
  if (typeof feishuContent === 'string') {
    try {
      const parsed = JSON.parse(feishuContent)
      if (typeof parsed.text === 'string') return parsed.text
    } catch {
      return feishuContent
    }
  }
  return ''
}

function handleGithubIngress(draft, payload, { now, ghType }) {
  const issue = payload.issue || {}
  const repoFullName = payload.repository?.full_name || payload.repo || 'github/repo'
  const issueNumber = issue.number ?? payload.number
  if (!issueNumber) throw new DomainError('BAD_REQUEST', 'GitHub Issue 事件缺少 issue.number')
  const externalRef = `github:${repoFullName}#${issueNumber}`
  const action = payload.action || 'opened'
  const actorName = payload.sender?.login || issue.user?.login || 'github'
  const actor = defaultActor('user', `gh:${actorName}`)

  let existing = (draft.cards || []).find(c => !c.archived && c.externalRef === externalRef)

  if (ghType === 'issue_comment' && payload.comment) {
    if (!existing) {
      existing = createCard(draft, {
        title: `[#${issueNumber}] ${cleanStr(issue.title || 'GitHub Issue', 160)}`,
        summary: cleanStr(issue.body || '', 1500),
        status: 'backlog',
        autoStart: true,
        project: repoFullName.split('/').pop(),
        externalRef,
        labels: extractGithubLabels(issue.labels),
      }, { actor, now, allowUnboundCard: true }).card
    }
    const body = cleanStr(payload.comment.body || '', 1000)
    const { card, activity } = addComment(draft, existing.id, {
      text: `【GitHub 评论 @${actorName}】${body}`,
      actor,
      now,
    })
    const primarySess = mainSessionId(card)
    if (primarySess || card.cwd || card.workspaceId) {
      enqueueOutbox(draft, {
        idempotencyKey: `gh-comment:${externalRef}:${payload.comment.id || activity.id}`,
        cardId: card.id,
        expectedGeneration: card.runtime?.generation ?? 1,
        kind: 'wake',
        target: {
          ...(primarySess ? { sessionId: primarySess } : {}),
          ...(card.workspaceId ? { workspaceId: card.workspaceId } : {}),
          ...(card.cwd ? { cwd: card.cwd } : {}),
        },
        prompt: `【看板·GitHub Issue 评论更新】卡片「${card.title}」（${externalRef}）收到 @${actorName} 的新评论：\n${body}`,
        mode: 'queue',
        notBefore: now,
      }, { now })
    }
    return { kind: 'github_issue_comment', externalRef, card, created: false }
  }

  if (action === 'closed') {
    if (!existing) return { kind: 'github_issue_closed_ignored', externalRef, card: null }
    if (existing.status !== 'done' && existing.status !== 'canceled') {
      completeCard(draft, existing.id, {
        result: `GitHub Issue ${externalRef} 已由 @${actorName} 关闭`,
        actor,
        now,
        forceComplete: true,
      })
    }
    return { kind: 'github_issue_closed', externalRef, card: existing }
  }

  // opened / reopened / edited / labeled
  const labels = extractGithubLabels(issue.labels)
  const shouldAutoStart = payload.autoStart !== false
  if (!existing) {
    const { card } = createCard(draft, {
      title: `[#${issueNumber}] ${cleanStr(issue.title || 'GitHub Issue', 160)}`,
      summary: cleanStr(issue.body || '', 1500),
      status: 'backlog',
      autoStart: shouldAutoStart,
      project: payload.project || repoFullName.split('/').pop(),
      cwd: payload.cwd || undefined,
      workspaceId: payload.workspaceId || undefined,
      sessionId: payload.sessionId || getSuperAgentSessionId(draft) || undefined,
      externalRef,
      labels,
    }, { actor, now, allowUnboundCard: true })
    return { kind: 'github_issue_created', externalRef, card, created: true }
  }

  patchCard(draft, existing.id, {
    title: `[#${issueNumber}] ${cleanStr(issue.title || existing.title, 160)}`,
    summary: cleanStr(issue.body ?? existing.summary ?? '', 1500),
    labels,
    ...(action === 'reopened' && (existing.status === 'done' || existing.status === 'canceled') ? { status: 'backlog' } : {}),
  }, { actor, now })
  return { kind: 'github_issue_updated', externalRef, card: existing, created: false }
}

function extractGithubLabels(rawLabels) {
  const list = ['github-issue']
  if (Array.isArray(rawLabels)) {
    for (const item of rawLabels) {
      const name = typeof item === 'string' ? item : item?.name
      if (typeof name === 'string' && name.trim()) list.push(name.trim().slice(0, 32))
    }
  }
  return [...new Set(list)].slice(0, 10)
}

/**
 * 供「入口 5（定时任务 Cron / Poller）」间接实现「入口 1（GitHub 仓库 Issue）」的幂等同步器：
 * 定时任务执行 `gh issue list --repo owner/repo --state all --json number,title,body,state,labels` 后，
 * 将 JSON 数组传入本函数即可完成新建/更新/关闭对账，无需暴露本地公网 IP。
 */
export function syncGithubIssuesIntoDraft(draft, issues = [], {
  repo = 'github/repo',
  project,
  cwd,
  workspaceId,
  autoStart = true,
  now = Date.now(),
} = {}) {
  const created = []
  const updated = []
  const closed = []
  for (const item of Array.isArray(issues) ? issues : []) {
    if (!item || typeof item !== 'object' || !item.number) continue
    const state = String(item.state || 'open').toLowerCase()
    const res = handleGithubIngress(draft, {
      repo,
      project,
      cwd,
      workspaceId,
      autoStart,
      action: state === 'closed' ? 'closed' : 'opened',
      issue: {
        number: item.number,
        title: item.title,
        body: item.body,
        labels: item.labels,
        user: item.author || item.user,
      },
    }, { now, ghType: 'issues' })
    if (res.kind === 'github_issue_created' && res.card) created.push(res.card)
    else if (res.kind === 'github_issue_updated' && res.card) updated.push(res.card)
    else if (res.kind === 'github_issue_closed' && res.card) closed.push(res.card)
  }
  return { created, updated, closed }
}

function bumpCardToolCall(card, extra) {
  if (!card || typeof card !== 'object') return
  const metadata = { ...(card.metadata || { toolCalls: 0, searches: 0 }) }
  metadata.toolCalls = (metadata.toolCalls || 0) + 1
  if (extra && typeof extra === 'object') {
    for (const key of ['searches', 'elapsedMs', 'tokensIn', 'tokensOut']) {
      const value = Number(extra[key])
      if (Number.isFinite(value) && value > 0) metadata[key] = (metadata[key] || 0) + Math.round(value)
    }
  }
  card.metadata = metadata
}

/**
 * 回放云端 Worker `/v1/mcp` 入队的 `mcp_tool_call` 事件：
 * - 白名单校验：只允许 `CLOUD_MCP_WRITE_TOOLS` 的 8 个看板控制面写工具；
 * - 纵深防御：调用 `sanitizeCloudMcpWriteArgs` 二次剥离 `cwd` / `workspaceId` / `sessionId` 等本地执行面字段；
 * - 幂等保护：按 `mcpCallId`（以及建卡时的 `preferredCardId`）拦截重复回放，避免 ACK 超时重投造成重复写。
 */
function handleMcpToolIngress(draft, payload, { now = Date.now() } = {}) {
  const tool = cleanStr(payload.tool, 80)
  if (!CLOUD_MCP_WRITE_TOOLS.includes(tool)) {
    throw new DomainError('BAD_REQUEST', `不支持回放的云端 MCP 工具：${tool || '(空)'}`)
  }
  const mcpCallId = cleanStr(payload.mcpCallId, 160)
  if (mcpCallId && Array.isArray(draft.activities)) {
    const already = draft.activities.find(item => item?.data?.mcpCallId === mcpCallId)
    if (already) {
      const existingCard = already.cardId ? (draft.cards || []).find(c => c.id === already.cardId) : null
      return {
        kind: 'mcp_tool_call',
        tool,
        mcpCallId,
        duplicate: true,
        card: existingCard || null,
      }
    }
  }

  const rawArgs = payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : {}
  const { args } = sanitizeCloudMcpWriteArgs(tool, rawArgs)
  const rawActor = normalizeActor(payload.actor, 'agent')
  const mcpAgent = rawActor.kind === 'agent' || payload.harness
    ? resolveAgentAttribution({
        name: payload.actor?.name,
        id: payload.actor?.id,
        harness: payload.harness,
        url: payload.agentUrl,
      }, { defaultHarness: 'cloud-mcp' })
    : null
  const actor = mcpAgent && rawActor.kind === 'agent'
    ? { ...rawActor, name: mcpAgent.name }
    : rawActor
  const seenActivityIds = new Set((draft.activities || []).map(item => item.id))

  let primaryCard = null
  let summary = {}

  switch (tool) {
    case 'kanban_create_card': {
      const preferredId = cleanStr(payload.preferredCardId, 40)
      if (preferredId && isCardId(preferredId)) {
        const existing = (draft.cards || []).find(item => item.id === preferredId)
        if (existing) {
          return {
            kind: 'mcp_tool_call',
            tool,
            mcpCallId,
            duplicate: true,
            card: existing,
          }
        }
        const created = createCard(draft, args, { actor, now, preferredId })
        primaryCard = created.card
        summary = { cardId: created.card.id, reused: false }
        break
      }
      const convergent = findConvergentCardForCreate(draft, args, { now })
      if (convergent && convergent.kind === 'duplicate_open') {
        const target = convergent.card
        if (args.summary && !target.summary) target.summary = cleanText(args.summary, LIMITS.summary)
        if (args.status === 'running' && target.status === 'backlog') {
          changeStatus(draft, target, 'running', { actor, now, text: '同名卡片开始推进' })
        }
        pushActivity(draft, target, {
          type: 'progress',
          actor,
          text: `建卡收敛：自动复用同名未完成卡片「${target.title}」`,
          data: { converged: 'duplicate_open' },
          at: now,
        })
        touchCard(target, now)
        touchMeta(draft, actor, now)
        primaryCard = target
        summary = { cardId: target.id, reused: true }
      } else {
        const created = createCard(draft, args, { actor, now })
        primaryCard = created.card
        summary = { cardId: created.card.id, reused: false }
      }
      break
    }

    case 'kanban_update_card': {
      const { cardId, forceComplete, ...changes } = args
      const updated = patchCard(draft, cardId, changes, {
        actor,
        now,
        forceComplete: forceComplete === true && changes.status === 'done',
        strictChecklists: true,
      })
      primaryCard = updated.card
      summary = { cardId: updated.card.id }
      break
    }

    case 'kanban_move_card': {
      const moved = moveCard(draft, args.cardId, {
        column: args.column,
        status: args.status,
        text: args.text,
        actor,
        now,
        forceComplete: args.forceComplete === true,
        strictChecklists: true,
      })
      primaryCard = moved.card
      summary = { cardId: moved.card.id, status: moved.card.status }
      break
    }

    case 'kanban_add_activity': {
      const card = requireCard(draft, args.cardId)
      pushActivity(draft, card, {
        type: args.type || 'progress',
        actor,
        text: args.text,
        data: args.data,
        at: now,
      })
      touchCard(card, now)
      touchMeta(draft, actor, now)
      primaryCard = card
      bumpCardToolCall(card, args.metadata)
      summary = { cardId: card.id }
      break
    }

    case 'kanban_request_approval': {
      const requested = requestApproval(draft, args.cardId, args, { actor, now })
      primaryCard = requested.card
      summary = { cardId: requested.card.id, approvalId: requested.approval.id }
      break
    }

    case 'kanban_complete_card': {
      const completed = completeCard(draft, args.cardId, {
        result: args.result,
        actor,
        now,
        forceComplete: args.force === true,
        strictChecklists: true,
      })
      primaryCard = completed.card
      summary = { cardId: completed.card.id, status: completed.card.status }
      break
    }

    case 'kanban_merge_cards': {
      const merged = mergeCards(draft, args.sourceCardId, args.targetCardId, {
        actor,
        now,
        title: args.title,
      })
      primaryCard = merged.target
      summary = { sourceCardId: merged.source.id, targetCardId: merged.target.id }
      break
    }

    case 'kanban_archive_cards': {
      const output = args.restore === true
        ? restoreCards(draft, args.cardIds, { actor, now })
        : archiveCards(draft, args.cardIds, { actor, now, reason: args.reason })
      primaryCard = output.cards[0] || null
      summary = {
        ...(args.restore === true
          ? { restored: output.cards.map(c => c.id) }
          : { archived: output.cards.map(c => c.id) }),
        skipped: output.skipped,
      }
      break
    }
  }

  if (primaryCard && mcpAgent) {
    if (
      (tool === 'kanban_create_card' && rawArgs.agent === undefined) ||
      (tool === 'kanban_update_card' && rawArgs.agent === undefined) ||
      tool === 'kanban_move_card' ||
      tool === 'kanban_request_approval' ||
      tool === 'kanban_complete_card'
    ) {
      applyCardAgentAttribution(primaryCard, mcpAgent, { overwrite: true })
    } else if (tool === 'kanban_add_activity') {
      const actType = args.type || 'progress'
      applyCardAgentAttribution(primaryCard, mcpAgent, {
        overwrite: actType === 'progress' || actType === 'result',
      })
    }
  }

  if (primaryCard && tool !== 'kanban_add_activity') {
    bumpCardToolCall(primaryCard)
  }

  const newActivities = (draft.activities || []).filter(item => !seenActivityIds.has(item.id))
  if (newActivities.length > 0) {
    const targetAct = newActivities[0]
    targetAct.data = {
      ...(targetAct.data && typeof targetAct.data === 'object' ? targetAct.data : {}),
      ...(mcpCallId ? { mcpCallId } : {}),
      via: 'cloud-mcp',
    }
  } else if (primaryCard && !primaryCard.archived) {
    pushActivity(draft, primaryCard, {
      type: args.checklists !== undefined ? 'checklist' : 'progress',
      actor,
      text: '通过远程 MCP 更新了卡片',
      data: {
        ...(mcpCallId ? { mcpCallId } : {}),
        via: 'cloud-mcp',
      },
      at: now,
    })
  }

  return {
    kind: 'mcp_tool_call',
    tool,
    ...(mcpCallId ? { mcpCallId } : {}),
    card: primaryCard,
    ...summary,
  }
}

