// index.js：插件导出契约与 apply 接线（fake ctx 验证路由/工具注册与卸载）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { TOOL_NAMES } from '../lib/tools.js'
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
  assert.equal(data.cards.length, 7)
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
