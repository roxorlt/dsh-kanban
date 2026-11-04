// domain.js：父子卡/依赖关系（v0.22.0）——字段规范化、环校验、完成拦截、状态回写、
// 依赖唤醒、合并、批量归档守卫、恢复归档、收敛巡检。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BOARD_ID, LIMITS, archiveCard, archiveCards, changeStatus, completeCard, createCard, createSeed,
  directChildren, mergeCards, moveCard, normalizeStore, openDirectChildren, patchCard, restoreCards,
  reviewBoard, unarchiveCard,
} from '../lib/domain.js'

const FIXED_NOW = 1_760_000_000_000
const ACTOR = { kind: 'agent', name: 'DSH Agent' }
const seedDraft = () => normalizeStore(createSeed('demo', FIXED_NOW), FIXED_NOW)
const makeCard = (draft, input = {}, now = FIXED_NOW) => createCard(draft, { title: '测试卡', ...input }, { now, actor: ACTOR }).card
const findById = (draft, id) => draft.cards.find(card => card.id === id)
const activitiesOf = (draft, cardId) => draft.activities.filter(activity => activity.cardId === cardId)
const errorCode = expected => error => error.code === expected

test('normalizeStore/normalizeCard：关系字段防御性校验（非法丢弃、去重、自引用、上限）', () => {
  const data = normalizeStore({
    boards: [{ id: DEFAULT_BOARD_ID, cardOrder: {} }],
    cards: [
      { id: 'card-aaaaaaaa', boardId: DEFAULT_BOARD_ID, title: '主卡' },
      {
        id: 'card-bbbbbbbb', boardId: DEFAULT_BOARD_ID, title: '关系卡',
        parentCardId: 'card-aaaaaaaa',
        dependsOn: ['card-aaaaaaaa', 'card-aaaaaaaa', 'bad-id', 'card-bbbbbbbb', 'card-cccccccc'],
        mergedInto: 'card-aaaaaaaa',
      },
      {
        id: 'card-cccccccc', boardId: DEFAULT_BOARD_ID, title: '非法关系卡',
        parentCardId: 'card-bbbbbbbb', dependsOn: 'nope', mergedInto: 'card-cccccccc',
      },
    ],
    activities: [],
    meta: {},
  }, FIXED_NOW)
  const relationCard = findById(data, 'card-bbbbbbbb')
  assert.equal(relationCard.parentCardId, 'card-aaaaaaaa')
  // 重复去掉、非法 ID 去掉、自引用去掉，其余保持合法引用（读取旧数据不校验存在性）
  assert.deepEqual(relationCard.dependsOn, ['card-aaaaaaaa', 'card-cccccccc'])
  assert.equal(relationCard.mergedInto, 'card-aaaaaaaa')
  assert.equal(data.cards.length, 3)
  const invalid = findById(data, 'card-cccccccc')
  assert.equal(invalid.parentCardId, 'card-bbbbbbbb')
  assert.deepEqual(invalid.dependsOn, [])
  assert.equal(invalid.mergedInto, undefined) // 指向自己被丢弃

  // dependsOn 读取时截断到 LIMITS.dependsOn
  const many = normalizeStore({
    boards: [{ id: DEFAULT_BOARD_ID, cardOrder: {} }],
    cards: [{
      id: 'card-dddddddd', boardId: DEFAULT_BOARD_ID, title: '多依赖',
      dependsOn: Array.from({ length: 12 }, (_, index) => 'card-' + String(index).padStart(8, '0')),
    }],
    activities: [],
    meta: {},
  }, FIXED_NOW)
  assert.equal(findById(many, 'card-dddddddd').dependsOn.length, LIMITS.dependsOn)
  // 老数据：没有关系字段时补空 dependsOn，不补 parentCardId
  const legacy = normalizeStore({
    boards: [{ id: DEFAULT_BOARD_ID, cardOrder: {} }],
    cards: [{ id: 'card-eeeeeeee', boardId: DEFAULT_BOARD_ID, title: '老卡' }],
    activities: [],
    meta: {},
  }, FIXED_NOW)
  assert.deepEqual(findById(legacy, 'card-eeeeeeee').dependsOn, [])
  assert.equal(findById(legacy, 'card-eeeeeeee').parentCardId, undefined)
})

