#!/usr/bin/env node
// DSH Kanban 原生独立微信通道扫码登录工具（腾讯 iLink Bot 协议）：
// 用法：node bin/kanban-weixin-login.mjs [--data-dir ~/.dsh-kanban]
// 登录成功后凭证自动保存在 `<dataDir>/weixin/credentials.json`（0600），并自动启用 `im-config.json` 中的 `weixin` 通道。

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_WEIXIN_BASE_URL,
  fetchWeixinQrCode,
  pollWeixinQrStatus,
  saveWeixinCredentials,
} from '../lib/weixin-channel.js'
import { loadImConfig, saveImConfig } from '../lib/im-notifier.js'

function parseArgs(argv) {
  let dataDir = process.env.DSH_KANBAN_DATA_DIR || join(homedir(), '.dsh-kanban')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir' && argv[i + 1]) {
      dataDir = resolve(argv[i + 1])
      i += 1
    }
  }
  return { dataDir }
}

async function main() {
  const { dataDir } = parseArgs(process.argv.slice(2))
  console.log(`[dsh-kanban:weixin] 数据目录：${dataDir}`)
  console.log('[dsh-kanban:weixin] 正在向腾讯 iLink 服务申请微信机器人登录二维码…')

  let qr = await fetchWeixinQrCode({ baseUrl: DEFAULT_WEIXIN_BASE_URL })
  if (!qr.qrcodeUrl) {
    throw new Error('未能获取到有效的微信扫码链接')
  }

  console.log('\n============================================================')
  console.log('请使用手机微信打开下方链接或在浏览器打开并扫码确认：')
  console.log(qr.qrcodeUrl)
  console.log('============================================================\n')

  const deadline = Date.now() + 5 * 60_000
  let announcedScan = false
  let refreshes = 0

  while (Date.now() < deadline) {
    const res = await pollWeixinQrStatus(qr.qrcode, { baseUrl: DEFAULT_WEIXIN_BASE_URL })
    if (res.status === 'scaned' && !announcedScan) {
      announcedScan = true
      console.log('📱 已扫码，请在手机微信上点击「确认登录」…')
    } else if (res.status === 'confirmed' && res.botToken && res.accountId) {
      const saved = saveWeixinCredentials(dataDir, {
        token: res.botToken,
        baseUrl: res.baseUrl || DEFAULT_WEIXIN_BASE_URL,
        accountId: res.accountId,
        userId: res.userId || '',
      })
      const cfg = loadImConfig(dataDir)
      saveImConfig(dataDir, {
        ...cfg,
        weixin: {
          ...(cfg.weixin || {}),
          enabled: true,
          pollEnabled: true,
          ...(saved.userId ? { defaultUserId: saved.userId } : {}),
        },
      })
      console.log(`✅ 微信通道已成功连接！accountId=${saved.accountId} userId=${saved.userId || '(待首条消息激活)'}`)
      console.log('💡 现在请在微信向该机器人发送任意一条消息（如「看板」），即可激活双向实时通知与任务路由！')
      return
    } else if (res.status === 'expired') {
      refreshes += 1
      if (refreshes > 3) throw new Error('二维码多次过期，请重新运行登录命令')
      console.log('🔄 二维码已过期，正在刷新…')
      qr = await fetchWeixinQrCode({ baseUrl: DEFAULT_WEIXIN_BASE_URL })
      announcedScan = false
      console.log(`新扫码链接：${qr.qrcodeUrl}`)
    }
    await new Promise(r => setTimeout(r, 1200))
  }

  throw new Error('等待微信扫码超时（5 分钟）')
}

main().catch(err => {
  console.error(`❌ 微信扫码登录失败：${err?.message || err}`)
  process.exit(1)
})
