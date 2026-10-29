// tools.js：v0.22.0 收敛能力——父子卡/依赖自动挂接与软提醒、完成拦截与强制完成、
// 收敛巡检、合并卡片、批量归档/恢复（含 dryRun）与详情里的子卡/依赖卡。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools, TOOL_NAMES } from '../lib/tools.js'
import { createSessionBinding } from '../lib/session-binding.js'
import { testStore } from './helpers.mjs'

const EXEC = { agent: { id: 'agent-test-1' } }
/** 带宿主 session 的 exec：当前会话 id=session-current、cwd=/repo/kanban。 */
const SESSION_EXEC = {
  agent: { id: 'agent-session-test', session: { id: 'session-current', header: { cwd: '/repo/kanban' } } },
}
const parse = text => JSON.parse(text)

/** 假 workspaceRegistry：resolveByPath 永远解析到 ws-1（离线单测）。 */
function createFakeRegistry(workspaces = [{ id: 'ws-1', path: '/repo/kanban' }]) {
  return {
    get: id => workspaces.find(workspace => workspace.id === id),
    resolveByPath(path) {
      const found = workspaces
        .filter(workspace => path === workspace.path || path.startsWith(workspace.path + '/'))
        .sort((left, right) => right.path.length - left.path.length)[0]
      if (!found) throw new Error('路径未注册')
      return found
    },
  }
}

async function setup(t) {
  const { store } = await testStore(t)
  const tools = createTools({ store })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { store, tools, byName }
}

/** 注入 sessionBinding（模拟 lib/index.js 的宿主接线，sessionController 不可用）。 */
async function setupBound(t) {
  const { store } = await testStore(t)
  const sessionBinding = createSessionBinding({
    getWorkspaceRegistry: () => createFakeRegistry(),
    getSessionController: () => null,
  })
  const tools = createTools({ store, sessionBinding })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { store, tools, byName }
}

/** 建卡（默认 backlog、绑定当前会话）。 */
async function createCardVia(byName, input = {}) {
  const created = parse(await byName.get('kanban_create_card').execute({ title: '工具测试卡', ...input }, SESSION_EXEC))
  assert.equal(created.ok, true, JSON.stringify(created))
  return created
}

test('L0 拆卡纪律写进工具描述：卡片=交付物、步骤用 checklist', async t => {
  const { tools } = await setup(t)
  assert.equal(TOOL_NAMES.length, 14)
  for (const name of ['kanban_create_card', 'kanban_complete_card', 'kanban_merge_cards', 'kanban_archive_cards', 'kanban_review_board']) {
    const tool = tools.find(item => item.name === name)
    assert.ok(tool, `缺少工具 ${name}`)
    assert.match(tool.description, /卡片=.*交付物/)
    assert.match(tool.description, /checklist|巡检|合并|归档/)
  }
  // 新参数 schema：创建支持 parentCardId/dependsOn，更新支持 forceComplete，工具支持 dryRun/restore
  const create = tools.find(tool => tool.name === 'kanban_create_card')
  assert.ok(create.parameters.properties.parentCardId.oneOf)
  assert.equal(create.parameters.properties.dependsOn.maxItems, 8)
  const update = tools.find(tool => tool.name === 'kanban_update_card')
  assert.ok(update.parameters.properties.forceComplete)
  assert.ok(update.parameters.properties.parentCardId)
  assert.ok(tools.find(tool => tool.name === 'kanban_move_card').parameters.properties.forceComplete)
  assert.ok(tools.find(tool => tool.name === 'kanban_complete_card').parameters.properties.force)
  assert.ok(tools.find(tool => tool.name === 'kanban_merge_cards').parameters.properties.dryRun)
  assert.ok(tools.find(tool => tool.name === 'kanban_archive_cards').parameters.properties.restore)
})

test('kanban_create_card：未传 parentCardId 且当前会话恰好 1 张进行中卡 → 自动挂父卡', async t => {
  const { byName } = await setupBound(t)
  const running = await createCardVia(byName, { title: '会话主卡', status: 'running' })
  assert.equal(running.parentCardId, null)
  assert.equal(running.binding.parentCardId, null)
  assert.match(running.hint, /如果这其实是某张卡的步骤，优先用 checklist\/多会话，不新建卡/)

  const child = await createCardVia(byName, { title: '自动挂到主卡' })
  assert.equal(child.parentCardId, running.card.id)
  assert.equal(child.binding.parentCardId, running.card.id)
  assert.equal(child.card.parentCardId, running.card.id)
  // 返回值与落库一致
  const detail = parse(await byName.get('kanban_card').execute({ cardId: child.card.id }, SESSION_EXEC))
  assert.equal(detail.card.parentCardId, running.card.id)
})