test('createCard：parentCardId 目标必须存在且未归档', () => {
  const draft = seedDraft()
  assert.throws(() => makeCard(draft, { parentCardId: 'card-ffffffff' }), errorCode('CARD_NOT_FOUND'))
  const parent = makeCard(draft, { title: '会被归档的父卡' })
  archiveCard(draft, parent.id, { now: FIXED_NOW + 1 })
  assert.throws(() => makeCard(draft, { parentCardId: parent.id }), errorCode('CARD_NOT_FOUND'))
  assert.throws(() => makeCard(draft, { parentCardId: 'bad-id' }), errorCode('BAD_REQUEST'))
  // 通过 createCard 建的关系落库并可直接查询
  const live = makeCard(draft, { title: '正常父卡' })
  const child = makeCard(draft, { title: '正常子卡', parentCardId: live.id })
  assert.equal(child.parentCardId, live.id)
  assert.deepEqual(directChildren(draft, live.id).map(card => card.id), [child.id])
  assert.equal(openDirectChildren(draft, live.id).length, 1)
})

test('父卡链不能成环：自引用/子孙指回父卡为 CARD_RELATION_CYCLE，深度上限 64', () => {
  const draft = seedDraft()
  const parent = makeCard(draft, { title: '父' })
  const child = makeCard(draft, { title: '子', parentCardId: parent.id })
  // 把父卡挂到自己的子卡下 → 成环
  assert.throws(() => patchCard(draft, parent.id, { parentCardId: child.id }, { now: FIXED_NOW + 1 }),
    errorCode('CARD_RELATION_CYCLE'))
  // 自己挂自己 → 成环
  assert.throws(() => patchCard(draft, parent.id, { parentCardId: parent.id }, { now: FIXED_NOW + 1 }),
    errorCode('CARD_RELATION_CYCLE'))
  // 深度上限：64 层父链可以，65 层拒绝
  let cursor = makeCard(draft, { title: '深度 1' })
  for (let depth = 2; depth <= LIMITS.parentChainDepth + 1; depth += 1) {
    cursor = makeCard(draft, { title: `深度 ${depth}`, parentCardId: cursor.id })
  }
  assert.equal(cursor.parentCardId !== undefined, true)
  assert.throws(
    () => makeCard(draft, { title: '超深', parentCardId: cursor.id }),
    error => error.code === 'CARD_RELATION_CYCLE' && /父卡链超过/.test(error.message),
  )
})

test('dependsOn 校验：目标存在未归档、不自引用、依赖图不成环、格式与上限', () => {
  const draft = seedDraft()
  assert.throws(() => makeCard(draft, { dependsOn: ['card-ffffffff'] }), errorCode('CARD_NOT_FOUND'))
  const archived = makeCard(draft, { title: '归档依赖' })
  archiveCard(draft, archived.id, { now: FIXED_NOW + 1 })
  assert.throws(() => makeCard(draft, { dependsOn: [archived.id] }), errorCode('CARD_NOT_FOUND'))
  assert.throws(() => makeCard(draft, { dependsOn: 'card-aaaaaaaa' }), errorCode('BAD_REQUEST'))
  assert.throws(() => makeCard(draft, { dependsOn: [42] }), errorCode('BAD_REQUEST'))
  assert.throws(() => makeCard(draft, { dependsOn: Array.from({ length: LIMITS.dependsOn + 1 }, (_, index) => 'card-' + String(index).padStart(8, '0')) }),
    errorCode('BAD_REQUEST'))

  const first = makeCard(draft, { title: '依赖 A' })
  const second = makeCard(draft, { title: '依赖 B', dependsOn: [first.id] })
  // A 反过来依赖 B → 依赖图成环
  assert.throws(() => patchCard(draft, first.id, { dependsOn: [second.id] }, { now: FIXED_NOW + 2 }),
    errorCode('CARD_RELATION_CYCLE'))
  // 自己依赖自己 → 成环
  assert.throws(() => patchCard(draft, first.id, { dependsOn: [first.id] }, { now: FIXED_NOW + 2 }),
    errorCode('CARD_RELATION_CYCLE'))
  // 清空
  const cleared = patchCard(draft, second.id, { dependsOn: [] }, { now: FIXED_NOW + 3 })
  assert.deepEqual(cleared.card.dependsOn, [])
})

