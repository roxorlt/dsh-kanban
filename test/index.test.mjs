// index.js：插件导出契约与 apply 接线（fake ctx 验证路由/工具注册与卸载）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { TOOL_NAMES } from '../lib/tools.js'
import { createStore } from '../lib/store.js'
import { createCard } from '../lib/domain.js'
import { tempDir } from './helpers.mjs'

function fakeContext() {
  const state = { routes: [], tools: [], effects: [], routeDisposers: 0, toolDisposers: 0 }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route) {
        if (state.routes.some(item => item.kind === route.kind && item.path === route.path)) throw new Error('重复路由')
        state.routes.push(route)
        return () => { state.routeDisposers += 1 }
      },
    },
    tools: {
      register(tool) {
        state.tools.push(tool)
        return () => { state.toolDisposers += 1 }
      },
    },
    effect(fn) { state.effects.push(fn()) },
  }
  return { ctx, state }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 80))

test('插件导出 name/inject/apply 契约', () => {
  assert.equal(name, 'dsh-kanban')
  assert.deepEqual(inject, ['webServer', 'tools'])
  assert.equal(typeof apply, 'function')
})

test('apply 注册两条前缀路由与 10 个工具，并种下 demo 数据', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, seed: 'demo' })
  assert.equal(state.routes.length, 2)
  assert.deepEqual(state.routes.map(route => [route.kind, route.path]), [['prefix', '/api/kanban'], ['prefix', '/dsh-kanban']])
  assert.ok(state.routes.every(route => typeof route.handler === 'function'))
  assert.deepEqual(state.tools.map(tool => tool.name), TOOL_NAMES)
  await flush()
  const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.cards.length, 8)
  // 清理：按注册顺序执行 disposer，不应抛错
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') await dispose()
  assert.equal(state.routeDisposers, 2)
  assert.equal(state.toolDisposers, 10)
})

test('apply 支持 seed=empty 与自定义 dataDir', async t => {
  const dir = await tempDir(t)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: join(dir, 'custom'), seed: 'empty' })
  await flush()
  const data = JSON.parse(await readFile(join(dir, 'custom', 'data.json'), 'utf8'))
  assert.equal(data.cards.length, 0)
  assert.equal(data.boards[0].id, 'board-default')
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') await dispose()
})

async function waitForFile(predicate, { timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function closeEffects(state) {
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') await dispose()
}

/** 预先写一份 data.json：很旧的 done/canceled 卡片 + 旧 completedAt 的 running 卡片。 */
async function seedOldCompletedCards(dir) {
  const store = createStore({ dataDir: dir, forceNew: true })
  await store.ready()
  const old = Date.now() - 40 * 86_400_000
  let doneId, canceledId, runningId
  await store.update(draft => {
    const done = createCard(draft, { title: '旧 done 卡', status: 'done' }, { now: old }).card
    done.completedAt = old
    doneId = done.id
    const canceled = createCard(draft, { title: '旧 canceled 卡', status: 'canceled' }, { now: old }).card
    canceled.completedAt = old
    canceledId = canceled.id
    const running = createCard(draft, { title: '旧 running 卡', status: 'running' }, { now: old }).card
    running.completedAt = old
    runningId = running.id
    return null
  })
  await store.close()
  return { doneId, canceledId, runningId }
}

test('apply autoArchiveDays：启动后立即归档超期 done/canceled，running 不归档，定时器随 effect 清理', async t => {
  const dir = await tempDir(t)
  const { doneId, canceledId, runningId } = await seedOldCompletedCards(dir)
  const { ctx, state } = fakeContext()
  apply(ctx, { dataDir: dir, autoArchiveDays: 1 })
  await waitForFile(async () => {
    try {
      const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
      return data.cards.find(card => card.id === doneId)?.archived === true
    } catch { return false }
  })
  const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  const done = data.cards.find(card => card.id === doneId)
  const canceled = data.cards.find(card => card.id === canceledId)
  const running = data.cards.find(card => card.id === runningId)
  assert.equal(done.archived, true)
  assert.ok(done.archivedAt > 0)
  assert.equal(canceled.archived, true)
  assert.equal(running.archived, undefined)
  const event = data.activities.find(item => item.cardId === doneId && item.type === 'archived')
  assert.match(event.text, /自动归档：已完成超过 1 天/)
  assert.equal(event.actor.kind, 'system')
  await closeEffects(state)
})

test('apply autoArchiveDays=0 关闭自动归档；默认 30 天归档 40 天前完成的卡', async t => {
  // 0 = 关闭
  const offDir = await tempDir(t)
  const off = await seedOldCompletedCards(offDir)
  const offContext = fakeContext()
  apply(offContext.ctx, { dataDir: offDir, autoArchiveDays: 0 })
  await new Promise(resolve => setTimeout(resolve, 120))
  const offData = JSON.parse(await readFile(join(offDir, 'data.json'), 'utf8'))
  assert.equal(offData.cards.find(card => card.id === off.doneId).archived, undefined)
  await closeEffects(offContext.state)

  // 默认 30 天：40 天前的 done 会被归档
  const defaultDir = await tempDir(t)
  const seeded = await seedOldCompletedCards(defaultDir)
  const defaultContext = fakeContext()
  apply(defaultContext.ctx, { dataDir: defaultDir })
  await waitForFile(async () => {
    try {
      const data = JSON.parse(await readFile(join(defaultDir, 'data.json'), 'utf8'))
      return data.cards.find(card => card.id === seeded.doneId)?.archived === true
    } catch { return false }
  })
  const defaultData = JSON.parse(await readFile(join(defaultDir, 'data.json'), 'utf8'))
  assert.equal(defaultData.cards.find(card => card.id === seeded.doneId).archived, true)
  assert.match(
    defaultData.activities.find(item => item.cardId === seeded.doneId && item.type === 'archived').text,
    /自动归档：已完成超过 30 天/,
  )
  await closeEffects(defaultContext.state)
})