test('kanban_create_card：0 张不挂、多张不挂并写 warning；显式 parentCardId / null 优先', async t => {
  const { byName } = await setupBound(t)
  const first = await createCardVia(byName, { title: '第一张（0 张进行中时创建）' })
  assert.equal(first.parentCardId, null)
  assert.equal(first.warnings, undefined)

  const runningA = await createCardVia(byName, { title: '进行中 A', status: 'running' })
  const runningB = await createCardVia(byName, { title: '进行中 B', status: 'running' })
  assert.equal(runningB.parentCardId, runningA.card.id) // 创建时恰好 1 张进行中

  // 已有 2 张进行中：不自动挂，提示显式传 parentCardId
  const third = await createCardVia(byName, { title: '多进行中时不挂' })
  assert.equal(third.parentCardId, null)
  assert.ok(third.warnings.some(warning => /当前会话有 2 张进行中卡片，未能自动挂父卡，请显式传 parentCardId/.test(warning)))
  assert.match(third.hint, /如果这其实是某张卡的步骤/)

  // 显式 parentCardId 优先于自动判断，且不再追加拆卡提示
  const explicit = await createCardVia(byName, { title: '显式挂父卡', parentCardId: runningA.card.id })
  assert.equal(explicit.parentCardId, runningA.card.id)
  assert.doesNotMatch(explicit.hint, /如果这其实是某张卡的步骤/)

  // 显式 null = 显式不挂父卡（即使只有 1 张进行中也不挂）
  const noParent = await createCardVia(byName, { title: '显式不挂父卡', parentCardId: null })
  assert.equal(noParent.parentCardId, null)

  // 非法父卡 ID / 不存在的父卡 → 工具错误 JSON，不落库
  const bad = parse(await byName.get('kanban_create_card').execute({ title: '坏父卡', parentCardId: 'bad-id' }, SESSION_EXEC))
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'BAD_REQUEST')
  const missing = parse(await byName.get('kanban_create_card').execute({ title: '不存在父卡', parentCardId: 'card-ffffffff' }, SESSION_EXEC))
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'CARD_NOT_FOUND')
})

test('kanban_create_card 软提醒：当前会话进行中 ≥3、未收口 ≥8 时 warnings 建议收口', async t => {
  const { byName } = await setupBound(t)
  const warnings = []
  const runResults = []
  for (let index = 1; index <= 3; index += 1) {
    const created = await createCardVia(byName, { title: `进行中 ${index}`, status: 'running' })
    runResults.push(created)
    if (created.warnings) warnings.push(...created.warnings)
  }
  assert.ok(warnings.some(warning => /当前会话已有 3 张进行中卡片，建议先收口/.test(warning)))
  // 继续建待办卡直到未收口（待办+进行中）≥8
  for (let index = 1; index <= 6; index += 1) {
    const created = await createCardVia(byName, { title: `待办 ${index}` })
    if (created.warnings) warnings.push(...created.warnings)
  }
  assert.ok(warnings.some(warning => /当前会话已有 8 张未收口卡片（待办\+进行中），建议先收敛再开新卡/.test(warning)))
})