test('patchCard：parentCardId 设置与 null 清除；关系回显在卡片上', () => {
  const draft = seedDraft()
  const parent = makeCard(draft, { title: '父卡' })
  const child = makeCard(draft, { title: '子卡' })
  const changed = patchCard(draft, child.id, { parentCardId: parent.id }, { now: FIXED_NOW + 1 })
  assert.equal(changed.card.parentCardId, parent.id)
  const cleared = patchCard(draft, child.id, { parentCardId: null }, { now: FIXED_NOW + 2 })
  assert.equal(cleared.card.parentCardId, undefined)
  assert.throws(() => patchCard(draft, child.id, { parentCardId: 'bad' }, { now: FIXED_NOW + 3 }), errorCode('BAD_REQUEST'))
})

test('完成拦截：completeCard / patchCard / moveCard 遇到未收口子卡 409，forceComplete 强完成写审计', () => {
  const build = () => {
    const draft = seedDraft()
    const parent = makeCard(draft, { title: '父卡', status: 'running' })
    const child = makeCard(draft, { title: '未收口子卡', parentCardId: parent.id })
    return { draft, parent, child }
  }
  for (const [label, run] of [
    ['completeCard', ({ draft, parent }) => completeCard(draft, parent.id, { result: '完成', now: FIXED_NOW + 1, actor: ACTOR })],
    ['patchCard', ({ draft, parent }) => patchCard(draft, parent.id, { status: 'done' }, { now: FIXED_NOW + 1, actor: ACTOR })],
    ['moveCard', ({ draft, parent }) => moveCard(draft, parent.id, { column: 'done', now: FIXED_NOW + 1, actor: ACTOR })],
  ]) {
    const context = build()
    assert.throws(() => run(context), error => error.code === 'CARD_HAS_OPEN_CHILDREN' && error.status === 409, label)
    try { run(context) } catch (error) {
      assert.deepEqual(error.extra.openChildren.map(item => item.id), [context.child.id])
      assert.equal(error.extra.openChildren[0].title, '未收口子卡')
      assert.equal(error.extra.openChildren[0].status, 'backlog')
    }
    // 失败不落状态：卡片仍在进行中
    assert.equal(findById(context.draft, context.parent.id).status, 'running')
  }

  // 强完成：completeCard + forceComplete
  const forced = build()
  const completed = completeCard(forced.draft, forced.parent.id, { result: '强完成', now: FIXED_NOW + 2, actor: ACTOR, forceComplete: true })
  assert.equal(completed.card.status, 'done')
  const audit = completed.activities.find(activity => /强制完成，留下 1 张未收口子卡/.test(activity.text))
  assert.ok(audit, '强完成必须写审计节点')
  assert.equal(audit.data.forceComplete, true)
  assert.equal(audit.data.openChildren.length, 1)

  // 强完成：patchCard / moveCard 的 forceComplete 透传
  const patched = build()
  const patchResult = patchCard(patched.draft, patched.parent.id, { status: 'done' }, { now: FIXED_NOW + 3, actor: ACTOR, forceComplete: true })
  assert.equal(patchResult.card.status, 'done')
  assert.ok(patchResult.activities.some(activity => /强制完成，留下 1 张/.test(activity.text)))
  const moved = build()
  moveCard(moved.draft, moved.parent.id, { column: 'done', now: FIXED_NOW + 4, actor: ACTOR, forceComplete: true })
  assert.ok(activitiesOf(moved.draft, moved.parent.id).some(activity => /强制完成，留下 1 张/.test(activity.text)))

  // 子卡全部收口后正常完成，不需要 force，也不写审计节点
  const clean = build()
  completeCard(clean.draft, clean.child.id, { result: '子卡完成', now: FIXED_NOW + 5, actor: ACTOR })
  const normal = completeCard(clean.draft, clean.parent.id, { result: '父卡完成', now: FIXED_NOW + 6, actor: ACTOR })
  assert.equal(normal.card.status, 'done')
  assert.equal(activitiesOf(clean.draft, clean.parent.id).some(activity => /强制完成/.test(activity.text)), false)
})

