# 卡片 Git 上下文契约 v0.6（v0.13~v0.16 见下；v0.17 工作副本清理判定与软删除，2026-10-28）

> 目标：卡片详情抽屉能直观看到「这张卡片的工作目录落在哪个分支 / 哪个工作树（worktree）上，与主分支、远端是什么关系」，
> 呈现方式参照 Fork 等 Git 客户端的泳道提交图。
> 数据是**只读派生信息**，不写入 `data.json`，不改卡片字段。

## 1. 边界

| 项 | 决定 |
| --- | --- |
| 数据来源 | 服务端对卡片 `cwd`（可选：绑定的主会话执行目录）执行只读 `git` 命令 |
| 触发方式 | 打开卡片详情抽屉时按需请求；前端短 TTL 缓存，抽屉关闭即丢弃展示状态 |
| 写入 | 无。不写仓库、不写看板数据、不动 git 索引（设置 `GIT_OPTIONAL_LOCKS=0`） |
| 卡片无 `cwd` / 目录不存在 / 非 git 仓库 | HTTP 200 + `available:false`，前端静默隐藏该区块（不报错、不占位） |
| 旧服务端（未升级） | 路由 404，前端按 `available:false` 同样隐藏 |
| 命令超时 | 单条 git 命令 2s，整次采集 4s；超时/失败 → `available:false` + `reason`，不影响看板其它功能 |

### 1.1 目录选择规则（`?cwd=` 候选）

前端可以在 `?cwd=` 里传「卡片主会话当前的执行目录」，用于 DSH 宿主用 worktree 执行任务的场景（卡片 `cwd` 仍是主仓库，
而主会话已经被切到 `.agents/worktrees/xxx`）。

服务端按以下顺序选实际采集目录：

1. `card.cwd` 必然作为基准；`?cwd=` 只是候选。
2. 候选必须满足全部条件才被采用：
   - `realpath` 存在且是目录；
   - 能从候选目录解析出 git 仓库，且 `git-common-dir` 的 realpath 与 `card.cwd` 解析出的相同（同一仓库）；
   - 候选目录所在工作树是 **linked worktree**（非主工作树），而 `card.cwd` 所在工作树是主工作树。
3. 其余情况一律用 `card.cwd`（候选非法/跨仓库/跨工作树方向不对都静默忽略）。
4. `card.cwd` 缺失时直接 `available:false, reason:"no_cwd"`，不接受候选（避免看板接口沦为任意目录探测器）。

## 2. 接口

```
GET /api/kanban/cards/:cardId/git[?cwd=<绝对路径>]
```

- `cardId` 不存在 → `404 { ok:false, error:{ code:'CARD_NOT_FOUND', message } }`
- 方法非 `GET/HEAD` → `405`
- 其它情况一律 `200`，业务失败信息放在 `git.available` / `git.reason` 里，**不返回 5xx**
- 响应头沿用看板通用 JSON 头（`no-store`）

## 3. 响应结构

