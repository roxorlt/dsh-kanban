# 卡片 Git 上下文契约 v0.1（新增，2026-10-27）

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
    "commits": {
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

## 5. 前端渲染约定（供实现参照，非接口契约）

- 区块标题：`分支 / 工作树`；数据不可用时**整块隐藏**。
- 顶部 chips：当前分支（等宽字体）、工作树（`isWorktree` 时显示 `工作树 · <目录名>`）、
  远端跟踪（`origin/feat/x ↑3 ↓0`，无 upstream 时显示「未关联远端」）、主分支关系（`main ↑3 ↓1`）。
- 泳道图两列：泳道 0 = `base.label`，泳道 1 = 当前分支（detached 为 `HEAD`）。
  行顺序：`ahead`/`behind` 合并后按 `committedAt` 倒序；随后 `commits.shared`（含分叉点）；
  同一时间戳保持「先 ahead 后 behind」的稳定顺序。分叉点行绘制两条泳道汇合线。
  行内展示：`refs` 徽标（HEAD / 分支 / 主分支 / origin 引用）+ subject（单行省略）+ 短 sha。
- 显示行数上限 12；**截断时保证分叉点可见**——优先保留分叉点行与其后的 2 条 shared 提交，
  剩余行从 ahead/behind 行里取；被省略的提交在末尾追加「还有 N 个提交」；图形本身是只读展示，不可交互。
- 多工作树（>1）时在图下方列出工作树：分支名、`主工作树`/`当前` 徽标、相对主分支 ↑↓、路径（末尾两段，title 全文）。
  当 `base.kind === 'main'` 时主工作树行相对主分支恒为 0/0，隐藏该行 ↑↓（避免自比噪声）。
- 亮暗主题都只用 `--dsw-alias-*` 令牌；泳道颜色：泳道 1 = `--dsw-alias-state-business-primary`，
  泳道 0 = `--dsw-alias-label-caption`，分叉/汇合线同泳道色。

## 6. 缓存与性能

- 服务端不做持久缓存；前端模块内 LRU 缓存（key = `cardId + dir`，TTL 4s，最多 20 条），避免抽屉开关/重渲染抖动。
- 每条 git 命令 `timeout=2000ms`、`maxBuffer=4MiB`、`env.GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`（解析稳定）。
- 每张卡片最多执行 ~12 条 git 命令；典型仓库 <150ms。

## 7. 测试要求

- 服务端：临时仓库覆盖「普通仓库 / 分叉分支 + linked worktree / upstream 领先落后 / 非 git / 空仓库 / 候选目录跨仓库被忽略 / 工作树上限」。
- 路由：`GET /cards/:id/git` 的 404、405、200（available true/false）与 `?cwd=` 候选。
- 前端：泳道行构建（排序、分叉点、refs 合并、单泳道、截断计数）纯函数单测；i18n 中英齐全；tsc 通过。
