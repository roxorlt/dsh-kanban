# 动效规范与预算（M1 审计 + 第一批实现契约）

> 角色：**动效唯一事实源（single source of truth）**。`docs/03-design-system.md` §4.4 只保留一行摘要，细则以本文为准。
> 方法：`animate`（先判断该不该动 → 再定曲线/时长 → 再实现），审查门槛用 `review-animations`。
> 范围：DSH 看板 Web 面板（`web/src`）+ 宿主页「返回看板」气泡（`lib/client.js`）。
> 文件名按任务卡指定；仓库里 `docs/11-session-archive-linkage.md` 是另一主题，编号并列不冲突。

---

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 该不该加动效 | **只给「状态变化」和「浮层进出」加**，不给高频/键盘操作、列表渲染、hover 加装饰动效 |
| 时长 | 四档：120 / 180 / 220 / 退出 140–180ms；**UI 动效一律 ≤220ms**，唯一例外是「来源高亮」的 1.8s 一次性强调 |
| 曲线 | 三条：`--kb-ease-out`（进/出）、`--kb-ease-in-out`（屏幕内移动）、`--kb-ease-drawer`（抽屉/底弹）；**禁止内置 `ease`/`ease-in`** |
| 属性 | 只允许 `transform` / `opacity`；唯一例外：卡片展开/收起的高度（手风琴，上限 420px，见 §6.1） |
| 退出动画 | React 条件渲染会直接卸载 → 统一用 `usePresence` 延迟卸载 + CSS 过渡，**不用 keyframes**（可被打断） |
| reduced-motion | 两级：位移类**即时**、纯透明度类保留 120ms 淡变（§4） |
| 60fps | 不引移动库、不做 FLIP、不做整列重排动画、不做逐卡 stagger；拖拽落位只动 `transform`/`opacity`（§7） |

**本批次 6 项全部要做**，但每一项都先过「频率闸门」（§2）；过不了闸门的一律不加动效。

---

## 1. 现状审计（实现前的基线）

证据都是审计时读到的代码位置；行号会随实现漂移，以选择器为准。

### 1.1 已经对的

| 现状 | 位置 | 判定 |
| --- | --- | --- |
| 已有动效令牌：`--kb-ease-out: cubic-bezier(0.22, 1, 0.36, 1)`（≈ 推荐值 0.23/1/0.32/1）、`--kb-dur-fast/base/slow = 120/180/220ms` | `.kb-app-scope`（`styles/base.css`） | ✅ 保留并扩展，不新建平行体系 |
| 无 `transition: all` | 全仓扫描 | ✅ |
| 无 `scale(0)` 入场（Modal 用 `scale(0.99)`，pop 用 `translateY(-3px)`） | `styles/modal.css` `kb-modal-in`、`styles/base.css` `kb-pop` | ✅ |
| 无内置 `ease-in` 用于 UI 交互 | 全仓扫描 | ✅ |
| 无 hover 缩放/位移（hover 只有颜色/描边变化） | 全仓扫描 | ✅ 默认无「未 gate 的 hover 动效」问题，继续不引入 |
| 抽屉/遮罩/Modal/Toast/菜单都只用 120–220ms | `styles/*.css` | ✅ 在预算内 |

### 1.2 问题清单（本次要修）

| # | 问题 | 证据 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| A-01 | **所有浮层都没有退出动画**：抽屉、批量条、Toast 都是条件渲染直接卸载 | `App.tsx` `{activeCard ? <DetailDrawer/> : null}`；`{selectionMode ? <SelectionBar/> : null}`；`Toast.tsx` `if (!toasts.length) return null` | 收起是「啪一下消失」，空间连续性丢失；`review-animations` 定为 feel-breaking | §5 `usePresence` + 各项加离场过渡 |
| A-02 | **抽屉用 keyframes 进场**（`kb-fade` / `kb-slide-in` / `kb-sheet-in`） | `styles/drawer.css`、`styles/responsive.css` | 快速开关/中途反向时不可打断，会从起点重放 | 改 CSS 过渡 + `@starting-style`，离场走 leaving 类 |
| A-03 | **Toast 用 keyframes 进场**（`kb-toast-in`） | `styles/base.css` `.kb-toast` | Toast 是最典型的「一秒内可触发两次」元素，keyframes 在 `review-animations` 里是 escalation trigger | 改过渡 + `@starting-style`，离场走 leaving 类 |
| A-04 | **卡片展开/收起没有高度过渡**：只有一段入场 `kb-reveal`，收起是瞬时 | `styles/board.css` `.kb-card-expanded`；`KanbanCard.tsx` 条件渲染 | 展开时卡片下沿跳动；收起无自解释 | 手风琴高度过渡（§6.1） |
| A-05 | **拖拽没有任何落位/跨列反馈**：拖起只变 `opacity: .45`，放下即瞬移 | `styles/board.css` `.kb-card--dragging`；`BoardView.tsx` 原生 DnD | 2000 卡场景下用户丢失「卡去哪了」的空间线索 | 落位 settle + 目标列接收提示（§6.6），**明确不走 FLIP** |
| A-06 | **返回看板气泡无进出场**，只有 hover 颜色过渡 | `lib/client.js` `.dsh-kanban-return-bubble` | 气泡突然出现/消失；它是「从会话回看板」的关键入口 | `@starting-style` 进场（宿主 fast 100ms，纯 CSS）+ 来源卡片高亮已存在（§6.5） |
| A-07 | **两处进度条用 `width` 过渡（非 GPU 属性）** | `.kb-progress__fill`（`styles/drawer.css`）、`.kb-worklines__bar-fill`（`styles/worklines.css`） | 每帧触发 layout+paint；卡多时是掉帧来源 | 改 `transform: scaleX()` + `transform-origin: left` |
| A-08 | **reduced-motion 是一刀切**（`animation-duration/transition-duration: 0.01ms !important`） | `styles/base.css` 末尾 | 把「帮助理解状态的透明度反馈」也杀了，`review-animations` 第 8 条要求「gentler, not zero」 | 两级策略（§4），只给纯透明度浮层保留 120ms |
| A-09 | **`docs/03` §4.4 的时长（100/200/300ms）与代码（120/180/220ms）不一致** | `docs/03-design-system.md` §4.4 vs `styles/base.css` | 两套口径，后续实现各写各的 | 本文收敛为 120/180/220，`docs/03` 改为指向本文 |
| A-10 | **`--ds-transition-*` / `--ds-ease-in-out` 与 `--kb-*` 双体系并存**，且散用于呼吸点/骨架 | `styles/tokens.css`（兜底）、`lib/client.js`（宿主页元素）、`.kb-dot-pulse`/`.kb-breathe` | 不是死代码，但边界不清，容易被误用成「第四种曲线」 | 定边界（§3.3）：宿主页元素用 `--ds-*`（DSH 提供），面板内一律 `--kb-*`；循环呼吸动画保留（恒定运动，不是 UI 过渡） |