```jsonc
{
  "ok": true,
  "revision": 332,                 // 看板全局 revision（与其它接口一致）
  "git": {
    "available": true,
    "reason": null,                // available:false 时为下方枚举之一
    "message": null,               // 可选，调试用人类可读原因（不进正式 UI 文案）
    "dir": "/Users/roxor/Desktop/dsh/dsh kanban",       // 实际采集目录（realpath）
    "requestedDir": "/Users/.../.agents/worktrees/feat/x", // 传入的 ?cwd=（未传则 null；未采用时也返回原值）
    "repo": {
      "name": "dsh kanban",                              // 主工作树目录名
      "root": "/Users/roxor/Desktop/dsh/dsh kanban",     // 主工作树根（worktree list 里 isMain 的那项）
      "commonDir": "/Users/roxor/Desktop/dsh/dsh kanban/.git"
    },
    "current": {
      "worktree": "/Users/roxor/Desktop/dsh/dsh kanban", // dir 所在工作树根
      "isWorktree": false,                                // true = linked worktree（非主工作树）
      "isMainWorktree": true,
      "branch": "main",                                   // detached 时为 null
      "detached": false,
      "sha": "f65b4f191525e6c1c711db48c4e4084c83998365",
      "shortSha": "f65b4f1",
      "subject": "docs(v0.11.0): 会话归档真实宿主 UI 验收…",
      "authorName": "roxorlt",
      "committedAt": 1793088341000
    },
    "upstream": {                                          // 当前分支的跟踪分支；无则 null
      "ref": "origin/main",                                // 完整短名
      "remote": "origin",
      "branch": "main",                                    // 远端侧分支名
      "ahead": 10,                                         // 当前分支领先 upstream 的提交数
      "behind": 0
    },
    "base": {                                              // 泳道图左侧参照物；探测不到主分支时为 null
      "kind": "upstream",                                  // "main" | "upstream"
      "label": "origin/main",                              // 泳道 0 的展示标签
      "branch": "main",                                    // 主分支名（探测结果）
      "remoteRef": "origin/main",                          // 主分支的远端同名引用；不存在时 null
      "ahead": 10,                                         // current 相对「泳道 0 参照物」领先
      "behind": 0,
      "mergeBase": { "sha": "7da8fff…", "shortSha": "7da8fff" },
      "remoteAhead": 0,                                    // base.branch 相对 remoteRef 领先（remoteRef 为 null 时 null）
      "remoteBehind": 0
    },
    "worktrees": [
      {
        "path": "/Users/roxor/Desktop/dsh/dsh kanban",
        "branch": "main",
        "detached": false,
        "sha": "f65b4f19…",
        "shortSha": "f65b4f1",
        "isMain": true,
        "isCurrent": true,                                 // 是否本次采集目录所在工作树
        "aheadOfBase": 10,                                 // 相对 base 参照物；无法计算时 null
        "behindOfBase": 0
      }
    ],
    "worktreesTruncated": 0,                               // 超过 8 个时省略的数量
    "graph": {                                             // v0.14：Fork 风格多分支提交图数据（§4.5）
      "refs": [                                            // 顺序 = 泳道种子优先级（§4.5）
        { "name": "HEAD", "kind": "head", "sha": "f65b4f1…", "shortSha": "f65b4f1", "branch": "main" },
        { "name": "main", "kind": "branch", "sha": "f65b4f1…", "shortSha": "f65b4f1",
          "isCurrent": true, "upstream": "origin/main", "ahead": 10, "behind": 0 },
        { "name": "origin/main", "kind": "remote", "sha": "7da8fff…", "shortSha": "7da8fff" },
        { "name": "feat/m2-session-target", "kind": "branch", "sha": "ad30d2a…", "shortSha": "ad30d2a",
          "isCurrent": false, "upstream": null, "ahead": null, "behind": null }
      ],
      "refsTruncated": 0,                                  // 超出 maxRefs 未返回的引用数
      "commits": [                                         // --date-order（父提交永远在孩子之后），最多 48 条
        { "sha": "f65b4f1…", "shortSha": "f65b4f1",
          "subject": "docs(v0.11.0): 会话归档真实宿主 UI 验收…",
          "authorName": "roxorlt", "committedAt": 1793088341000,
          "parents": ["f9843a1…"] },                       // 合并提交有多个父 sha
        { "sha": "7da8fff…", "shortSha": "7da8fff", "subject": "…", "authorName": "…",
          "committedAt": 1793000000000, "parents": ["e30c6b5…"] }
      ],
      "truncated": 120,                                    // 引用范围内总提交数 − 返回条数
      "maxCommits": 48,
      "maxRefs": 10
    },
    "commits": {                                           // v0.13 legacy 两泳道数据：保留给旧前端；新前端优先用 graph
      "ahead":  [ { "sha": "…", "shortSha": "…", "subject": "…", "authorName": "…", "committedAt": 0 } ],
      "behind": [ /* 同结构 */ ],
      "shared": [ /* 同结构，从 mergeBase 开始向旧，含 mergeBase 本身 */ ]
    },
    "refs": [
      { "name": "HEAD", "sha": "f65b4f1…", "shortSha": "f65b4f1", "kind": "head" },
      { "name": "main", "sha": "f65b4f1…", "shortSha": "f65b4f1", "kind": "branch" },
      { "name": "origin/main", "sha": "7da8fff…", "shortSha": "7da8fff", "kind": "base" },
      { "name": "origin/feat/x", "sha": "…", "shortSha": "…", "kind": "upstream" }
    ],
    "limits": { "ahead": 12, "behind": 8, "shared": 4, "worktrees": 8 },
    "fetchedAt": 1793088341200,
    "durationMs": 137
  }
}
```