test('子卡状态回写父卡：done/canceled/failed/needs_you 写父卡 progress，backlog 不写，父卡状态不变', () => {
  const draft = seedDraft()
  const parent = makeCard(draft, { title: '父卡', status: 'running' })
  const doneChild = makeCard(draft, { title: '完成子卡', parentCardId: parent.id })
  completeCard(draft, doneChild.id, { result: 'ok', now: FIXED_NOW + 1, actor: ACTOR })
  let writebacks = activitiesOf(draft, parent.id).filter(activity => activity.data?.childCardId === doneChild.id)
  assert.equal(writebacks.length, 1)
  assert.equal(writebacks[0].type, 'progress')
  assert.equal(writebacks[0].text, '子卡「完成子卡」进入「已完成」')
  assert.deepEqual(writebacks[0].data, { childCardId: doneChild.id, childStatus: 'done' })
  assert.equal(findById(draft, parent.id).status, 'running') // 不得改父卡状态

  const needsYouChild = makeCard(draft, { title: '待确认子卡', parentCardId: parent.id })
  changeStatus(draft, findById(draft, needsYouChild.id), 'needs_you', { now: FIXED_NOW + 2, actor: ACTOR })
  assert.equal(activitiesOf(draft, parent.id).some(activity => activity.data?.childCardId === needsYouChild.id
    && activity.text === '子卡「待确认子卡」进入「待你确认」'), true)

  const failedChild = makeCard(draft, { title: '失败子卡', parentCardId: parent.id })
  changeStatus(draft, findById(draft, failedChild.id), 'failed', { now: FIXED_NOW + 3, actor: ACTOR })
  assert.equal(activitiesOf(draft, parent.id).some(activity => activity.data?.childStatus === 'failed'), true)

  const canceledChild = makeCard(draft, { title: '取消子卡', parentCardId: parent.id })
  changeStatus(draft, findById(draft, canceledChild.id), 'canceled', { now: FIXED_NOW + 4, actor: ACTOR })
  assert.equal(activitiesOf(draft, parent.id).some(activity => activity.data?.childStatus === 'canceled'), true)

  // backlog 不回写父卡
  const before = activitiesOf(draft, parent.id).length
  changeStatus(draft, findById(draft, failedChild.id), 'backlog', { now: FIXED_NOW + 5, actor: ACTOR })
  assert.equal(activitiesOf(draft, parent.id).length, before)

  // 父卡已归档：不回写
  const archivedParent = makeCard(draft, { title: '归档父卡' })
  const orphan = makeCard(draft, { title: '归档父卡的子卡', parentCardId: archivedParent.id })
  archiveCard(draft, archivedParent.id, { now: FIXED_NOW + 6 })
  const archivedCount = activitiesOf(draft, archivedParent.id).length
  changeStatus(draft, findById(draft, orphan.id), 'done', { now: FIXED_NOW + 7, actor: ACTOR })
  assert.equal(activitiesOf(draft, archivedParent.id).length, archivedCount)
})

