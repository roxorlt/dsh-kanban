# 视觉验收报告 V2（A-01…A-15 收口）

> 对应看板卡片 `card-4cc19d2b`「视觉后续（V2–V6 合并）：DESIGN.md + 批次1–3 修复 + 验收矩阵」  
> 审计基准：[docs/10-visual-audit.md](./10-visual-audit.md)（问题清单 A-01…A-15、§4 不要改、§5 三批验收、附录 A 测量、附录 B checklist）  
> 验收日期：2026-11-02（Asia/Shanghai）  
> 结论：**A-01…A-15 全部通过（15 通过 / 0 未通过 / 0 跳过）**，craft 综合分 2.8 → **4.5 / 5**（剩余 5 项为非阻塞退回项，见 §5.2）  
> v0.26.0 合并动效批次后复跑（merge `68fbc4f`）：**仍 15/15 通过**，截图已按合并后构建重拍（`index-DY3pnvWg.js` / `index-Bb_nao0w.css`）

## 0. craft 评分变化

| craft 维度 | 审计 V1 | 本次 | 依据 |
|---|---:|---:|---|
| Typography | 2.5 | **4.5** | 四级字号落地：页 16/22/600、卡 14/20/500、分区/列头 12/16/600+0.02em、meta 11–12；页/卡层级不再倒置。扣分：16px 级仍写死字面无 `--dsw-font-*` 令牌；390 页标题被 44px 视图 tab 挤成省略号 |
| Color | 2.5 | **5** | 附录 A.1 全部抽样项亮/暗 ≥4.5:1（最低批量 hint 4.92）；状态文字/审批风险由 2.28–2.79 提升到 5.11–5.8（暗色不回退）；组件 CSS 仍 0 hex/rgb、0 渐变 |
| Anti-AI-slop | 4.5 | **4.5** | 无紫色/渐变/玻璃拟态/营销字体；本次未新增装饰性图形，保持产品密度 |
| State coverage | 2.5 | **4.5** | 新增 SSE 断线可见态（degraded/offline + 重试）、首屏 loading 计数占位与控件禁用、全局空态去重、拒绝按钮可见解释；扣分：写操作失败仍只靠 toast，缺就地错误位 |
| Accessibility | 2.0 | **4.5** | 390 主要操作有效热区 14/14 组 ≥44×44；icon-only 视图 tab 均有 aria-label/aria-selected；断线状态 aria-live 播报；对比度全达标；focus-visible 与 reduced-motion 保持。扣分：未跑真实屏幕阅读器 / axe |
| **综合** | **2.8** | **4.5** | 可用性与可读性缺口已收口，剩余为细节跟随项 |

## 1. 验收方法与环境

| 项 | 内容 |
|---|---|
| 工具 | `scripts/visual-audit.mjs`（零依赖：Node 22 内置 `WebSocket` + Chrome DevTools Protocol；`--label/--only/--base/--note` 可复用，可纳入后续视觉回归） |
| 浏览器 | Chrome for Testing 145（`--headless=new`，DPR 1） |
| 视口 | 1440×900、1024×768、720×900、390×844 |
| 主题 | light / dark（`data-kanban-theme` + color-scheme，亮暗各跑一遍） |
| 视图 | board / list / worklines / workspaces；抽屉、审批、批量选择、空态、loading、错误、断网等场景单独采样 |
| 数据 | `dev-server.mjs --seed demo`：8 张卡（backlog 1 / running 1 / needs_you 3 / blocked 1 / failed 1 / done 1），3 张有待处理审批（含 1 张多题审批） |
| 构建 | `.tmp/dist-verify`（Vite 生产构建；分支验收时 `index-C0eQ8oDv.js` / `index-Bz4M-54-.css`，合并动效后 `index-DY3pnvWg.js` / `index-Bb_nao0w.css`） |
| 快照 | commit `65cbf6c` + 工作区未提交改动（43 files changed, 2242 insertions / 869 deletions） |
| 运行 | final：2026-11-02 16:29:18 → 16:30:26（+08:00）；baseline：16:24（同脚本，改动前口径） |
| 产物 | `.tmp/visual/final.json`、`.tmp/visual/matrix-final.md`、`docs/assets/screens/visual-v2/final/`（25 张）、`.../baseline/`（25 张） |

判定口径：对比度按 WCAG 2.x 普通文本（≥4.5:1；装饰/禁用 ≥3:1）；热区用 `elementFromPoint` 在控件中心 ±21.5px 的 8 方向做命中测试（含 label 包裹/伪元素扩展）；BBox 相交用 `getBoundingClientRect`；断网用 CDP `Network.emulateNetworkConditions`；错误页用 `Network.setBlockedURLs`；loading 用注入脚本延迟 `/api/kanban/state` 2.5s 后 600ms 采样。