### 3.1 `available:false` 枚举

```jsonc
{ "ok": true, "revision": 332,
  "git": { "available": false, "reason": "no_cwd", "message": null,
           "requestedDir": null, "fetchedAt": 1793088341200, "durationMs": 1 } }
```

| reason | 含义 |
| --- | --- |
| `no_cwd` | 卡片没有 `cwd` |
| `missing` | 目录不存在 / 不可访问 |
| `not_git` | 目录不在 git 工作树内 |
| `no_commits` | 空仓库（无 HEAD 提交） |
| `timeout` | git 命令超时 |
| `error` | 其它 git/解析错误（`message` 带原因） |

> 前端对以上全部原因都静默隐藏区块；`message` 只用于日志/调试。

## 4. 字段语义与计算规则

### 4.1 主分支与泳道参照物（`base`）

设 `mainBranch` 按下列顺序探测（只读，逐个 `rev-parse --verify --quiet`）：

1. `refs/remotes/origin/HEAD` 的符号引用目标（如 `origin/main` → `main`）；
2. 本地分支 `main`；
3. 本地分支 `master`；
4. 远端分支 `refs/remotes/origin/main` / `refs/remotes/origin/master`（取到的名字部分）。

然后：

| 情形 | `base.kind` | `base.label`（泳道 0） | `ahead/behind` 比较对象 |
| --- | --- | --- | --- |
| 当前分支 ≠ `mainBranch` | `main` | `mainBranch`（如 `main`） | `mainBranch` |
| 当前分支 = `mainBranch` 且有 upstream | `upstream` | upstream 短名（如 `origin/main`） | `upstream` |
| 当前分支 = `mainBranch` 且无 upstream / 无远端 | `main` | `mainBranch`；`mergeBase=null`、图退化为单泳道 | —— |
| detached HEAD | `main` | `mainBranch` | 当前 HEAD 提交 vs `mainBranch` |

- `mergeBase = git merge-base <compareRef> HEAD`（比较对象如上表）。detached 时同样以 HEAD 计算。
- `base.ahead / behind = git rev-list --left-right --count <compareRef>...HEAD` 的右/左计数（ahead=右，behind=左）。
- `base.remoteRef`：主分支在 `origin` 上的同名引用存在则为 `origin/<mainBranch>`，否则 `null`；
  `remoteAhead/remoteBehind` = `git rev-list --left-right --count origin/<mainBranch>...<mainBranch>` 的右/左计数（不存在时为 `null`）。
- `base === null` 仅发生在探测不到任何主分支时：此时 `commits.ahead/behind/shared` 用单泳道替代——
  `shared` = 从 HEAD 起的最近 4 个提交，`ahead/behind` 为空数组，`mergeBase` 为 `null`。

### 4.2 提交列表（泳道图输入）

| 字段 | 来源命令 | 上限 |
| --- | --- | --- |
| `commits.ahead` | `git log --date-order --max-count=12 <compareRef>..HEAD` | 12 |
| `commits.behind` | `git log --date-order --max-count=8 HEAD..<compareRef>` | 8 |
| `commits.shared` | `git log --date-order --max-count=4 <mergeBase>`（含 mergeBase 本身） | 4 |

- 顺序一律 **新 → 旧**；格式 `%H%x1f%h%x1f%ct%x1f%an%x1f%s`（`%x1f` = 单元分隔符）。
- `committedAt` 为毫秒时间戳（`%ct` × 1000）。
- 提交数超过上限不影响 `base.ahead/behind` 的**完整计数**（计数来自 `rev-list --count`）。

### 4.3 工作树

`git worktree list --porcelain` 解析，主工作树排第一：