test('依赖唤醒：全部依赖收口才写就绪节点；blocked 自动回 backlog；未就绪不唤醒', () => {
  const draft = seedDraft()
  const depA = makeCard(draft, { title: '依赖 A' })
  const depB = makeCard(draft, { title: '依赖 B' })
  const waiting = makeCard(draft, { title: '等待卡', status: 'blocked', dependsOn: [depA.id, depB.id] })
  const plain = makeCard(draft, { title: '普通依赖卡', dependsOn: [depA.id, depB.id] })

  completeCard(draft, depA.id, { result: 'a', now: FIXED_NOW + 1, actor: ACTOR })
  // 只满足一半：不写就绪节点、blocked 保持
  assert.equal(activitiesOf(draft, waiting.id).some(activity => /依赖已就绪/.test(activity.text)), false)
  assert.equal(findById(draft, waiting.id).status, 'blocked')

  completeCard(draft, depB.id, { result: 'b', now: FIXED_NOW + 2, actor: ACTOR })
  const ready = activitiesOf(draft, waiting.id).filter(activity => activity.type === 'progress' && /依赖已就绪/.test(activity.text))
  assert.equal(ready.length, 1)
  assert.equal(ready[0].type, 'progress')
  assert.equal(ready[0].text, '依赖卡「依赖 B」已完成，依赖已就绪')
  assert.equal(ready[0].data.dependencyCardId, depB.id)
  const woke = findById(draft, waiting.id)
  assert.equal(woke.status, 'backlog') // blocked → backlog
  assert.ok(draft.boards[0].cardOrder.backlog.includes(waiting.id))
  assert.equal(activitiesOf(draft, waiting.id).some(activity => activity.text === '依赖已就绪，从「受阻」回到「待办」'), true)
  // 非 blocked 的卡只写就绪节点、状态不动
  assert.equal(findById(draft, plain.id).status, 'backlog')
  assert.equal(activitiesOf(draft, plain.id).filter(activity => /依赖已就绪/.test(activity.text)).length, 1)

  // 已归档的依赖卡若状态已收口，仍算就绪
  const archivedDep = makeCard(draft, { title: '归档依赖' })
  const late = makeCard(draft, { title: '晚到卡', status: 'blocked', dependsOn: [archivedDep.id] })
  archiveCard(draft, archivedDep.id, { now: FIXED_NOW + 3 })
  // 归档不改状态：归档一张 backlog 卡不算就绪
  assert.equal(activitiesOf(draft, late.id).filter(activity => /依赖已就绪/.test(activity.text)).length, 0)
})

test('mergeCards：dryRun 只报告不写；子卡改挂、依赖重指、会话并入、摘要追加、源卡归档', () => {
  const draft = seedDraft()
  const dependency = makeCard(draft, { title: '共同依赖' })
  const target = makeCard(draft, { title: '目标卡', summary: '目标摘要', sessionId: 'session-target' })
  const source = makeCard(draft, { title: '源卡', summary: '源摘要', sessionId: 'session-source' })
  const child = makeCard(draft, { title: '源子卡', status: 'done', parentCardId: source.id })
  const dependent = makeCard(draft, { title: '依赖源卡的卡', dependsOn: [source.id, dependency.id] })

  const snapshot = JSON.stringify(draft)
  const preview = mergeCards(draft, source.id, target.id, { title: '合并后的目标卡', dryRun: true })
  assert.equal(JSON.stringify(draft), snapshot, 'dryRun 不得写数据')
  assert.equal(preview.dryRun, true)
  assert.deepEqual(preview.source, { id: source.id, title: '源卡' })
  assert.deepEqual(preview.target, { id: target.id, title: '目标卡' })
  assert.equal(preview.willMoveChildren, 1)
  assert.equal(preview.willRepointDependsOn, 1)
  assert.equal(preview.willMoveSessions, 1)
  assert.equal(preview.willAppendSummary, true)
  assert.ok(preview.warnings.length >= 3)

  const merged = mergeCards(draft, source.id, target.id, { now: FIXED_NOW + 5, actor: ACTOR, title: '合并后的目标卡' })
  assert.equal(merged.source.archived, true)
  assert.equal(merged.source.mergedInto, target.id)
  assert.equal(findById(draft, source.id).archived, true)
  assert.deepEqual(merged.movedChildren.map(item => item.id), [child.id])
  assert.deepEqual(merged.repointedDependsOn, [dependent.id])
  // 目标卡：标题覆盖、摘要追加、会话源在前
  const mergedTarget = findById(draft, target.id)
  assert.equal(mergedTarget.title, '合并后的目标卡')
  assert.match(mergedTarget.summary, /目标摘要/)
  assert.match(mergedTarget.summary, /合并自卡片「源卡」：源摘要/)
  assert.deepEqual(mergedTarget.sessionIds, ['session-source', 'session-target'])
  // 子卡改挂目标、依赖重指目标且去重
  assert.equal(findById(draft, child.id).parentCardId, target.id)
  assert.deepEqual(findById(draft, dependent.id).dependsOn, [target.id, dependency.id])
  // 源卡归档审计节点（只有一条 archived，不重复）
  const archivedActivities = activitiesOf(draft, source.id).filter(activity => activity.type === 'archived')
  assert.equal(archivedActivities.length, 1)
  assert.match(archivedActivities[0].text, /合并到卡片「合并后的目标卡」并归档/)
  // target 时间线记录合并摘要/结果
  const mergeActivity = activitiesOf(draft, target.id).find(activity => activity.data?.mergedFrom === source.id)
  assert.ok(mergeActivity)
  assert.equal(mergeActivity.data.summary, '源摘要')
})