test('kanban_update_card：parentCardId/dependsOn 设置与清除；完成拦截与 forceComplete 强完成', async t => {
  const { byName } = await setup(t)
  const parent = parse(await byName.get('kanban_create_card').execute({ title: '父卡' }, EXEC))
  const child = parse(await byName.get('kanban_create_card').execute({ title: '子卡' }, EXEC))
  const dependency = parse(await byName.get('kanban_create_card').execute({ title: '前置依赖' }, EXEC))

  const linked = parse(await byName.get('kanban_update_card').execute({
    cardId: child.card.id, parentCardId: parent.card.id, dependsOn: [dependency.card.id],
  }, EXEC))
  assert.equal(linked.ok, true)
  assert.equal(linked.card.parentCardId, parent.card.id)
  assert.deepEqual(linked.card.dependsOn, [dependency.card.id])

  const cleared = parse(await byName.get('kanban_update_card').execute({
    cardId: child.card.id, parentCardId: null, dependsOn: [],
  }, EXEC))
  assert.equal(cleared.card.parentCardId, undefined)
  assert.deepEqual(cleared.card.dependsOn, [])

  // 让子卡重新挂到父卡下，制造完成拦截
  parse(await byName.get('kanban_update_card').execute({ cardId: child.card.id, parentCardId: parent.card.id }, EXEC))
  const blocked = parse(await byName.get('kanban_update_card').execute({ cardId: parent.card.id, status: 'done' }, EXEC))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'CARD_HAS_OPEN_CHILDREN')
  assert.deepEqual(blocked.error.extra.openChildren.map(item => item.id), [child.card.id])
  // forceComplete 仅 status=done 时生效
  const forced = parse(await byName.get('kanban_update_card').execute({
    cardId: parent.card.id, status: 'done', forceComplete: true,
  }, EXEC))
  assert.equal(forced.ok, true)
  assert.equal(forced.card.status, 'done')
  const detail = parse(await byName.get('kanban_card').execute({ cardId: parent.card.id }, EXEC))
  assert.ok(detail.activities.some(activity => /强制完成，留下 1 张未收口子卡/.test(activity.text)))

  // 非法关系值 → 错误 JSON
  const badRelation = parse(await byName.get('kanban_update_card').execute({ cardId: child.card.id, parentCardId: 'bad' }, EXEC))
  assert.equal(badRelation.ok, false)
  assert.equal(badRelation.error.code, 'BAD_REQUEST')
})

test('kanban_move_card：forceComplete 透传（无 force 403/409，有 force 强完成）', async t => {
  const { byName } = await setup(t)
  const parent = parse(await byName.get('kanban_create_card').execute({ title: '移动父卡' }, EXEC))
  const child = parse(await byName.get('kanban_create_card').execute({ title: '移动子卡' }, EXEC))
  parse(await byName.get('kanban_update_card').execute({ cardId: child.card.id, parentCardId: parent.card.id }, EXEC))
  const blocked = parse(await byName.get('kanban_move_card').execute({ cardId: parent.card.id, column: 'done' }, EXEC))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'CARD_HAS_OPEN_CHILDREN')
  const forced = parse(await byName.get('kanban_move_card').execute({ cardId: parent.card.id, column: 'done', forceComplete: true }, EXEC))
  assert.equal(forced.ok, true)
  assert.equal(forced.card.status, 'done')
})

test('kanban_complete_card：409 返回 error.extra.openChildren，force 强完成写审计', async t => {
  const { byName } = await setup(t)
  const parent = parse(await byName.get('kanban_create_card').execute({ title: '完成父卡' }, EXEC))
  const child = parse(await byName.get('kanban_create_card').execute({ title: '未收口子卡' }, EXEC))
  parse(await byName.get('kanban_update_card').execute({ cardId: child.card.id, parentCardId: parent.card.id }, EXEC))
  const blocked = parse(await byName.get('kanban_complete_card').execute({ cardId: parent.card.id, result: '完成' }, EXEC))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'CARD_HAS_OPEN_CHILDREN')
  assert.equal(blocked.error.extra.openChildren[0].id, child.card.id)
  assert.equal(blocked.error.extra.openChildren[0].title, '未收口子卡')
  const forced = parse(await byName.get('kanban_complete_card').execute({ cardId: parent.card.id, result: '强完成', force: true }, EXEC))
  assert.equal(forced.ok, true)
  assert.equal(forced.card.status, 'done')
  const detail = parse(await byName.get('kanban_card').execute({ cardId: parent.card.id }, EXEC))
  assert.ok(detail.activities.some(activity => activity.text === '强制完成，留下 1 张未收口子卡'))
})