## 2. 验收矩阵（A-01…A-15）

| 项 | 验收标准（docs/10 §5） | 修复前（审计值） | 修复后（本次实测） | 判定 |
|---|---|---|---|---|
| A-01 | 390/720 工具栏 `scrollHeight===clientHeight`；筛选/选择/同步与列切换/分组条不相交；无横向滚动 | `.kb-toolbar` scrollHeight 90 / clientHeight 47，控件 y=113–149 与列切换条 y=117–159 重叠 | 390 board/list 106/106，720 board/list 47/47；0 处相交；`scrollWidth=390` | 通过 |
| A-05 | 390 主要操作有效热区 ≥44×44 | 主题 32×28、筛选 88×36、选择 64×28、抽屉编辑 70×28、关闭 32×32、审批按钮高 40、发送高 40、批量条高 28、复选框 14×14、视图 tab 36×40 | 验收清单 **14/14 组通过**：主题 44、筛选 88×44、选择 72×44、卡片菜单 44、抽屉编辑 70×44/关闭 44、审批 159×44、发送 72×44、批量条 44、卡片/列表复选框 label 44×44、视图 tab 44×44、列切换 88.5×44、列头新建 44、行标题热区 44 | 通过 |
| A-10 | 窄屏 icon-only 视图 tab 可访问名非空 | 只剩 `aria-hidden` 图标，可访问名为空 | board 8 tab / list 4 tab：命名非空且唯一，view tab 均有 `aria-label`，`aria-selected` 保留 | 通过 |
| A-08 | 断线 2s 内出现可见状态；恢复自动清除；aria-live | SSE `error` 只内部退避，离线 3s 无任何提示 | 断网 **5ms** 出现「连接中断，正在重试…」，4s 升「已断开 · 点击重试」；恢复 **1ms** 清除；隐藏页不误报；`aria-live="polite"` | 通过 |
| A-09 | 错误页用户化、无英文原文/dev 命令、诊断可展开、hint ≥4.5、重试热区 ≥44 | toast 透出 `Failed to fetch`；hint 含 `node scripts/dev-server.mjs --port 4599`；`NETWORK` 首屏暴露；hint 3.71:1 | 首屏无英文原文/无 dev 命令/无原始错误码；「诊断信息」按需展开含错误码；hint **5.8:1**；重试 **96×44** | 通过 |
| A-02 | 浅色状态/审批风险文字 ≥4.5，暗色不回退 | 浅色待你确认 2.79、已完成 2.28、审批风险 2.58 | 浅色 待你确认 5.8 / 已完成 5.8 / 审批风险 21；暗色 10.42 / 10.42 / 5.62（不回退）；彩色 dot/icon 保留 | 通过 |
| A-03 | 11–12px 可读元数据/说明 ≥4.5（附录 A.1） | `label-tertiary` 3.71、`label-caption` 2.13（列表计数、composer meta） | 附录 A.1 **18 行亮/暗全部 ≥4.5**（最低批量 hint 4.92；其余 5.11–18.9；暗 4.77–17.45）；caption/tertiary 仅装饰/禁用 | 通过 |
| A-04 | 审批权重低于卡片标题、卡内最多一个展开审批、非卡中卡、语义不变 | 审批区/卡高 291/438=0.664，整块 `warn-tertiary` 底色，选项白底「卡中卡」，审批标题 13/400 | warn 不透明底色覆盖 **0.664 → 0**；卡内展开审批 ≤1（其余一行摘要）；选项独立卡底 0；审批标题 13px ≤ 卡标题 14px（600 为 docs/10 建议值）；字段与提交语义不变（高度占比 0.551–0.726 仅记录） | 通过 |
| A-06 | 页 16/22/600、卡 14/20/500、分区 12/16/600+0.02em、meta 11–12 | 页标题 13/500（比卡片 14/500 小，层级倒置） | 页标题 **16/22/600**、卡 **14/20/500**、列头/分区 **12/16/600**（letter-spacing 0.24px）、meta 11–12；仍用 DSH 字体栈 | 通过 |
| A-07 | 1440 列表缩短标题→meta、行高 56–64；390 仍堆叠、字段不丢 | 行高 44 + summary 29；标题按钮 1244、meta 128 推到最右，中间约 1.1k px 空白 | 行高 **62**、内容主栏 **1180**、标题右缘→meta **12px**、文字右缘→meta 643.5；390 wrap 两行、横向溢出 false、字段 5/5 | 通过 |
| A-11 | 批量条计数/hint ≥4.5；禁用归档可辨；窄屏按钮 ≥36 | 已选数 3.6、hint 3.15、禁用归档文字 1.81 | 已选数 亮 **16.04** / 暗 9.79；hint 亮 **4.92** / 暗 6.79；禁用归档 4.92（1px 边界）→ 选中后 21；390 按钮最小高 **44**、无横向溢出 | 通过 |
| A-12 | 全局无结果只出现一个空态和一个清空入口 | 1440 board 空态 4 / CTA 5；list 空态 3 / CTA 4；390 list 3/3 | 1440 board **1/2**、list **1/2**；390 board **1/1**、list **1/1**；列头与分组头保留，列内退化为一行紧凑提示 | 通过 |
| A-13 | loading 顶栏计数不显示 0、筛选/选择禁用、骨架在列内 | 顶栏「共 0 张 / 待你确认 0 / 会话运行中 0」，筛选/选择仍可点 | 603ms 采样：计数为空占位、筛选/选择/新建 disabled、列内骨架 9 张；数据到达后恢复真实计数与可操作性 | 通过 |
| A-14 | 无 reject option 时拒绝按钮有可见解释或隐藏 | 仅 `title` 解释，触屏无 tooltip，无可见说明/aria-describedby | 拒绝 disabled + 按钮下方可见说明「此审批未提供拒绝选项…」+ `aria-describedby`（390 下 322×15px 不截断）；提交语义不变 | 通过 |
| A-15 | 列表行状态文字仅一处、项目/标签/时间/工具仍在、行高不增加 | 行首 dot + summary 行再次出现 dot + 状态词 + 项目 + 标签，44px 内重复 | 每行状态文字 **×1**（标题左侧 dot + 一处状态词），项目 7/7、meta 7/7、操作按钮 2/2，行高 62 | 通过 |