- `branch` 取 `refs/heads/<name>` 的短名；detached 时 `branch=null`、`detached=true`。
- `isMain`：`worktree list` 的第一项（或路径 === `repo.root`）。
- `isCurrent`：`realpath(worktree.path)` 是 `dir` 的前缀（最长匹配）。
- `aheadOfBase/behindOfBase`：对该工作树的分支与 `base` 比较对象做 `rev-list --left-right --count`；分支为空/比较对象为 null 时 `null`。
- 最多返回 8 个，多余的计入 `worktreesTruncated`；主工作树与当前工作树必须优先保留。

### 4.4 `refs`（引用标记）

给泳道图打标记用，按存在性追加：

| kind | 来源 |
| --- | --- |
| `head` | 恒有，`HEAD`（detached 时也只是 HEAD） |
| `branch` | 当前分支（若和 `head` 同 sha 也返回，展示时合并去重） |
| `base` | `base.remoteRef`（若存在）否则 `base` 的比较引用（`mainBranch`） |
| `upstream` | `upstream.ref`（若存在且与 head 同 sha 才有意义；仍照常返回） |

同一 sha 的多个 ref 由前端合并到同一行展示。

### 4.5 多分支提交图（`graph`，v0.14）

- **引用选取顺序**（最多 `maxRefs = 10` 条，数组顺序即前端泳道种子顺序）：
  1. `HEAD` 伪引用（`kind:"head"`，`branch` = 当前分支名，detached 时 `null`）；
  2. 当前分支（`kind:"branch"`、`isCurrent:true`）；
  3. 主分支（§4.1 探测出的 `mainBranch`，本地 `refs/heads` 存在时）；
  4. `origin/<mainBranch>`（若存在）；
  5. 当前分支的 upstream（若存在且未列出）；
  6. 工作树分支（`git worktree list` 顺序，未列出过的本地分支）；
  7. 其余本地分支（`%(committerdate:unix)` 倒序）；
  8. 已列出本地分支的 `origin/<branch>`（若存在且未列出）。
- **数据来源**：`git for-each-ref refs/heads refs/remotes/origin --format='%(refname:short) %(objectname) %(upstream:short) %(upstream:track) %(committerdate:unix)'`（只取 `origin` 远端，避免多远端爆炸）。`%(upstream:track)` 解析 `[ahead N, behind M]` → `ahead/behind`（`[gone]` 或无 upstream → `null`）。本地分支才有 `ahead/behind`，`HEAD`/`remote` 恒为 `null`。
- **提交集合**：`git log --date-order --max-count=48 --pretty=format:'%H%x1f%h%x1f%P%x1f%ct%x1f%an%x1f%s' <上面选出的 raw ref 名…>`（用 `HEAD`/`refs/heads/x` 这样的真实引用名，不用 `graph.refs[].name` 展示名）。**必须保持 `--date-order` 语义**：父提交永远出现在孩子之后，前端泳道布局依赖这一拓扑保证。`%P` 空格分隔父 sha。
- **`truncated`**：`git rev-list --count <refs…>` 减去返回条数；`graph.commits` 最多 48 条，超出只计数不返回。
- `refs[].sha` **不保证**出现在 `commits` 里（老分支 tip 可能被 48 条上限截掉）：前端对这类 ref 只在图例/工作树列表展示，不分配泳道。
- 示例场景：当前分支与 main、origin/main、其他工作树分支同时出现在一张图里；合并提交有 2 个父 sha；`refsTruncated > 0` 表示还有引用没画进来。

### 4.8 工作副本清理（Phase A 信息 + Phase B 软删除，v0.17）

- 信息层（Phase A）：`/git/workspaces` 的每个 worktree 增 `mergedIntoBase` / `upstream` / `modifiedCount` / `untrackedCount` / `locked` / `prunable` / `lastCommitAt`；前端据此显示「已并入主线 / 还没并入（多 N）」「已同步线上 / 有未推送 / 无远端」「有未保存改动 / 有未跟踪文件」「可安全清理或不可清理原因」。
- 清理（Phase B）：仅非主工作副本且没有被**未完成**（非 done/canceled）卡片使用时可执行（v0.21.0 #15 起 `done`/`canceled` 终态卡片不再算占用；清理后旧卡片 cwd 失效，可在详情 / 工作区「未指定」块用「重新绑定目录」改绑，v0.21.0 #16）；脏或未合并需用户在**二次危险确认**里明确 `confirmLoss`；服务端把目录移入 `~/.dsh-kanban/trash`（保留 7 天，可补救），再 `git worktree prune`；可选择同时删除本地分支（已合并 `-d`，未合并需二次确认后 `-D`）。接口契约见 02 §13。
- 安全底线：绝不删除主工作副本；不使用 `--force` 删目录（用移入回收站替代）；不在存在**未完成**卡片 cwd 时删除（探测允许集合仍包含全部未归档卡片 cwd，保证终态卡片的工作区地图可见）；任何删除都有二次确认与回收站兜底。