test('kanban_card 详情返回 children 与 dependsOnCards（含状态/缺失标记）', async t => {
  const { store, byName } = await setup(t)
  const parent = parse(await byName.get('kanban_create_card').execute({ title: '详情父卡' }, EXEC))
  const doneChild = parse(await byName.get('kanban_create_card').execute({ title: '已收口子卡', parentCardId: parent.card.id, status: 'done' }, EXEC))
  const openChild = parse(await byName.get('kanban_create_card').execute({ title: '未收口子卡', parentCardId: parent.card.id }, EXEC))
  const dependency = parse(await byName.get('kanban_create_card').execute({ title: '依赖卡', status: 'running' }, EXEC))
  const dependent = parse(await byName.get('kanban_create_card').execute({ title: '依赖卡的下游', dependsOn: [dependency.card.id] }, EXEC))

  const parentDetail = parse(await byName.get('kanban_card').execute({ cardId: parent.card.id }, EXEC))
  assert.deepEqual(parentDetail.children.map(item => item.id).sort(), [doneChild.card.id, openChild.card.id].sort())
  assert.match(parentDetail.hint, /还有 1 张未收口子卡/)
  const dependentDetail = parse(await byName.get('kanban_card').execute({ cardId: dependent.card.id }, EXEC))
  assert.deepEqual(dependentDetail.dependsOnCards.map(item => item.id), [dependency.card.id])
  assert.equal(dependentDetail.dependsOnCards[0].status, 'running')

  // 模拟历史脏数据：dependsOn 指向不存在的卡 → 详情给 missing 标记而不是报错
  await store.update(draft => {
    const card = draft.cards.find(item => item.id === dependent.card.id)
    card.dependsOn = [...card.dependsOn, 'card-ffffffff']
  })
  const dirty = parse(await byName.get('kanban_card').execute({ cardId: dependent.card.id }, EXEC))
  assert.equal(dirty.dependsOnCards.length, 2)
  assert.equal(dirty.dependsOnCards[1].id, 'card-ffffffff')
  assert.equal(dirty.dependsOnCards[1].missing, true)
})

test('kanban_review_board：只读巡检，返回结构、筛选与 revision 不变', async t => {
  const { store, byName } = await setup(t)
  const stale = parse(await byName.get('kanban_create_card').execute({ title: '十天没动的待办' }, EXEC))
  await store.update(draft => {
    const card = draft.cards.find(item => item.id === stale.card.id)
    card.updatedAt = Date.now() - 10 * 86_400_000
  })
  const before = (await store.read()).meta.revision
  const report = parse(await byName.get('kanban_review_board').execute({ staleDays: 7 }, EXEC))
  assert.equal(report.ok, true)
  assert.equal((await store.read()).meta.revision, before, '巡检不得写数据')
  assert.equal(report.revision, before)
  for (const key of ['staleBacklog', 'doneNotArchived', 'duplicateCandidates', 'sessionWip', 'orphans', 'suggestions']) {
    assert.ok(report[key] !== undefined, `缺少 ${key}`)
  }
  assert.ok(report.staleBacklog.some(item => item.id === stale.card.id && item.ageDays >= 7))
  assert.ok(Array.isArray(report.suggestions) && report.suggestions.length >= 1)
  assert.equal(report.staleDays, 7)
  // 非法 boardId → 错误 JSON
  const badBoard = parse(await byName.get('kanban_review_board').execute({ boardId: 'board-ffffffff' }, EXEC))
  assert.equal(badBoard.ok, false)
  assert.equal(badBoard.error.code, 'BOARD_NOT_FOUND')
})

test('kanban_merge_cards：dryRun 只报告不写；真合并返回结构并可用 title 覆盖目标标题', async t => {
  const { store, byName } = await setup(t)
  const source = parse(await byName.get('kanban_create_card').execute({ title: '源卡', summary: '源摘要' }, EXEC))
  const target = parse(await byName.get('kanban_create_card').execute({ title: '目标卡', summary: '目标摘要' }, EXEC))
  const child = parse(await byName.get('kanban_create_card').execute({ title: '源卡的已收口子卡', parentCardId: source.card.id, status: 'done' }, EXEC))
  const dependent = parse(await byName.get('kanban_create_card').execute({ title: '依赖源卡的卡', dependsOn: [source.card.id] }, EXEC))
  const before = (await store.read()).meta.revision
  const dry = parse(await byName.get('kanban_merge_cards').execute({
    sourceCardId: source.card.id, targetCardId: target.card.id, title: '合并后的目标', dryRun: true,
  }, EXEC))
  assert.equal(dry.dryRun, true)
  assert.equal(dry.willMoveChildren, 1)
  assert.equal(dry.willRepointDependsOn, 1)
  assert.equal(dry.willAppendSummary, true)
  assert.ok(dry.warnings.some(warning => /标题将改为/.test(warning)))
  assert.equal((await store.read()).meta.revision, before, 'dryRun 不得写数据')
  assert.equal(parse(await byName.get('kanban_card').execute({ cardId: source.card.id }, EXEC)).card.archived, undefined)

  const merged = parse(await byName.get('kanban_merge_cards').execute({
    sourceCardId: source.card.id, targetCardId: target.card.id, title: '合并后的目标',
  }, EXEC))
  assert.equal(merged.ok, true)
  assert.equal(merged.source.archived, true)
  assert.equal(merged.source.mergedInto, target.card.id)
  assert.equal(merged.target.title, '合并后的目标')
  assert.match(merged.target.summary, /合并自卡片「源卡」/)
  assert.deepEqual(merged.movedChildren.map(item => item.id), [child.card.id])
  assert.deepEqual(merged.repointedDependsOn, [dependent.card.id])
  assert.match(merged.hint, /合并到「合并后的目标」并归档源卡/)
  // 源卡已归档：详情 404
  const missing = parse(await byName.get('kanban_card').execute({ cardId: source.card.id }, EXEC))
  assert.equal(missing.error.code, 'CARD_NOT_FOUND')
})