### 1.3 保留不动的（审计结论：不需要动效）

| 对象 | 为什么不加 |
| --- | --- |
| 搜索/筛选的实时结果更新 | 高频（≥100 次/天量级），任何动画都是延迟 |
| 列表/看板整体重渲染、卡片进出列表 | 高频 + 2000 卡目标，stagger 会变成掉帧源 |
| 键盘焦点环、快捷键操作（`?`/`T`/`L`/`Esc` 等） | 键盘操作不加动画（`animate` 硬规则） |
| 列折叠/展开 | 高频切换；只保留 chevron 180ms 旋转作为状态指示，内容瞬时切换 |
| hover 缩放/抬升 | 触屏误触 + 高频；现有「只改颜色」的 hover 是对的 |
| 拖拽过程中的自定义跟随层 | 原生 drag image 已够用；自绘会引入掉帧与复杂度 |
| 审批选项的长按/悬浮提示气泡 | 已在 v0.23 实现且与动效无关，不动 |

---

## 2. 动效预算：先过频率闸门

`animate` 的闸门（照搬，不解释）：

| 频率 | 允许的动效 |
| --- | --- |
| 100+ 次/天（快捷键、命令面板、搜索） | **不加动效** |
| 几十次/天（hover、列表导航） | 只允许几乎不可察觉的微反馈（≤120ms）或不动 |
| 偶发（抽屉、弹层、Toast、批量条） | 标准动效（120–220ms） |
| 罕见/首次（来源高亮、成功反馈） | 可以有「delight 预算」（≤1.8s 的一次性强调，仅颜色类） |

每个动效必须先能说出**目的**（`feedback` / `spatial consistency` / `state indication` / `prevent jarring change` / `explanation` / `delight`）。说不出的，不加。

本批 6 项的目的：

| 项 | 目的 |
| --- | --- |
| 卡片展开/收起 | `prevent jarring change`（内容块突然出现/消失） |
| 详情抽屉进出 | `spatial consistency`（从卡片打开、回到卡片） |
| 审批提交反馈 | `feedback` + `state indication`（已收到、正在处理、已生效） |
| 批量条出现/退出 | `state indication`（进入/退出批量模式） |
| 返回气泡 + 来源高亮 | `spatial consistency`（从会话回来，落地在哪张卡） |
| 拖拽落位 + 跨列 | `spatial consistency` + `state indication`（卡从哪来、落到哪） |

---

## 3. Motion tokens