### 4.7 工作区地图（`POST /git/workspaces`，v0.16）

「工作区」视图按仓库聚合：`repos[].worktrees[]` 提供每个工作副本的分支 / 是否主工作副本 / ahead-behind（相对主分支）/ `dirty`；前端把卡片按 cwd 最长前缀归到工作副本。契约见 `docs/contracts/02-http-api.md` §12。无 cwd 或探测失败的卡片归「未指定」组。

### 4.6 批量摘要（`POST /git/summaries`，v0.15）

卡片徽标只需「在哪条工作线、多/少、线上同步没有」，不需要 graph 与提交列表。服务端提供轻量批量摘要（契约见 `docs/contracts/02-http-api.md` §11）：

- 入参为卡片 `cwd` 去重后的绝对路径列表（≤32）；只允许**看板未归档卡片的 cwd**，否则该项 `reason:"forbidden"`。
- 返回 `branch/detached/mainBranch/base{kind,ahead,behind}/upstream{ref,ahead,behind}|null/isWorktree/worktreePath`；无 graph、无 commits。
- 服务端 realpath 结果缓存 10s（≤128 条）；前端按仓库聚合、TTL 15s，避免 N 张卡 N 次探测。
- 前端用与详情同一套 `worklineStatus` 分类（位置 / 与主线 / 与线上），保证徽标与详情结论一致。

## 5. 前端渲染约定（供实现参照，非接口契约）

v0.23.0 起另有**看板级「工作线」总览视图**（工具栏第三个 Tab）：第一层按仓库 / 项目、第二层每条工作线一行（= 一个工作副本 + 它检出的分支）。数据**完全复用本契约 §4.7 的 `POST /git/workspaces`**（`worktrees[]` 的 `aheadOfBase` / `behindOfBase` / `mergedIntoBase` / `upstream` / `dirty` / `lastCommitAt` / `prunable`）与卡片 `cwd` 映射，不新增接口与卡片字段；行状态口径与工作区视图同源（`mergedIntoBase===true` → 已并入主线；否则未完成卡片或未保存改动 → 进行中；否则停滞；`prunable`/算不出 → 无法判断），详见 docs/03 §7.28 与 docs/06 §1.41。

v0.14.1 起详情抽屉**默认先说人话**：一眼看懂结论，提交图折叠为进阶视图（数据接口不变）。

- **区块结构**（自上而下）：
  1. 标题「工作线」；
  2. **一句话总结**（见下）；
  3. **关键事实表**：在哪条工作线 / 和主线比 / 和线上比 / 工作副本；每行一句口语；
  4. **「提交图」折叠按钮**：默认收起（`aria-expanded=false`），右侧显示改动数（如「48 个改动」）；展开后渲染 v0.14 的 Fork 风格多泳道图 + 多工作树列表（>1 时）。
- **一句话总结的分类**（由 `web/src/lib/worklineSummary.ts` 的 `buildWorklineSummary` 产出，组件只用 i18n 模板拼接）：
  - 位置：`detached`（游离 HEAD）/ `main`（就在主线上，`base.kind==='upstream'`）/ `feature`（在某条工作线上）；
  - 与主线：`main` / `same`（完全一致）/ `merged`（改动已全部并入主线，主线可能又有新改动）/ `behind-only` / `ahead-only` / `ahead-behind`；
  - 与线上：`no-upstream` / `synced` / `ahead`（本地多 N 处未同步）/ `behind`（线上 N 处没拉下来）/ `diverged`；
  - 中文措辞：工作线 / 主线 / 线上 / 改动（处）/ 工作副本 / 并入主线 / 未同步；英文对应 Work line / main line / remote / change(s) / work copy / merged / not synced。