test('mergeCards：源卡有未收口子卡、自合并、跨看板都拒绝', () => {
  const draft = seedDraft()
  const source = makeCard(draft, { title: '源卡' })
  const target = makeCard(draft, { title: '目标卡' })
  makeCard(draft, { title: '未收口子卡', parentCardId: source.id })
  assert.throws(() => mergeCards(draft, source.id, target.id, { now: FIXED_NOW + 1 }),
    error => error.code === 'CARD_HAS_OPEN_CHILDREN' && error.extra.openChildren.length === 1)
  assert.throws(() => mergeCards(draft, source.id, source.id, { now: FIXED_NOW + 1 }), errorCode('BAD_REQUEST'))
  // 跨看板：第二块看板上的卡片不能合并
  draft.boards.push({ id: 'board-22222222', name: '第二看板', cardOrder: { backlog: [], running: [], needs_you: [], done: [] }, createdAt: FIXED_NOW, updatedAt: FIXED_NOW })
  const otherBoardCard = createCard(draft, { title: '另一个看板的卡', boardId: 'board-22222222' }, { now: FIXED_NOW, actor: ACTOR }).card
  assert.throws(() => mergeCards(draft, source.id, otherBoardCard.id, { now: FIXED_NOW + 2 }), errorCode('BAD_REQUEST'))
})