test('kanban_archive_cards：dryRun 报告、归档跳过未收口子卡、restore 恢复', async t => {
  const { store, byName } = await setup(t)
  const parent = parse(await byName.get('kanban_create_card').execute({ title: '有子卡的归档父卡' }, EXEC))
  const child = parse(await byName.get('kanban_create_card').execute({ title: '归档父卡的子卡', parentCardId: parent.card.id }, EXEC))
  const lone = parse(await byName.get('kanban_create_card').execute({ title: '可归档卡' }, EXEC))

  const before = (await store.read()).meta.revision
  const dry = parse(await byName.get('kanban_archive_cards').execute({ cardIds: [parent.card.id, lone.card.id], dryRun: true }, EXEC))
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.wouldArchive.map(item => item.id), [lone.card.id])
  assert.equal((await store.read()).meta.revision, before, 'dryRun 不得写数据')

  const archived = parse(await byName.get('kanban_archive_cards').execute({
    cardIds: [parent.card.id, lone.card.id, 'card-ffffffff'], reason: '清理已完成卡',
  }, EXEC))
  assert.deepEqual(archived.archived, [lone.card.id])
  assert.equal(archived.skipped.find(item => item.id === parent.card.id).reason, 'has_open_children')
  assert.equal(archived.skipped.find(item => item.id === 'card-ffffffff').reason, 'not_found')
  const state = parse(await byName.get('kanban_cards').execute({}, EXEC))
  assert.equal(state.cards.some(card => card.id === lone.card.id), false)

  // restore：清掉父卡关系后先归档父卡，再恢复
  parse(await byName.get('kanban_update_card').execute({ cardId: child.card.id, parentCardId: null }, EXEC))
  const archivedParent = parse(await byName.get('kanban_archive_cards').execute({ cardIds: [parent.card.id] }, EXEC))
  assert.deepEqual(archivedParent.archived, [parent.card.id])
  const restoreDry = parse(await byName.get('kanban_archive_cards').execute({ cardIds: [parent.card.id], restore: true, dryRun: true }, EXEC))
  assert.deepEqual(restoreDry.wouldRestore.map(item => item.id), [parent.card.id])
  const restored = parse(await byName.get('kanban_archive_cards').execute({ cardIds: [parent.card.id, lone.card.id, 'card-ffffffff'], restore: true }, EXEC))
  assert.deepEqual(restored.restored, [parent.card.id, lone.card.id])
  assert.deepEqual(restored.skipped.map(item => item.reason), ['not_found'])
  const after = parse(await byName.get('kanban_cards').execute({}, EXEC))
  assert.ok(after.cards.some(card => card.id === lone.card.id))
  assert.ok(after.cards.some(card => card.id === parent.card.id))
  // 已归档→恢复→再恢复：未归档进 skipped（工具级）
  const again = parse(await byName.get('kanban_archive_cards').execute({ cardIds: [parent.card.id], restore: true }, EXEC))
  assert.deepEqual(again.restored, [])
  assert.equal(again.skipped[0].reason, 'not_archived')
  // 恢复写 unarchived 时间线
  const detail = parse(await byName.get('kanban_card').execute({ cardId: parent.card.id }, EXEC))
  assert.ok(detail.activities.some(activity => activity.type === 'unarchived' && activity.text === '恢复了归档卡片'))
})
