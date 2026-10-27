#!/usr/bin/env node
// 造一个「有分叉、有远端、有 linked worktree」的演示仓库，供 v0.13「分支 / 工作树」可视化手工复跑。
//
// 用法：node scripts/demo-git-repo.mjs [--root /tmp/dsh-kanban-git-demo]
// 产物（默认 /tmp/dsh-kanban-git-demo）：
//   origin.git                                  裸远端
//   repo                                       主工作树：main 与 origin/main 各分叉 1 个提交
//   repo/.worktrees/feat-graph                 linked worktree：feat/graph 领先 main 3、落后 1、本地 1 提交未推
//   repo/.worktrees/feat-long                  linked worktree：feat/long 领先 main 15（验证 12 行截断仍可见分叉点）
//   plain-dir                                  非 git 目录
//
// 然后：
//   node scripts/dev-server.mjs --port 4609 --data /tmp/dsh-kanban-git-demo/data/data.json --seed empty --reset
//   curl -s -X POST http://127.0.0.1:4609/api/kanban/cards -H 'content-type: application/json' \
//     -d '{"boardId":"board-default","title":"分支演示","status":"running","cwd":"/tmp/dsh-kanban-git-demo/repo/.worktrees/feat-graph"}'
//   打开 http://127.0.0.1:4609/dsh-kanban/ 双击卡片，即可看到「分支 / 工作树」区块。
//
// 注意：每次运行会重建整个 root 目录；root 不要指向仓库或其它有用数据。
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const ROOT = resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : '/tmp/dsh-kanban-git-demo')
// 防呆：不允许指向仓库自身（脚本所在仓库）或家目录
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (ROOT === repoRoot || ROOT === '/' || ROOT === process.env.HOME) {
  console.error(`拒绝把演示仓库建到 ${ROOT}，请用默认 /tmp 路径或显式 --root`)
  process.exit(1)
}

const ORIGIN = join(ROOT, 'origin.git')
const REPO = join(ROOT, 'repo')
const OTHER = join(ROOT, 'other')
const PLAIN = join(ROOT, 'plain-dir')
const GRAPH_WORKTREE = join(REPO, '.worktrees', 'feat-graph')
const LONG_WORKTREE = join(REPO, '.worktrees', 'feat-long')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  LANG: 'C',
}

function git(cwd, ...commandArgs) {
  return execFileSync('git', commandArgs, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

// 每提交递增 5 分钟：泳道图按时间交错时顺序可读（同秒提交会让排序全平）
let commitClock = 0
function commit(cwd, message, file, content) {
  writeFileSync(join(cwd, file), `${content}\n`, 'utf8')
  git(cwd, 'add', file)
  const stamp = new Date(Date.UTC(2026, 9, 20, 2, 0, 0) + commitClock * 5 * 60_000).toISOString()
  commitClock += 1
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd,
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    encoding: 'utf8',
  })
}

await rm(ROOT, { recursive: true, force: true })
await mkdir(ROOT, { recursive: true })
await mkdir(PLAIN, { recursive: true })
writeFileSync(join(PLAIN, 'readme.txt'), 'not a git repo\n', 'utf8')

// 1) 裸远端 + 主克隆
git(ROOT, 'init', '--bare', '-q', '-b', 'main', ORIGIN)
git(ROOT, 'clone', '-q', ORIGIN, REPO)
git(REPO, 'config', 'user.name', 'Demo')
git(REPO, 'config', 'user.email', 'demo@example.com')
git(REPO, 'checkout', '-q', '-b', 'main')

// 2) main 两个已推送提交
commit(REPO, 'initial: project skeleton', 'README.md', '# demo repo')
git(REPO, 'push', '-q', '-u', 'origin', 'main')
commit(REPO, 'feat: add core module', 'core.js', 'export const core = 1;')
git(REPO, 'push', '-q')

// 3) feat/graph：从 core 分出，两个已推送提交
git(REPO, 'checkout', '-q', '-b', 'feat/graph')
commit(REPO, 'feat(graph): lane layout', 'graph.js', 'export const lane = 1;')
commit(REPO, 'feat(graph): fork connectors', 'graph.js', 'export const lane = 2;')
git(REPO, 'push', '-q', '-u', 'origin', 'feat/graph')

// 4) main 本地未推送提交
git(REPO, 'checkout', '-q', 'main')
commit(REPO, 'chore: local unpushed work', 'local.txt', 'local changes')

// 5) 另一个克隆往 origin/main 推一个上游提交（本地 main 落后 origin/main 1）
git(ROOT, 'clone', '-q', ORIGIN, OTHER)
git(OTHER, 'config', 'user.name', 'Demo')
git(OTHER, 'config', 'user.email', 'demo@example.com')
git(OTHER, 'checkout', '-q', 'main')
commit(OTHER, 'fix: upstream hotfix', 'hotfix.txt', 'hotfix')
git(OTHER, 'push', '-q', 'origin', 'main')
git(REPO, 'fetch', '-q', 'origin')

// 6) feat/graph 的 linked worktree + 1 个未推送提交
git(REPO, 'worktree', 'add', '-q', GRAPH_WORKTREE, 'feat/graph')
commit(GRAPH_WORKTREE, 'feat(graph): polish edge cases', 'graph.js', 'export const lane = 3;')

// 7) feat/long 的 linked worktree：领先 main 15 个提交（12 行截断场景）
git(REPO, 'worktree', 'add', '-q', '-b', 'feat/long', LONG_WORKTREE, 'main')
for (let index = 1; index <= 15; index += 1) {
  commit(LONG_WORKTREE, `feat(long): iterative change ${String(index).padStart(2, '0')}`, 'long.js', `export const step = ${index};`)
}

// 8) 一个已合并的旧分支（只出现在分支列表里，不建工作树）
git(REPO, 'checkout', '-q', '-b', 'chore/merged', 'main~1')
commit(REPO, 'chore: merged cleanup', 'cleanup.txt', 'cleanup')
git(REPO, 'checkout', '-q', 'main')

console.log(JSON.stringify({
  root: ROOT,
  repo: REPO,
  worktrees: [REPO, GRAPH_WORKTREE, LONG_WORKTREE],
  plain: PLAIN,
  mainVsOrigin: git(REPO, 'rev-list', '--left-right', '--count', 'origin/main...main'),
  graphVsUpstream: git(GRAPH_WORKTREE, 'rev-list', '--left-right', '--count', 'origin/feat/graph...HEAD'),
  graphVsMain: git(GRAPH_WORKTREE, 'rev-list', '--left-right', '--count', 'main...HEAD'),
  longVsMain: git(LONG_WORKTREE, 'rev-list', '--left-right', '--count', 'main...HEAD'),
  mergeBase: git(GRAPH_WORKTREE, 'merge-base', 'main', 'HEAD').slice(0, 7),
}, null, 2))