test('archiveCards：有未收口子卡的卡跳过并返回原因，其余归档；dryRun 只报告', () => {
  const draft = seedDraft()
  const parent = makeCard(draft, { title: '有子卡的父卡' })
  const child = makeCard(draft, { title: '未收口子卡', parentCardId: parent.id })
  const lone = makeCard(draft, { title: '可归档卡', status: 'done' })

  const dry = archiveCards(draft, [parent.id, lone.id], { dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.wouldArchive.map(item => item.id), [lone.id])
  assert.equal(findById(draft, lone.id).archived, undefined, 'dryRun 不得归档')

  const result = archiveCards(draft, [parent.id, lone.id, 'card-ffffffff'], { now: FIXED_NOW + 1, actor: ACTOR, reason: '批量清理' })
  assert.deepEqual(result.cards.map(card => card.id), [lone.id])
  assert.equal(result.skipped.find(item => item.id === parent.id).reason, 'has_open_children')
  assert.deepEqual(result.skipped.find(item => item.id === parent.id).openChildren.map(item => item.id), [child.id])
  assert.equal(result.skipped.find(item => item.id === 'card-ffffffff').reason, 'not_found')
  assert.equal(findById(draft, parent.id).archived, undefined)
  // 子卡先归档后父卡的未收口子卡不存在，批内按顺序可归档
  const ordered = archiveCards(draft, [child.id, parent.id], { now: FIXED_NOW + 2, actor: ACTOR })
  assert.deepEqual(ordered.cards.map(card => card.id), [child.id, parent.id])
})

test('unarchiveCard / restoreCards：恢复回原状态列尾、写 unarchived 节点、409/404、dryRun', () => {
  const draft = seedDraft()
  const card = makeCard(draft, { title: '待恢复卡', status: 'running' })
  archiveCard(draft, card.id, { now: FIXED_NOW + 1 })
  assert.equal(findById(draft, card.id).archived, true)
  // 归档后从 state/requireCard 视角不可见
  assert.equal(draft.boards[0].cardOrder.running.includes(card.id), false)

  const restored = unarchiveCard(draft, card.id, { now: FIXED_NOW + 2, actor: ACTOR })
  assert.equal(restored.card.archived, false)
  assert.equal(restored.card.archivedAt, undefined)
  assert.equal(restored.activity.type, 'unarchived')
  assert.equal(restored.activity.text, '恢复了归档卡片')
  assert.equal(draft.boards[0].cardOrder.running.at(-1), card.id) // 追加到原状态列尾
  assert.equal(findById(draft, card.id).status, 'running')

  assert.throws(() => unarchiveCard(draft, card.id, { now: FIXED_NOW + 3 }), errorCode('CONFLICT'))
  assert.throws(() => unarchiveCard(draft, 'card-ffffffff', { now: FIXED_NOW + 3 }), errorCode('CARD_NOT_FOUND'))

  // 批量恢复：已归档恢复、未归档/不存在进 skipped；dryRun 只报告
  const archivedAgain = makeCard(draft, { title: '再归档卡' })
  archiveCard(draft, archivedAgain.id, { now: FIXED_NOW + 4 })
  const dry = restoreCards(draft, [archivedAgain.id, card.id, 'card-ffffffff'], { dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.wouldRestore.map(item => item.id), [archivedAgain.id])
  assert.deepEqual(dry.skipped.map(item => item.reason).sort(), ['not_archived', 'not_found'])
  const restoredBatch = restoreCards(draft, [archivedAgain.id, card.id], { now: FIXED_NOW + 5, actor: ACTOR })
  assert.deepEqual(restoredBatch.cards.map(item => item.id), [archivedAgain.id])
  assert.equal(restoredBatch.skipped[0].reason, 'not_archived')
  assert.equal(activitiesOf(draft, card.id).filter(activity => activity.type === 'unarchived').length, 1)
})

test('reviewBoard：只读巡检产出陈旧待办/已完成未归档/重复候选/会话多开/孤儿与建议', () => {
  const draft = seedDraft()
  const longAgo = FIXED_NOW - 10 * 86_400_000
  createCard(draft, { title: '实现登录页面与入口跳转', status: 'backlog', cwd: '/repo/kanban' }, { now: longAgo, actor: ACTOR })
  createCard(draft, { title: '实现登录页面与入口跳转流程', status: 'backlog', cwd: '/repo/kanban' }, { now: longAgo, actor: ACTOR })
  createCard(draft, { title: '会话多开 A', status: 'running', sessionId: 'session-wip' }, { now: FIXED_NOW, actor: ACTOR })
  createCard(draft, { title: '会话多开 B', status: 'running', sessionId: 'session-wip' }, { now: FIXED_NOW, actor: ACTOR })
  const snapshot = JSON.stringify(draft)
  const report = reviewBoard(draft, { staleDays: 7, now: FIXED_NOW + 10 * 86_400_000 })
  assert.equal(JSON.stringify(draft), snapshot, 'reviewBoard 必须只读')

  assert.ok(report.staleBacklog.length >= 2)
  const stale = report.staleBacklog.find(item => item.title === '实现登录页面与入口跳转')
  assert.ok(stale.ageDays >= 7)
  assert.equal(stale.project, undefined)
  assert.equal(typeof report.staleBacklogTotal, 'number')
  assert.ok(report.doneNotArchived.count >= 1)
  assert.ok(Array.isArray(report.doneNotArchived.sample))
  const duplicate = report.duplicateCandidates.find(group => group.titles.includes('实现登录页面与入口跳转'))
  assert.ok(duplicate)
  assert.deepEqual(duplicate.cardIds.length, 2)
  assert.match(duplicate.reason, /同项目|同目录|标题高度相似/)
  const wip = report.sessionWip.find(item => item.sessionId === 'session-wip')
  assert.equal(wip.count, 2)
  assert.equal(wip.runningCards.length, 2)
  assert.ok(report.orphans.count >= 1)
  assert.ok(report.orphans.sample.every(item => item.id && item.title && item.status))
  assert.ok(report.suggestions.some(text => /归档/.test(text)))
  assert.ok(report.suggestions.some(text => /合并/.test(text)))
  assert.equal(report.boardId, DEFAULT_BOARD_ID)
  assert.equal(report.staleDays, 7)

  assert.throws(() => reviewBoard(draft, { boardId: 'board-ffffffff' }), errorCode('BOARD_NOT_FOUND'))
})

test('reviewBoard：staleDays 与 limit 边界（limit 截断样例、staleDays 决定陈旧范围）', () => {
  const draft = seedDraft()
  createCard(draft, { title: '陈旧 10 天', status: 'backlog' }, { now: FIXED_NOW - 10 * 86_400_000, actor: ACTOR })
  createCard(draft, { title: '陈旧 2 天', status: 'backlog' }, { now: FIXED_NOW - 2 * 86_400_000, actor: ACTOR })

  const strict = reviewBoard(draft, { staleDays: 7, limit: 1, now: FIXED_NOW })
  assert.equal(strict.staleBacklog.length, 1) // limit 截断样例
  assert.ok(strict.staleBacklogTotal >= 1)
  const loose = reviewBoard(draft, { staleDays: 1, limit: 100, now: FIXED_NOW })
  assert.ok(loose.staleBacklog.some(item => item.title === '陈旧 2 天'))
  // 未到期：staleDays 很大时没有陈旧待办
  const none = reviewBoard(draft, { staleDays: 365, now: FIXED_NOW })
  assert.equal(none.staleBacklog.length, 0)
})

test('自动推进增强：子卡收口自动汇总父卡进度与 parentReady；completeCard 返回 wokenDependents 且支持 autoStart', () => {
  const draft = seedDraft()
  const parent = makeCard(draft, { title: '总控父卡', status: 'running' })
  const childA = makeCard(draft, { title: '子卡 A', status: 'running', parentCardId: parent.id })
  const childB = makeCard(draft, { title: '子卡 B', status: 'running', parentCardId: parent.id })
  const autoDownstream = makeCard(draft, { title: '自动点火下游卡', status: 'blocked', dependsOn: [childB.id] })
  autoDownstream.autoStart = true

  const resA = completeCard(draft, childA.id, { result: 'A 完成', now: FIXED_NOW + 10, actor: ACTOR })
  assert.equal(resA.parentReady, null)
  assert.deepEqual(findById(draft, parent.id).progress, { step: 1, total: 2, percent: 50, text: '子卡进度 1/2' })

  const resB = completeCard(draft, childB.id, { result: 'B 完成', now: FIXED_NOW + 20, actor: ACTOR })
  assert.deepEqual(resB.parentReady, { id: parent.id, title: '总控父卡', status: 'running', totalChildren: 2, sessionIds: [] })
  assert.deepEqual(findById(draft, parent.id).progress, { step: 2, total: 2, percent: 100, text: '子卡进度 2/2' })
  assert.match(findById(draft, parent.id).currentAction, /全部 2 张子卡已收口/)
  assert.equal(resB.wokenDependents.length, 1)
  assert.equal(resB.wokenDependents[0].id, autoDownstream.id)
  assert.equal(resB.wokenDependents[0].status, 'running')
  assert.equal(findById(draft, autoDownstream.id).status, 'running')
})
