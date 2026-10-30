// workspace-backfill.js（v0.22.1）：启动时把「有 cwd、缺 workspaceId」的未归档卡片按注册表补齐。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceBackfill } from '../lib/workspace-backfill.js'
import { createCard } from '../lib/domain.js'
import { testStore } from './helpers.mjs'

async function seedCards(store) {
  const ids = {}
  await store.update(draft => {
    ids.a = createCard(draft, { title: '回填 A', cwd: '/repo/one' }).card.id
    ids.b = createCard(draft, { title: '回填 B', cwd: '/repo/two' }).card.id
    ids.unknown = createCard(draft, { title: '回填 未知目录', cwd: '/repo/unknown' }).card.id
    ids.existing = createCard(draft, { title: '回填 已有工作区', cwd: '/repo/one', workspaceId: 'ws-existing' }).card.id
    ids.noCwd = createCard(draft, { title: '回填 无目录' }).card.id
    ids.archived = createCard(draft, { title: '回填 已归档', cwd: '/repo/one' }).card.id
  })
  await store.update(draft => {
    const card = draft.cards.find(item => item.id === ids.archived)
    card.archived = true
    card.archivedAt = Date.now()
  })
  return ids
}

function fakeRegistry() {
  return {
    async resolveByPath(path) {
      if (path === '/repo/one') return { id: 'ws-1', path: '/repo/one' }
      if (path === '/repo/two') return { id: 'ws-2', path: '/repo/two' }
      throw new Error('路径未注册')
    },
  }
}

test('启动回填：只补有 cwd 缺 workspaceId 的未归档卡，不覆盖已有值/不碰归档与无目录卡', async t => {
  const { store } = await testStore(t)
  const ids = await seedCards(store)
  const backfill = createWorkspaceBackfill({ store, getRegistry: () => fakeRegistry() })
  assert.deepEqual(await backfill.runOnce(), { updated: 2 })
  const data = await store.read()
  const byId = new Map(data.cards.map(card => [card.id, card]))
  assert.equal(byId.get(ids.a).workspaceId, 'ws-1')
  assert.equal(byId.get(ids.b).workspaceId, 'ws-2')
  assert.equal(byId.get(ids.unknown).workspaceId, undefined)
  assert.equal(byId.get(ids.existing).workspaceId, 'ws-existing')
  assert.equal(byId.get(ids.noCwd).workspaceId, undefined)
  assert.equal(byId.get(ids.archived).workspaceId, undefined)
  // 幂等：成功后不再跑
  assert.deepEqual(await backfill.runOnce(), { updated: 0, skipped: 'already-run' })
})

test('注册表未注入时返回 skipped，注入后可重试成功', async t => {
  const { store } = await testStore(t)
  await store.update(draft => { createCard(draft, { title: '可重试', cwd: '/repo/one' }) })
  let registry = null
  const backfill = createWorkspaceBackfill({ store, getRegistry: () => registry })
  assert.deepEqual(await backfill.runOnce(), { updated: 0, skipped: 'registry-unavailable' })
  registry = fakeRegistry()
  assert.deepEqual(await backfill.runOnce(), { updated: 1 })
})

test('并发调用共享同一次回填（不会重复写）', async t => {
  const { store } = await testStore(t)
  await store.update(draft => { createCard(draft, { title: '并发', cwd: '/repo/one' }) })
  const backfill = createWorkspaceBackfill({ store, getRegistry: () => fakeRegistry() })
  const [first, second] = await Promise.all([backfill.runOnce(), backfill.runOnce()])
  assert.equal(first.updated, 1)
  assert.equal(second.updated, 1)
  const data = await store.read()
  assert.equal(data.cards.filter(card => card.title === '并发' && card.workspaceId === 'ws-1').length, 1)
})

test('注册表抛错时只跳过该卡，不中断其它卡回填', async t => {
  const { store } = await testStore(t)
  const ids = await seedCards(store)
  const backfill = createWorkspaceBackfill({ store, getRegistry: () => fakeRegistry() })
  const result = await backfill.runOnce()
  assert.equal(result.updated, 2)
  const data = await store.read()
  assert.equal(data.cards.find(card => card.id === ids.unknown).workspaceId, undefined)
})