### 3.1 时长阶梯（只允许用这些）

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--kb-dur-press` | 120ms | 按压回弹（`:active` 的 `scale(0.97)`）、hover 颜色 |
| `--kb-dur-fast` | 120ms | 小浮层（菜单/筛选/提示）、chevron 旋转、纯颜色反馈 |
| `--kb-dur` | 180ms | 卡片展开进入、Toast 进入、批量条进入、拖拽落位 |
| `--kb-dur-slow` | 220ms | 抽屉进入、底部弹层进入 |
| `--kb-dur-exit` | 140ms | Toast/批量条/卡片收起离场 |
| `--kb-dur-exit-slow` | 180ms | 抽屉/底部弹层离场 |

**退出比进入快一档**：系统响应要跟手；「展开」需要自解释，「收回」不需要再讲一遍。

### 3.2 曲线（只允许用这三条）

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--kb-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 所有进入/退出（强 ease-out，收尾快） |
| `--kb-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | 屏幕内移动（跨列落位、位置重排） |
| `--kb-ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | 抽屉、底部弹层（iOS 抽屉曲线） |

禁止：内置 `ease`（太弱）、`ease-in`（在用户最关注的时刻拖慢）、线性（除非恒定运动如 progress/spinner）。

### 3.3 双体系边界（`--kb-*` vs `--ds-*`）

- **看板面板内**（`web/src/styles/*`）：一律 `--kb-*`。这是本产品的动效语言。
- **宿主页注入元素**（`lib/client.js` 的「返回看板」气泡，挂在 DSH Composer 里）：用 DSH 提供的 `--ds-transition-duration*` / `--ds-ease-in-out`。**实测宿主 asar（DSH 0.1.5-rc.2）只注入 `--ds-ease-in-out`、没有 `--ds-ease-out`**，`--ds-transition-duration-fast` 实际是 `0.1s`；所以宿主页写法统一用带兜底的形态 `var(--ds-ease-out, var(--ds-ease-in-out))`（裸用不存在的变量会让整条 `transition` 失效、连 hover 颜色过渡一起丢）。颜色过渡用内置 `ease` 即可（hover/颜色属于允许内置曲线的场景）。**不要**把 `--kb-*` 带进宿主页（宿主不保证注入这些变量）。
- `.kb-dot-pulse` / `.kb-breathe` 这类**恒定循环**动画继续用 `--ds-ease-in-out`：它们是呼吸/脉冲，不是 UI 过渡，不受三曲线约束；但 reduced-motion 下必须静默（现有 `.kb-dot--business::after { display: none }` + 总闸已覆盖）。

---

## 4. reduced-motion：两级策略

总闸保留（安全网），但把「有帮助的透明度反馈」从总闸里豁免出来：

| 级别 | 内容 | reduced-motion 下 |
| --- | --- | --- |
| **A 级：位移/缩放/高度** | 抽屉滑入滑出、底部弹层升降、卡片展开高度、拖拽落位缩放、Toast/批量条位移 | **即时完成**（0ms，不播动画）。位移类动效在 RM 下没有存在价值，只会让人不舒服 |
| **B 级：纯透明度/颜色** | 抽屉遮罩淡入淡出、Toast 淡入淡出、批量条淡入淡出、来源高亮（改用静态描边） | **保留 120ms 淡变**（不产生位移，帮助理解「发生了什么」） |

实现：

- 总闸（`styles/base.css` 末尾）继续 `animation-duration / transition-duration: 0.01ms !important`；
- B 级例外写在同一个 `@media (prefers-reduced-motion: reduce)` 块里，用**更具体的选择器 + `!important`** 压过总闸，并把 `transition-property` 锁成 `opacity`（确保 RM 下永远不会动位置）：
  `.kb-drawer-overlay`、`.kb-toast`、`.kb-batchbar`；
- 位移类由 JS 侧 `usePresence` 把退出等待压到 0（`presenceExitMs(exitMs, reducedMotion)`），见 §5；
- 一次性强调（来源高亮）保留现有做法：`animation: none` + 静态描边/底色。

---

## 5. 退出动画原语：`usePresence`

React 条件渲染会在 `open=false` 的同一帧卸载元素，CSS 拿不到离场帧。统一原语：

`web/src/lib/usePresence.ts`

```ts
usePresence(open, exitMs)            // → { mounted, leaving }
usePresenceValue(open, value, exitMs) // → { mounted, leaving, value }（抽屉用：离场期间保留最后一张卡的数据）
presenceExitMs(exitMs, reducedMotion) // 纯函数：RM 下为 0（有单测）
```

规则：

1. 组件只在 `mounted` 为 true 时渲染；`leaving` 为 true 时挂 `.kb-*-leaving` 类。
2. 离场动画只用 **CSS 过渡**（不用 keyframes）→ 连续开关时从当前值重新起算，不会闪回起点。
3. `leaving` 状态下必须 `pointer-events: none`；焦点圈定/焦点归还逻辑要在**开始离场时**就解除（不能等卸载）。
4. `exitMs` 用 `--kb-dur-exit` / `--kb-dur-exit-slow` 的同一数值（JS 与 CSS 保持同源，值写在组件常量里并注释指向本文）。
5. 不引入动画库：CSS 过渡 + 原生 DnD 已够，`animate` 的「最便宜工具」原则。

---

## 6. 第一批实现规格（6 项）

每项都必须满足：**功能 + 视觉（曲线/时长/原点对）+ 可打断 + reduced-motion + 不掉帧**。
「验收」列是 `review-animations` 复核时的检查点。

### 6.1 卡片展开/收起（`KanbanCard.tsx` + `styles/board.css`）

- 频率/目的：偶发；`prevent jarring change`。
- 工具：手风琴高度过渡（`animate` 明确允许的例外：高度动画只用于 accordion，且必须短）。
- 进入：`height 0 → min(scrollHeight, 420px)` + `opacity 0 → 1`，**180ms** `--kb-ease-out`；进入后 `overflow-y: auto` 接管（`max-height: 420px` 保留）。
- 退出：`height 实测 → 0` + `opacity 1 → 0`，**140ms**；结束时卸载。
- 高度必须**测量**（JS 读 `scrollHeight`），不允许动画到 `auto`；只动当前这一块，其他卡片由浏览器自然 reflow。
- 打断：连续点开/收 → 用「先测当前高度再起过渡」的方式（过渡能 retarget），不得重放。
- reduced-motion：直接切换（不测高、不设过渡）。
- 验收：展开时卡片下沿连续移动、无跳变；收起有离场；快速连点不闪烁；2000 卡数据下展开单个卡片不出现长帧（DevTools 录制 > 16.7ms 帧数 = 0，标注实测/推断）。

### 6.2 详情抽屉进出（`DetailDrawer.tsx` + `styles/drawer.css` + `styles/responsive.css`）

- 频率/目的：偶发；`spatial consistency`。
- 进入：遮罩 `opacity 0 → 1` **180ms** `--kb-ease-out`；抽屉 `translateX(18px) → 0` + `opacity 0.6 → 1`，**220ms** `--kb-ease-drawer`；底部 sheet 为 `translateY(100%) → 0`。
- 退出：抽屉 `translateX(0 → 18px)` + `opacity → 0`，**180ms**；遮罩 `opacity → 0` **140ms**；由 `usePresence(open, 180)` 延迟卸载。
- 打断：用 CSS 过渡 + `@starting-style` 进场（去掉 `kb-fade`/`kb-slide-in`/`kb-sheet-in` 的 keyframes 用法），中途反向可 retarget。
- 关掉时：`pointer-events: none` 第一帧生效、解除 Tab 圈定、归还滚动与焦点（触发元素失效则 blur 后再 `aria-hidden`），不等卸载；关闭动作加幂等 guard（Esc/遮罩/关闭按钮重复触发 no-op）。
- 审批列表注意：抽屉里审批是列表渲染，提交成功后数据先移除，若直接 map 数据，`ApprovalSlot` 会连带卸载、淡出播不出来 —— 用「slot id 比数据多活 140+40ms」的方式保一帧（见 `DetailDrawer.tsx` 里 `approvalSlotIds`）。
- reduced-motion：即时出现/消失；遮罩保留 120ms 淡变（B 级）。
- 验收：抽屉是从右侧「滑出」而不是「淡入」；关闭能看到收回；开关动画期间 Esc/再次点击不报错、不双开。

### 6.3 审批提交反馈（`ApprovalPanel.tsx` + `styles/drawer.css`/`styles/board.css`）

- 频率/目的：偶发；`feedback` + `state indication`。
- 三段式：
  1. **按压**：主按钮 `:active { transform: scale(0.97) }`，120ms `--kb-dur-press`，`--kb-ease-out`；
  2. **处理中**：按钮 `disabled` 且文案切「处理中…」时，图标位换成既有 `.kb-spin`（0.8s linear）——这是恒定运动，允许；按钮内容整体 `opacity .7` 过渡 120ms；
  3. **已完成**：结果面板（批准/驳回区块）随数据刷新**整块淡出**（`opacity 1 → 0` + `translateY(0 → -2px)`，140ms `--kb-dur-exit`）提示「已提交」；外壳是 `web/src/components/ApprovalSlot.tsx`，只做 opacity/transform、离场期 `pointer-events: none`，不得用 keyframes 闪烁。
- 不做：成功打勾的弹跳、confetti、toast 抖动。
- reduced-motion：按压缩放、位移即时；`opacity` 淡变保留 120ms。
- 验收：点「批准」有按下反馈；处理中不可重复提交且看得出在忙；完成后区块淡出而不是硬消失；错误路径（校验失败）不播成功反馈。

### 6.4 批量条出现/退出（`SelectionBar.tsx` + `App.tsx` + `styles/app.css`）

- 频率/目的：偶发；`state indication`。
- 进入：`opacity 0 → 1` + `translateY(-4px) → 0`，**180ms** `--kb-ease-out`；
- 退出：反向，**140ms**（`usePresence(selectionMode, 140)`）；
- **不做高度动画**：批量条出现会让主区上下移动，用高度动画等于每帧 reflow；改为「瞬时占位 + 淡入」。
- reduced-motion：只淡不变（B 级例外已包含 `.kb-batchbar`）。
- 验收：进入批量模式和退出时都能看出条是「淡入/淡出」而不是闪；快速开关不残留；退出后选中态不残留。

### 6.5 返回气泡 + 来源卡片高亮（`lib/client.js` + `styles/board.css`/`styles/list.css`）

- 频率/目的：偶发；`spatial consistency`。
- **返回气泡**（宿主页）：进场 `@starting-style { opacity: 0; transform: translateY(2px) }` + `transition: opacity/transform var(--ds-transition-duration-fast) var(--ds-ease-out, var(--ds-ease-in-out))`（宿主实测 fast = 100ms，见 §3.3；比面板内 120ms 略快，属宿主令牌口径）；退出不做（气泡随导航消失，无空间连续性需求，宁少勿多）。
- **来源高亮**（面板内）：已实现（1.8s 一次性颜色强调 + RM 静态描边 + 列表视图同语义）。本批只**复核**：高亮必须落在来源卡上、1.8s 后清除、RM 下为静态描边、列表/看板一致；不需要改语义。
- 验收：从会话点气泡回来 → 气泡淡入 → 看板滚动到来源卡并高亮 1.8s；RM 下无闪烁只有描边。

### 6.6 拖拽落位与跨列过渡（`BoardView.tsx` + `KanbanCard.tsx` + `styles/board.css`）

- 频率/目的：偶发；`spatial consistency` + `state indication`。
- **不使用 FLIP**（首版已因掉帧放弃）：跨列不做「卡片从旧位置位移到新位置」的长距离动画。2000 卡场景下测旧位置 ↔ 新位置需要读两次布局，且动画期间整列 reflow，性价比不成立。
- 替代方案（三段反馈）：
  1. **拖起**：`.kb-card--dragging { opacity: .45 }` 改为 `transition: opacity 120ms`（瞬时 → 过渡）；不做抬升缩放（原生 drag image 已表达）。
  2. **落位 settle**：放下后卡片在目标位置挂 `.kb-card--dropped` 一次性类 → `opacity .6 → 1` + `scale(0.98 → 1)`，**180ms** `--kb-ease-out`，用**过渡**（`@starting-style` 或下一帧移除起始态），`transitionend`/定时器后移除类，避免下次误播。
  3. **目标列接收提示**：`.kb-column--received` 一次性背景 tint（`background` 过渡 220ms `--kb-ease-out`，颜色用 `--kb-status-running` 混色，与现有 `.kb-column--over` 同色系），220ms 后移除类。只改一个背景色，不触发 layout。
- 注意：跨列后卡片是**重新挂载**（换了父列表），所以「落位动画」必须由 `droppedId` 状态驱动，不能依赖同一 DOM 节点的过渡。
- reduced-motion：三段全部即时（不播）。
- 验收：拖拽开始有轻微淡出（不是硬变 45%）；放下后卡片有「落定」手感；目标列闪一下表示收到；连续拖多张不叠类、不误播；拖动中列表不出现逐帧 reflow。

---

## 7. 性能预算（60fps）

### 7.1 硬规则

1. 只动 `transform` / `opacity`（例外：§6.1 手风琴高度）。
2. 不申请常驻 `will-change`（只在 `leaving`/`dragging` 期间临时提升的话必须写注释说明）。
3. 不做逐卡 stagger、不做整列布局动画、不做 FLIP。
4. 每帧只允许一次合成层变化：同一时刻最多一个元素在跑长动画（抽屉 + 卡片展开不会同时发生）。
5. `animation` 只用于恒定循环（spinner/breathe）与一次性强调（来源高亮）；交互驱动的一律 `transition`。
6. 动画时长与 `exitMs` 必须同源（JS 常量 = CSS 令牌值，改一处必须同时改）。

### 7.2 如何验证（必须区分「实测」与「推断」）

- **实测**：`node web/dev/mock-api.mjs --port 4599` + `npm --prefix web run dev`（Vite 5183）→ Playwright/DevTools：
  - 录 Performance，检查动画期间是否有 > 16.7ms 的帧；
  - `document.getAnimations()` 读实际时长/曲线/属性，确认没有跑偏的时长或非 GPU 属性；
  - 截图核对进场/离场视觉。
- **推断（必须标注）**：2000 卡规模下的 60fps 是**架构性保证**（GPU 属性 + 无 FLIP + 无整列重排），不是实测结论；报告里必须写「未实测」而不是「已达标」。
- 报告位置：审查结论写进本卡时间线与 `docs/11-motion.md` §8（审查记录），不另开文件。

### 7.3 性能预算（本批新增的每帧成本上限）

| 项 | 新增每帧工作 | 上限 |
| --- | --- | --- |
| 抽屉进入/退出 | 遮罩 opacity + 抽屉 transform（2 个合成层） | 2 层 |
| 卡片展开 | 高度布局 1 块 + opacity | 420px 内 |
| 批量条 | opacity + transform | 1 层 |
| Toast | opacity + transform | 1 层/条 |
| 拖拽落位 | opacity + transform | 1 层 |
| 目标列接收 | background（重绘 1 列） | 1 列 |

---

## 8. 审查与验收

- 审查工具：`review-animations`（独立审查，默认挑刺），不接受「能跑就算过」。
- **Block 条件**（出现即打回）：`transition: all`、`scale(0)` 入场、UI 用 `ease-in`/内置 ease、键盘高频操作加动画、时长 > 300ms 无理由、keyframes 用在 Toast/开关类、动 layout 属性且无手风琴理由、未 gate/未处理 reduced-motion、对称的按压-释放时序。
- 通过条件：无 feel-breaking 回归；该删的动效已删；时长/曲线在预算内；可打断；reduced-motion 两级正确；性能属性正确。
- 审查记录：结论（通过/打回项 + 修复）追加到 §9 变更记录，并在卡片时间线留节点。

---

### 8.1 审查记录（M3）· 2026-11-02

- **审查人**：`motion-reviewer`（独立第三方；默认挑刺，通过要挣）。
- **审查对象**：分支 `feat/motion-batch` 相对基线 `HEAD(65cbf6c)` 的全量动效改动（M1 底座 + M2 六项 + Lead 接线）。
- **方法**：`review-animations`（十项不可妥协标准 + escalation triggers + 分层输出），规格对照本文 §2–§7；`animate` 硬规则 / Never Ship 清单。
- **环境**：worktree 内 Vite dev（5183）+ mock API（4599）；Playwright Chromium 1440×900 与 420×820（移动 sheet）。**`WEBGL_debug_renderer_info` = ANGLE (SwiftShader)** —— 本机为**软件渲染、无 GPU**，帧数据只代表软件渲染下限，**不能**当作「真机 60fps 已达标」；本文所有帧/时长均标注「实测」，其余标注「未实测 / 推断」。

#### 8.1.1 结论

**Approve（修复后）**。审查开始时命中 2 个 Block 级问题（Toast 进出场实际未生效、批量条离场期显示「已选 0 张」），均已在本轮修复并用浏览器实测复验；P1 抽屉掉帧已按 Lead 定位的方案修复（动画期去掉全屏 backdrop-filter），实测动画窗口帧时间减半以上。修复后无 Block 级残留；剩余为「保留项 + 理由」（见 8.1.5）。

十项标准复核（修复后）：

| # | 标准 | 结果 |
| --- | --- | --- |
| 1 | 目的 | ✅ 六项都能对到 §2 的 purpose；无「看起来酷」的装饰动效 |
| 2 | 频率 | ✅ 只给偶发项加；键盘/hover/列表渲染不加；hover 无位移 |
| 3 | 曲线 | ✅ 全部走三条自定义 token；无内置 ease / ease-in |
| 4 | ≤300ms | ✅ UI 全部 120–220ms；唯一 >300ms 是 1.8s 一次性来源高亮（§2 例外） |
| 5 | 原点/物理正确 | ✅ 抽屉右缘、移动端 sheet 底部、Toast/批量条自上；无 `scale(0)`（落位用 0.98） |
| 6 | 可打断 | ✅ 交互驱动全部 transition；实测抽屉/卡片/Toast 快速反向与连点不闪回 |
| 7 | GPU 属性 | ✅ 只动 transform/opacity；唯一 layout 动画是手风琴高度（§6.1 允许）；进度条已 scaleX |
| 8 | 无障碍 | ✅ 两级 reduced-motion 实测生效；位移类即时、纯透明度类 120ms（修复后）；焦点/滚动/aria 实测正确 |
| 9 | 进入/退出不对称 | ✅ 退出统一快一档（180→140、220→180），按压 120ms 非对称 |
| 10 | 一致性 | ✅ 时长/曲线同源；两张卡片列表共用同一套展开节奏；无跨批次风格漂移 |

#### 8.1.2 Findings（Before | After | Why）

**feel-breaking**

| Before | After | Why |
| --- | --- | --- |
| `.kb-toast` 的 `transition` 用 `var(--kb-dur)`/`var(--kb-ease-out)`，但 Toast 由 `Toast.tsx` `createPortal` 到 `document.body`，`--kb-*` 只定义在 `.kb-app-scope` → 变量缺失使整条过渡 IACVT。实测 `transitionDuration: 0s`、`getAnimations()` 0 条，离场瞬间 opacity=0 却仍在 DOM 留 140ms（base.css 旧 `.kb-toast`；`Toast.tsx:2,129`） | 动效 tokens 上移到 `:root`（base.css:88），`.kb-app-scope` 只留配色类 token。实测进场 `opacity/transform 180ms`、离场 `140ms`，A-03 才真正落地 | 规格要求「Toast 用过渡替代 keyframes」，改法对但落在作用域外 → 动效静默消失；这是 pre-batch 就存在的根因（原 `kb-toast-in` 同样失效），本批次宣称的 A-03 未实际达成 |
| 批量条离场期显示「已选 0 张」：`batchbarHeld` ref 用 `useEffect` 在 `!leaving` 时快照，但「清空选中集」与「leaving=true」分属两次提交，清空那次 `leaving` 仍为 false → ref 被 0 覆盖（App.tsx:1839–1846 旧实现） | 改用 `usePresenceValue` 携带离场前快照（App.tsx:1839–1848）：open 变 false 的那一帧 value 变 null，hook 回落到最后一次非空对象 | 实测离场 140ms 全程「已选 0 张」+ 2 个按钮变 disabled（`[false,true,false,true,false]`），正是该机制想防的闪烁；修后保持「已选 2 张」+ 全按钮可用 |

**该删的动效 / 简化**

| Before | After | Why |
| --- | --- | --- |
| board.css 里给 `.kb-card--dropped` 额外写了 `@starting-style`，注释称「跨列重挂载时生效」；但 BoardView 放下时总是先挂 `--dropped-start`，次帧再换 `--dropped`，节点从未「插入时即带 dropped」→ 该块永远不触发（实测 class 轨迹只见 start→dropped） | 删除该 `@starting-style` 块，只保留「次帧移除起始态」一套机制并改注释（board.css:374–387） | 死代码会误导后续维护者以为有两条路径；删掉不减功能、少一个需要同步的机制 |
| `batchbarHeld` 无效机制（同上） | 见上，改用 `usePresenceValue` 后删除 ref + effect | 简化 + 修 bug 同一处；离场快照由既有原语承担，不再手写状态机 |

**性能**

| Before | After | Why |
| --- | --- | --- |
| `.kb-drawer-overlay` 全程 `backdrop-filter: blur(2px)`（全屏），进场/离场动画期间每帧重新合成。实测（软件渲染）开：240ms 窗口 16–18 帧、3–4 帧 >20ms、p95 41.7ms；关：2–4 帧 >20ms、p95 41.7–50ms | blur 只在进场动画结束后开启（`.kb-drawer-overlay--settled`，drawer.css:18–27；DetailDrawer.tsx:96–102/158–159/289–298/335–337），离场第一帧摘掉。实测开：35–36 帧、1 帧 >20ms、p95 8.9–16.7ms；关：20–22 帧、1 帧 >20ms、p95 16.6–25ms | 全屏 blur 是动画期间唯一的掉帧源（对照：blur 永久关闭时同窗口 0 帧 >20ms、p95 9.2ms）。动画期去掉后动画窗口干净，静止期仍保留 DSH mask-blur 的设计意图 |
| 进度条用 `width` 过渡（`.kb-progress__fill` / `.kb-worklines__bar-fill`，A-07） | `transform: scaleX(var(--kb-progress))` + `transform-origin: left`（drawer.css:234–242；worklines.css:344–357；值由 DetailDrawer.tsx:452/511、WorklineView.tsx:175/182 以 0–1 变量传入） | width 每帧触发 layout+paint；scaleX 只走合成层。实测 `.kb-progress__fill` 的 transition 只有 `transform` |

**打断与时长**

| Before | After | Why |
| --- | --- | --- |
| 抽屉进场用 keyframes（`kb-fade`/`kb-slide-in`/`kb-sheet-in`），快速反向会从起点重放 | CSS 过渡 + `@starting-style`，离场 `--leaving`（drawer.css:7–70；responsive.css:358–380）；`usePresence` 180ms 窗口 | 实测「开→关(60ms)→再开」：无 leaving 残留、只有 1 个 drawer、从当前值继续（overlay opacity 1 / drawer transform none），不闪回 |
| Toast 进场用 keyframes（`kb-toast-in`） | 过渡 + `@starting-style`（base.css:777–812），离场由 `useToasts` 先标 `leaving` 再移除（Toast.tsx:20–124） | Toast 一秒内可连发；过渡能 retarget。实测连发 5 条上限保持 3 条、离场幂等（连点关闭只跑一次 140ms 淡出） |
| 卡片展开/收起是瞬时（只有一段 `kb-reveal` 入场） | 手风琴 `grid-template-rows 0fr↔1fr` + 内层 `__clip`（board.css:665–704；list.css:259–290）；`useExpandedPresence` 管挂载/起始帧/离场（KanbanCard.tsx:87–117） | 实测展开高度单调 0→213px（~180ms），收起 140ms、~151ms 卸载；连续点 3 次不闪；列表行同一套节奏 |
| 批量条进场用 keyframes / 直接卸载 | 过渡 + `@starting-style`（app.css:117–153），退出 140ms（App.tsx:105） | 实测进场 opacity+transform 180ms；离场 140ms 且指针事件立即 none |

**原点与一致性**

| Before | After | Why |
| --- | --- | --- |
| 抽屉/Toast/批量条都是「硬出现、硬消失」，没有空间连续性 | 抽屉右缘 `translateX(18px)→0`、移动端 sheet `translateY(100%)→0`；Toast/批量条进场与离场同一方向（−6px/−4px）；落位 `opacity .6→1 + scale(.98→1)` | 实测移动端 sheet 起始 `translateY(754px)`→0；落位/接收/按压实测见 8.1.3。进场与离场同路径，符合「从哪来回哪去」 |
| 审批提交后区块直接消失 | `ApprovalSlot` 保留 140ms 做 opacity+translateY(-2px) 淡出（base.css:1020–1032；ApprovalSlot.tsx；DetailDrawer.tsx:206–227 的 `approvalSlotIds` 让 slot 比数据多活 180ms） | 实测提交后 `.kb-approval-slot--leaving` 挂上，opacity 1→0.0002、translateY→-2px、140ms 卸载、180ms 后 section 移除；若直接 map 数据会连同组件一起卸载、离场帧丢失 |

**无障碍**

| Before | After | Why |
| --- | --- | --- |
| reduced-motion 下 B 级浮层被总闸压成「瞬移 + 淡出」：`.kb-batchbar--leaving` 的 translateY(-4px) 实测立刻跳到位再淡出（Toast −6px、审批 −2px 同） | RM 媒体块里给 B 级离场态补 `transform: none !important`（base.css:1001–1008），只保留 120ms 纯 opacity | 「reduced-motion = 位移即时」应当是**不产生位移**，而不是瞬跳一下；实测修后 leaving transform=none、opacity 120ms |
| RM 下位移/透明度不分级（A-08） | 总闸保留 + B 级例外（`.kb-drawer-overlay/.kb-toast/.kb-batchbar/.kb-approval-slot` 锁 opacity 120ms，base.css:982–999） | 实测：抽屉遮罩 0.12s、抽屉本体 `1e-05s`；批量条/Toast leaving `transition-property: opacity`、`0.12s`、transform none |

#### 8.1.3 实测记录（命令 + 观察值）

复跑命令（先 `node web/dev/mock-api.mjs --port 4599` + `npm --prefix web run dev`，再 headless Chromium）：

- 帧间隔（rAF）采样 + `document.getAnimations()` + `getComputedStyle`：抽屉/open 与 close、展开/收起、批量条、Toast、审批、拖拽落位、移动端 sheet。
- reduced-motion：`browser.new_context(reduced_motion="reduce")` 重放同一批场景。

关键观察值（软件渲染，1440×900 除注明）：

| 场景 | 观察 |
| --- | --- |
| 卡片展开 | 高度 0→28.7→79.3→…→213px 单调，~180ms；`transitionProperty: grid-template-rows, opacity`，均 0.18s，ease-out；收起 `.kb-card-expand--leaving` → 140ms 归零、~151ms 卸载；注入长内容（>420px）实测定格 420px 且内部滚动，无超高、无整列动画 |
| 卡片连点 | 40ms 间隔连点 3 次：状态与高度连续，无重放/无闪 |
| 抽屉开 | 220ms `opacity, transform` + ease-drawer；遮罩 180ms；焦点进入抽屉、`documentElement.overflow=hidden` |
| 抽屉关 | `--leaving` 挂上第 40ms、`aria-hidden=true`、焦点已回卡片、遮罩 140ms/抽屉 180ms、~180ms 卸载、滚动还原 |
| 抽屉快速反向 | 开→关→再开：无 leaving 残留、1 个 drawer、过渡从当前值继续 |
| 抽屉掉帧 | 修前动画窗口（240ms）16–18 帧 / 3–4 帧 >20ms / p95 41.7ms；修后 35–36 帧 / 1 帧 / p95 8.9–16.7ms；静止期仍有 2–3 帧 >20ms（blur 开启那一下） |
| 拖拽落位 | drop 后 `.kb-card--dropped` 起始 `opacity .6 / scale(.98)`，180ms 过渡到 1；`.kb-column--received` 背景 `background-color 0.22s`；~200/240ms 后类移除 |
| 批量条 | 进场 opacity+transform 180ms；离场 140ms；修前离场「已选 0 张」、修后「已选 2 张」且按钮保持可用 |
| Toast | 进场 `opacity 180ms + transform 180ms`（修前 0s）；离场 `0.14s`；连发 5 条维持 3 条；连点关闭只跑一次 |
| 审批 | 提交后 140ms 淡出（opacity 1→0.0002、translateY −2px）；按压 `:active` transform `matrix(0.97…)`，transition 含 `transform 0.12s` |
| 移动端 sheet | 420×820：起始 `translateY(754px)` → 220ms 归零；离场 180ms；遮罩 blur 只在静止后出现 |
| RM | 遮罩 0.12s；抽屉 1e-05s；批量条/Toast leaving 纯 opacity 0.12s 且 transform none；批量条计数不再闪 0 |
| 菜单/Modal（连带） | 修后 `kb-pop` 0.12s / `kb-fade` 0.18s / `kb-modal-in` 0.18s 由「静默失效」恢复为文档所述行为 |
| 静态扫描 | 无 `transition: all`、无 `will-change`、无 `scale(0)`、无内置 `ease-in`、无裸 ms（除 RM 总闸 0.01ms）；`lint:tokens` 0 错 0 警 |
| 控制台 | 修复后全流程（展开/抽屉/批量条/审批/换视图）pageerror 0、React 告警 0（仅 mock 未实现的 `/api/kanban/git/*` 两个 404，非本批回归） |

视觉证据：`.tmp/motion-shots/` 下有 M2 实现期（Lead 用 4611 构建产物）采集的截图：`normal-baseline.png`、`normal-card-expanded.png`、`normal-drawer.png`、`normal-batchbar.png`、`normal-drag-drop.png`、`reduced-motion-drawer.png`。**注意这些截图早于 M3 修复**；修复后的关键是「遮罩 blur 在动画期关闭」，对比图在会话临时目录（未入库），复核时可在真机/本机复采。

#### 8.1.4 本轮已修（file:line）

| # | 文件:行 | 修了什么 |
| --- | --- | --- |
| 1 | `web/src/styles/base.css:88–98` | 动效 tokens 从 `.kb-app-scope` 上移到 `:root`（Toast/Menu/Modal 是 body portal，拿不到 app scope 变量 → 过渡/动画整条失效）。配注释说明为何必须 :root |
| 2 | `web/src/App.tsx:1839–1848`、`2217–2232` | 删除无效的 `batchbarHeld` ref，改用 `usePresenceValue` 携带离场快照；渲染条件保留 `view !== 'workspaces'` |
| 3 | `web/src/styles/base.css:1001–1008` | RM 下 B 级离场态 `transform: none !important`（消除「瞬移再淡出」） |
| 4 | `web/src/components/DetailDrawer.tsx:96–102, 158–159, 289–298, 335–337`；`web/src/styles/drawer.css:7–27` | 全屏 backdrop-filter 改为「动画期关闭、静止后开启」（`.kb-drawer-overlay--settled`），修 P1 掉帧 |
| 5 | `web/src/styles/board.css:374–387` | 删除永远不会触发的 `@starting-style { .kb-card--dropped }`，只留「次帧移除起始态」机制并改注释 |
| 6 | `web/src/lib/usePresence.ts:88–105` | `usePresenceValue` 的「缓存最后一次非空值」从 `useEffect + setState` 改为渲染期 `ref` 记录：调用方（批量条快照）传内联对象时，旧写法会 setState→再渲染→再 setState，实测触发 React「Maximum update depth exceeded」；改后同场景 0 条告警、离场仍拿到离场前数据 |

#### 8.1.5 保留项 + 理由

| 项 | 理由 |
| --- | --- |
| 抽屉遮罩 blur 的**静止期**成本 | 修后动画窗口已干净，但抽屉打开静止时软件渲染下仍约 25ms/帧（settle 窗口 2–3 帧 >20ms；blur 永久关闭则 0 帧）。这是既有设计（DSH `--dsw-mask-blur`，与 Modal 一致），是否为了软件渲染彻底去掉抽屉 blur 属产品决策；**GPU 真机未验证** |
| 菜单/Modal 的既有效果被「连带恢复」 | tokens 上移 `:root` 后，`.kb-menu` 的 `kb-pop`（120ms）、`.kb-modal` 的 `kb-modal-in`/`kb-fade`（180ms）从静默失效恢复为 `docs/03` 已描述的行为。属同一根因修复，但超出本批逐项规格；若 Lead 不希望本批改变菜单/Modal 观感，可回退为「只在 `.kb-toast-region` 复制一份 tokens」——会形成第二套令牌来源，不推荐。这些 keyframes 是一次性入场、触发频率低，暂按保留处理 |
| 审批区块退场「只淡不塌陷」 | §6.3 规定只动 opacity/translate，因此卡片/列表内的审批消失后，垂直空间在 140ms 后瞬间收掉（抽屉内因高度固定无此问题；卡片内的塌陷为**推断**）。做高度过渡会违反 §7「不做 layout 动画」预算，保留为已知取舍 |
| 其余残留 keyframes | `kb-fade`（Modal 遮罩）、`kb-sheet-in`（移动端 Modal 底部弹层）、`kb-modal-in`、`kb-pop`（菜单）、`kb-card-highlight` / `kb-list-item-highlight`（1.8s 一次性来源高亮，RM 下降级为静态描边）、`kb-spin` / `kb-breathe` / `kb-dot-pulse`（恒定循环）。均有正当理由或超出本批范围 |
| `docs/11 §5` 与实际签名的小漂移 | §5 未写 `usePresence` 的第三个参数。实现为 `usePresence(open, exitMs, { keepInReducedMotion? })` / `presenceExitMs(exitMs, reducedMotion, keep)`（`web/src/lib/usePresence.ts:24`（`presenceExitMs`）/ `:39`（`usePresence`）/ `:92`（`usePresenceValue`）），有单测覆盖；本轮按约束只追加 §8，未改 §5 |
| `.kb-card-expand` 与 `.kb-card-expanded` 双份 `max-height: 420px` | 外层是兜底、内层管内部滚动，冗余但无害；去掉外层反而失去「1fr 解析异常」的保护，保留 |

#### 8.1.6 未实测 / 需真机或宿主验证

- **GPU 硬件下的 60fps**：本机 Chromium 为 SwiftShader 软件渲染，帧数据只作下限参考；「动画窗口 1 帧 >20ms」不代表真机，需 Lead 在真机构建里复测（DevTools Performance 录制）。
- **宿主页返回气泡的 `@starting-style` 进场**（`lib/client.js:131–135`）：需要 DSH 宿主真实 Composer 环境，静态审查为「气泡由 React 条件渲染、插入即带初始态，`@starting-style` 会生效」；`--ds-transition-duration-fast`/`--ds-ease-out` 的兜底写法符合 §3.3，**未实测**。
- **`prefers-reduced-motion` 下的平滑滚动降级**（`App.tsx:522–525`）：需要「从会话返回看板」流程，静态审查通过，**未实测**。
- **2000 卡规模**：未造 2000 卡数据；「不做 FLIP、无逐卡 stagger、只动 GPU 属性」是架构性保证，非实测。

---

## 9. 变更记录

| 日期 | 内容 | 结果 |
| --- | --- | --- |
| 2026-11-02 | M1 审计完成：本文件建立；`--kb-ease-in-out`/`--kb-ease-drawer`/`--kb-dur-press`/`--kb-dur-exit{,-slow}` 入 `styles/base.css`；`usePresence` 原语 + 单测；reduced-motion 改两级 | 待实现 |
| 2026-11-02 | M2 六项实现 + M3 独立审查（§8.1）：修复 Toast/Menu/Modal 的 tokens 作用域（Block）、批量条离场快照（Block）、RM 下 B 级浮层瞬移、抽屉全屏 blur 掉帧（P1）；删除 1 处死 `@starting-style`。tsc/vitest(477)/lint:tokens 全绿 | Approve（修复后），保留项见 §8.1.5 |