- **去技术化**：一句话总结与事实表里不出现 `↑↓`、`HEAD`、`rebase` 等符号/术语，也不放原型注释类文案（如「给需要细看的人」）；技术细节只保留在展开的提交图里。
- **展开时才渲染提交图**（懒渲染，默认不产生图内容）：泳道算法与 v0.14 相同——refs 顺序做泳道种子（同 sha 共用泳道）、lane 状态机 `{sha,color,active}`、提交取最左期望泳道、第一父一律沿用当前泳道（主干颜色稳定）、多泳道期望同一父提交时在父行画汇入曲线后释放多余泳道、其余父提交占空闲槽位 / 追加列、泳道序号不左移、8 色循环；图例给出引用彩色圆点 + 名称 + 本地分支 `↑N ↓M` +「当前 / 工作树」徽标；320px 内滚动、`truncated>0` 时给出「仅显示最近 N 个提交」。
- **颜色**：只用 alias 令牌，调色板 8 色在 `drawer.css` 里定义为 `--kb-git-lane-0..7`；泳道/曲线/圆点走 `--kb-fork-color`。
- **溢出**：抽屉 400–520px / 390 竖屏都不横向溢出；长分支名靠 `title` 看全；≤480px 行内 ref 徽标只保留 HEAD。
- **数据缺失**：无 `graph`（旧服务端）、`available:false`、或没有任何提交 → 整块隐藏。
- **提交图 hover 高亮（v0.16）**：鼠标悬停任意提交行时，该提交所属泳道颜色的所有连线 / 圆点 / ref 徽标保持原样，其它泳道元素透明度降到 `0.18`（过渡 120ms），图例中同色分支同步高亮（其余降到 `0.45`）；移开恢复。纯展示交互，无点击/跳转/布局变化；`prefers-reduced-motion: reduce` 时去掉过渡；触屏无 hover 不影响功能。
- **卡片徽标（v0.15）**：看板卡片与列表行在标题/摘要下方显示一行紧凑徽标：彩色圆点 + `工作线 <branch>` + 关系短语（`多 N` / `已并入主线` / `和主线一致` / `少 N`）+ 线上短语（`未同步` / `线上落后 N` / `已同步`），窄卡片省略优先保留分支名（`title` 给全文）。
  - 只对**非主线的 feature 工作线**显示（主线卡片不显示，控制噪音）；卡片无 `cwd` / 非 git 仓库 → 不显示；有 `cwd` 但探测失败 → 显示灰色「工作线未知」，不谎报。
  - 数据来自 §4.6 批量摘要，前端按 `card.cwd` 映射；失败项静默降级为未知，不阻塞看板。

## 6. 缓存与性能

- 服务端不做持久缓存；前端模块内 LRU 缓存（key = `cardId + dir`，TTL 4s，最多 20 条），避免抽屉开关/重渲染抖动。
- 每条 git 命令 `timeout=2000ms`、`maxBuffer=4MiB`、`env.GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`（解析稳定）。
- 每张卡片最多执行 ~12 条 git 命令；典型仓库 <150ms。

## 7. 测试要求

- 服务端：临时仓库覆盖「普通仓库 / 分叉分支 + linked worktree / upstream 领先落后 / 非 git / 空仓库 / 候选目录跨仓库被忽略 / 工作树上限」；`graph` 覆盖「引用选取与去重、HEAD/当前/主分支/origin 主分支优先、工作树分支纳入、本地分支 ahead/behind 解析、提交父 sha（含合并提交多父）、date-order 拓扑、48 条截断与 truncated 计数、refs 上限与 refsTruncated、ref tip 被截断场景」。
- 路由：`GET /cards/:id/git` 的 404、405、200（available true/false）与 `?cwd=` 候选。
- 前端：`forkGraph` 泳道布局纯函数单测覆盖「种子泳道与同 sha 合并、颜色稳定、合并提交双父出弯、child 多 lane 汇入、lane 释放与复用、lane 不左移、ref tip 不在 commits、合并提交双环标记、HEAD 标记、1920/390 宽度下 lane 数自适应、旧响应无 graph 时隐藏」；i18n 中英齐全；tsc 通过。