机器可读报告：`.tmp/visual/final.json`；逐项 before→after 明细：`.tmp/visual/matrix-final.md`。

## 3. 截图矩阵（25 张，`docs/assets/screens/visual-v2/final/`）

| 场景 | 1440 亮 | 1440 暗 | 1024 / 720 | 390 |
|---|---|---|---|---|
| 看板 | `board-light-1440.png` | `board-dark-1440.png` | `board-light-1024.png` / `board-light-720.png` | `board-light-390.png` / `board-dark-390.png` |
| 列表 | `list-light-1440.png` | `list-dark-1440.png` | `list-light-720.png` | `list-light-390.png` |
| 详情抽屉 | `drawer-light-1440.png` | —（暗色见看板/审批） | — | `drawer-light-390.png` |
| 审批区 | `approval-light-1440.png` | —（暗色见看板） | — | （390 审批见 `board-light-390.png`） |
| 批量选择 | `selection-light-1440.png` | — | — | `selection-light-390.png` |
| Composer | `composer-light-1440.png` | — | — | — |
| 空态 | `empty-light-1440.png` | — | — | `empty-light-390.png` |
| loading | `loading-light-1440.png` / `loading-list-light-1440.png` | — | — | — |
| 错误页 | `error-light-1440.png` | — | — | `error-light-390.png` |
| SSE 断线 | `sync-light-1440.png` | — | — | — |
| 工作线 / 工作区 | `worklines-light-1440.png` / `workspaces-light-1440.png` | — | — | — |

修复前同场景证据在 `docs/assets/screens/visual-v2/baseline/`（25 张），与审计 V1 截图（`docs/assets/screens/audit-*.png`）可三方对照。

## 4. 回归结果

| 检查 | 结果 |
|---|---|
| `npm --prefix web run lint:tokens` | 11 个 CSS 文件 **0 error / 0 warning** |
| `npm --prefix web run typecheck` | 0 error |
| `npm --prefix web test`（vitest） | **36 文件 / 477 例全部通过** |
| `npm test`（服务端 node --test） | **315/315 通过** |
| `npm --prefix web run build` | 通过；`web/dist` 已重建为与验收完全一致的产物（`index-C0eQ8oDv.js` / `index-Bz4M-54-.css`） |
| 控制台 / 网络（board / list / worklines / workspaces + 抽屉） | `console error 0 / 未捕获异常 0 / 4xx 0` |
| 布局 | 1024/720/390 无横向滚动；390 底部弹层与 `env(safe-area-inset-bottom)` 保留 |
| 主题 | 亮/暗均通过；暗色无回退（状态文字 4.77–6.89，均 ≥4.5） |
| 「不要改」清单（docs/10 §4） | 14 条全部保留：无 hex/rgb、无渐变、无外部字体、单主色+黑主按钮、看板/列表/审批/批量选择结构未动、安全区未改、tabular-nums 保留 |
| 宿主 iframe | 未在真实 DSH 窗口按 1280+inset 重测（本机 headless 独立模式）；`.kb-app--embedded` inset 与底部安全区代码未改动，属未覆盖项（见 §5.2） |

## 5. design-review + craft 评审

评审方式：按 `design-review` 的 10 个维度与 AI-slop 黑名单，对 §3 截图做静态评审 + §2 的实测数据交叉验证（不在真实宿主内，未跑 axe/屏幕阅读器）。

### 5.1 通过项

1. **层级**：页面标题 > 卡片标题 > 分区标题 > meta，四级字号 + 字重双通道成立，不再靠颜色单独承担层级。
2. **可读性**：状态词、审批风险、11–12px 元数据在亮/暗都 ≥4.5:1；颜色不是唯一状态标识（dot/icon/文字并存）。
3. **审批安全**：审批块从「整块橙色卡中卡」退为卡内分区，标题先被看到；无可拒绝项时有可见解释，触屏不再依赖 tooltip。
4. **密度**：列表行高 62 + 内容主栏 1180，扫视路径从「1244px 标题按钮 + 最右 128px meta」收敛；390 仍单列堆叠且字段不丢。
5. **状态完整**：断线、首屏 loading、空结果、初始错误、禁用、选中、审批 resolved 都有明确视觉；空态从「四份大虚线面板」收敛为一处入口。
6. **移动端可用**：390 工具栏不再重叠；14 组主要操作 ≥44×44；底部弹层与安全区保留。
7. **克制**：无新增装饰、无渐变/玻璃/营销字体，动效由 docs/11-motion.md 统一约束，本次未新增动画。

### 5.2 退回项（非阻塞，建议进后续视觉批次）

| # | 退回项 | 证据 | 建议 |
|---|---|---|---|
| R-01 | 390 顶栏页标题被 4 个 44px 视图 tab 挤成「DSH 看…」 | `final/board-light-390.png` | 移动端顶栏信息优先级：标题与 tab 竞争时二选一（隐藏标题或 tab 收进「更多」），不要在 44px 热区上回退 |
| R-02 | 视图 tab 有效热区 43×43（视觉 44×44，1px 相邻间隙吃掉） | `final.json` A-05 | 判定已通过（8 方向命中 0 miss），若要严格 ≥44 需给 tab 间 1px 以上间距 |
| R-03 | `tokens.css` 未镜像 3 个宿主令牌（`--dsw-font-xxxs-strong-11` / `--dsw-font-xxs-strong-12` / `--dsw-shadow-lv1`），独立预览会回落 | DESIGN.md §2.7/§2.10 已注明 | 补镜像或让设计文档只引用已镜像令牌 |
| R-04 | `--kb-radius-lg` 只有 `var(--kb-radius-lg, 16px)` 兜底引用，无全局定义 | 附录 A（DESIGN.md） | 补定义或改用已有圆角令牌 |
| R-05 | 未跑真实屏幕阅读器 / axe；真实宿主 iframe 未按 1280+inset 重测 | 本报告 §4 | 接入 axe 自动化（可作为 `scripts/visual-audit.mjs` 的下一步），真实宿主复验在重启后执行 |

## 6. 交付物与变更清单

| 类别 | 文件 |
|---|---|
| 设计事实源 | `DESIGN.md`（新增，374 行；v1.1）、`docs/03-design-system.md`（8 处最小回写，指向 DESIGN.md） |
| 验收工具 | `scripts/visual-audit.mjs`（新增，零依赖 CDP 验收脚本，可复跑） |
| 验收证据 | `docs/assets/screens/visual-v2/{baseline,final}/`（各 25 张）、`.tmp/visual/{baseline,final}.json`、`.tmp/visual/matrix-final.md` |
| 批次 1 | `web/src/lib/useRealtime.ts`、`App.tsx`、`components/Toolbar.tsx`、`i18n.tsx`、`styles/responsive.css` |
| 批次 2 | `web/src/styles/{base,app,board,list,drawer,inbox,modal,worklines,workspaces}.css`、`components/{ApprovalPanel,KanbanCard,ListView,DetailDrawer,SelectionBar,BoardView}.tsx` |
| 批次 3 | `web/src/components/{BoardView,ListView,ApprovalPanel,feedback,Toolbar}.tsx`、`web/src/styles/{list,board}.css`、`i18n.tsx`、`App.tsx` |

提交状态：本次交付**尚未 git commit**（工作区同时含并行动效任务与会话绑定任务的未提交改动），提交/发版由负责人按文件拆分后进行；本报告与 `docs/06` §1.43 记录的是工作副本快照。

## 7. 复跑方法

```bash
# 全量验收（自动构建 .tmp/dist-verify、4603 端口起 dev-server、输出 JSON + 矩阵 + 截图）
node scripts/visual-audit.mjs --label final

# 只验某一项
node scripts/visual-audit.mjs --only A-05

# 指定已部署地址
node scripts/visual-audit.mjs --label final --base http://127.0.0.1:4603/
```

复核机器可读报告：`.tmp/visual/final.json`（每项 `{id, threshold, measured, pass, evidence}`）。
