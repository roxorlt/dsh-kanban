# DSH 看板 · DESIGN.md（视觉唯一事实源）

> 版本：v1.1（2026-11-02，对齐 impl-visual 批次 2 落地） · 适用：`web/`（DSH 看板面板）与宿主页「返回看板」气泡的视觉层
> 读者：改 `web/src/styles/*`、`web/src/components/*` 视觉、`lib/client.js` 宿主气泡样式的人
> 一句话：**先读本文件，再读 docs/03 的上下文；与 docs/03 冲突时以本文件为准，并在同一次变更里回写 docs/03。**

## 0. 定位与优先级

本文件是看板视觉规则的单一事实源：颜色、字体、间距、圆角、描边、浮层、组件视觉、动效预算摘要、验收门槛都在这里。

| 优先级 | 内容 | 冲突时怎么办 |
|---|---|---|
| 1 | 本文件（VISUAL SOURCE OF TRUTH） | 与 docs/03 冲突 → 以本文件为准，同 PR 回写 docs/03 对应小节 |
| 2 | 动效事实：**`docs/11-motion.md` 是动效唯一事实源**（时长/曲线/逐项规格/`usePresence`/审查门槛） | 动效规则与 §5 摘要冲突 → 以 docs/11 为准，并改正本文件 §5 的摘要；docs/03 §4.4 已指向它 |
| 3 | 代码事实：`web/src/styles/base.css`（`--kb-*` 定义）、`web/src/styles/tokens.css`（`--dsw-*` 兜底） | 本文件与代码令牌名/取值不一致 → 以代码为准并修正本文件 |
| 4 | `docs/03-design-system.md`：信息架构、术语、交互细则、已拍板决定 | 只补充上下文，不覆盖本文件 |
| 5 | `docs/10-visual-audit.md`：审计批次、验收口径、对比度实测 | 验收口径的出处，§6 引用 |

**不覆盖的范围**：产品与数据契约（docs/03 §2/§7、`docs/contracts/`）、接口与状态机、审批/选择/开始推进的语义。视觉规则不得用来绕过这些决定；需要改产品语义时走决策流程，而不是改样式。

## 1. 设计原则

| # | 原则 | 落地检查 |
|---|---|---|
| 1 | **令牌纪律**：组件 CSS 只用 `--dsw-alias-*` / `--dsw-font-*` / `--kb-*`，不写 hex/rgb、渐变、`transition: all` | `lint:tokens` 0 error / 0 warning；组件 CSS 无字面色 |
| 2 | **单一主色 + 黑主按钮**：表面全中性，强调只有业务蓝与琥珀；主按钮用 `--dsw-alias-button-primary-fill`（黑底） | 全页最多两种强调色；不引入第二品牌色 |
| 3 | **密度服从信息任务**：折叠卡承载 80% 信息；正文 13、meta 11–12；审批选项例外——必须完整展开 | 不靠放大字号换「高级感」；不靠隐藏字段换密度 |
| 4 | **状态必须可读且不只靠颜色**：状态点 + 中文状态词 + 原因；可读文字 ≥4.5:1 | 每个状态点都有文字；对比度见 §2.6 |
| 5 | **动效克制可降级**：只给「状态变化」和「浮层进出」；UI 动效 ≤220ms；`prefers-reduced-motion` 两级降级 | 过不了 §5.1 频率闸门就不加 |
| 6 | **安全区不可移除**：宿主 inset、`env(safe-area-inset-bottom)`、`dvh` 都在规则内 | 不换成固定 padding；390 与 iframe 都要验 |
| 7 | **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.** | 弹窗、区块、表单与开关不堆砌解释性副标题、导语、二次说明和宣传注脚；靠布局、状态点与控件自解释 |

**视觉签名**：发丝线（0.5px 中性实线）、无边框浮层 + elevation、黑主按钮、状态点睛、安静的产品密度。**反模式**：紫色渐变、玻璃拟态、营销字体、大 hero、堆叠卡片阴影、彩色左条。

## 2. 令牌体系

### 2.1 三层令牌（定义在哪、谁能改）

| 层 | 位置 | 规则 |
|---|---|---|
| DSH alias `--dsw-*` | 宿主 ThemePresenter 注入；`web/src/styles/tokens.css` 存亮/暗兜底镜像 | **只消费、不定义**；本插件不写 `--dsw-*`；tokens.css 里的字面色属主题镜像，`lint-tokens-ignore` 已标 |
| 看板语义 `--kb-*` | `web/src/styles/base.css` 的 `.kb-app-scope`（部分尺寸由 `responsive.css` 覆盖） | 可新增；只引用 alias 或 `color-mix`；命名 `--kb-<域>-<语义>`；亮/暗两套由 alias 自动切换 |
| 组件局部变量 | 组件规则内，如 `--kb-r-*` / `--kb-gap` / `--kb-pad-x` / `--kb-git-lane-*` | 只放尺寸/节奏/图形色槽，不放颜色字面量 |

> 注意：`tokens.css` 只镜像 `--dsw-*`；`--kb-*` 的实际定义在 `base.css`，不要把新令牌写到 tokens.css。

### 2.2 背景与表面

| 令牌 | 用途 | 什么时候用 / 不要用 |
|---|---|---|
| `--dsw-alias-bg-base` | 应用底、看板底 | 页面最底层；不要直接当卡片底 |
| `--kb-surface-column` | 列底（3% `label-primary` 叠 `bg-base`） | 所有列；不要改成纯 `bg-base` 或加深超过 6% |
| `--kb-surface-card` / `--dsw-alias-bg-layer-1` | 卡片面、列表展开区 | 卡片与可展开内容；不要在列底上再叠 `layer-2` |
| `--dsw-alias-bg-layer-2` / `-layer-3` | 次级/三级浮层（菜单、底弹、抽屉内浮块） | 浮层；不要用于静态内容区 |
| `--dsw-alias-bg-module-platform` / `--dsw-specific-sidebar-fill` | 宿主同款侧栏/模块底 | 需要与 DSH 外观一致时；不要自造近白色 |
| `--dsw-specific-menu` / `--dsw-specific-input-major` / `--dsw-specific-selector` / `--dsw-specific-tip` | 菜单、输入框、分段控件、提示条表面 | 对应控件；不要拿卡片底凑 |
| `--dsw-alias-bg-skeleton` | 骨架填充 | 仅首屏加载；不要用于禁用态 |
| `--dsw-alias-bg-mask-2` + `--dsw-mask-blur` | 抽屉/底部弹层遮罩 | 浮层遮罩默认；`mask-3` 只留给全屏 Modal/确认框 |
| `--dsw-alias-bg-overlay` | 覆盖底（图表 hover 等） | 数据图形；不要用于文字背景 |

### 2.3 文字层级

| 令牌 | 用途 | 什么时候用 / 不要用 |
|---|---|---|
| `--dsw-alias-label-primary` | 标题、正文、关键数字 | 任何需要读的主信息；不要承载说明/元数据 |
| `--dsw-alias-label-secondary` | 说明、摘要、**可读元数据**（≥4.5:1） | 11–12px 且承载信息时用；不要用于装饰 |
| `--dsw-alias-label-tertiary` | 弱化但仍可读的次级信息 | 列英文副标、时间（12px+）；11px 正文慎用（浅色仅 3.71:1） |
| `--dsw-alias-label-caption` | 装饰、禁用、占位 | 只用于装饰性分隔/禁用文字；**不要承载可读信息**（浅色 2.13:1） |
| `--dsw-alias-label-dimmed` | 极弱分隔线/斑马纹 | 仅装饰 |
| `--dsw-alias-label-primary-foreground` | 主按钮文字 | 只配 `--dsw-alias-button-primary-fill`（黑底白字 / 暗色黑字） |
| `--dsw-alias-label-primary-inverted` / `-dimmed` | 反色表面上的文字 | 反色块内；不要用于普通背景 |
| `--dsw-alias-link` | 链接图形/下划线/图标 | 装饰性链接元素；不要当按钮填充色 |
| `--kb-link-text` | 11–12px 可读链接文字（`light-dark()`：浅色向 `label-primary` 收敛、暗色沿用） | 链接/会话入口文字；不要用于大段正文 |

### 2.4 描边与交互

| 令牌 | 用途 | 什么时候用 / 不要用 |
|---|---|---|
| `--kb-hairline`（= `--dsw-alias-border-l2`） | 卡片/输入/列表分隔 | 中性实线**一律 0.5px**；不要加粗或双层 |
| `--dsw-alias-border-l1` | 更弱的结构分隔（列外框、工具条下边） | 结构与区块分隔 |
| `--dsw-alias-border-l3` / `-l4` | hover/强化分隔 | 卡片 hover 提边框；不要用于静态卡片 |
| `--dsw-alias-interactive-bg-hover` / `-active` | 行/幽灵按钮/菜单项悬停与按下 | 列表行、按钮；不要用于大面积卡片底 |
| `--dsw-alias-interactive-bg-hover-solid` | 需要实色悬停的浮层项 | 浮层菜单项；不要叠在彩色底上 |
| `--dsw-alias-interactive-bg-hover-danger` | 危险操作 hover 底 | 归档/删除类；不要用于普通按钮 |
| `--dsw-alias-interactive-bg-hover-accent` | 强调 hover | 选中/强调项，谨慎使用 |
| `--dsw-alias-button-primary-fill` / `-hover` / `-dimmed` | 主按钮三态 | 新建/保存/提交；**不要用业务蓝当主按钮** |
| `--dsw-alias-button-elevated-fill` / `-floating-fill` / `-floating-hover` / `-ghost-active-fill` / `-contrast-fill` | 浮起按钮、幽灵选中、对比按钮 | 对应形态专用；不要混用 |
| `--kb-disabled-border` / `--kb-disabled-fill` | 禁用按钮的可辨边界 / 浅底（对淡色底 ≥3:1） | 禁用态；不要拿半透明 `border-l2` 当禁用边界 |
| 焦点环（全局 `:focus-visible`） | `2px solid var(--dsw-alias-state-business-primary)`，`outline-offset: 2px` | 键盘焦点；不要移除、不要换色 |

### 2.5 状态与业务色

| 令牌 | 用途 | 什么时候用 / 不要用 |
|---|---|---|
| `--kb-status-backlog` | 待办状态点（空心环） | 点/图标；**不要当正文文字**（浅色对比不足） |
| `--kb-status-running` | 进行中/会话活动**色点** | 点、线、图标、选中左标；不要直接写 11–12px 正文 |
| `--kb-status-running-text` | 进行中**文字**（`light-dark()`：浅色 84% 收敛，暗色沿用） | 状态文字、会话活动文案；不要用于大面积背景 |
| `--kb-status-needs` | 待你确认（琥珀）**色点** | 点/图标/浅底公式；不要直接当正文 |
| `--kb-status-needs-text` | 待你确认**文字**（浅色 68% 收敛，暗色沿用 warn-label） | 状态文字、审批风险文案；不要用于大面积背景 |
| `--kb-status-done` | 已完成（绿）**色点** | 点/图标；正文用 `--kb-status-done-text` 或 `label-secondary` |
| `--kb-status-done-text` | 已完成**文字**（浅色 60% 收敛，暗色沿用 success） | 完成摘要/状态文字；不要用绿色写长正文 |
| `--kb-status-failed` | 受阻/失败（红）**色点** | 点/图标/错误描边；不要用红色写长正文 |
| `--kb-status-failed-text` | 受阻/失败**文字**（浅色 88% 收敛，暗色沿用 error） | 失败/风险文案；不要用于大面积背景 |
| `--dsw-alias-state-warn-tertiary` | 审批分区浅底、待确认浅底 | 审批分区底；不要在卡里再包一层卡 |
| `--dsw-alias-state-business-tertiary` | 主会话徽标、同步底 | 徽标/选中底；不要用于大块背景 |
| `--dsw-alias-state-success-tertiary` | 完成提示浅底 | 成功条 |
| `--dsw-alias-brand-primary` / `--dsw-alias-brand-text` | 品牌色（与主按钮同值，黑） | 只与主按钮配套；不要引入第二品牌色 |
| `--kb-git-lane-0` … `--kb-git-lane-7` | 抽屉内 Git 分支图 8 色槽 | **只用于图形**（连线/圆点/图例）；不要映射成状态语义 |
| `--kb-fork-color` | 分支图当前色槽（`.kb-git__fork-cN` 注入） | 分支图内部使用，不要外泄到其它组件 |

**派生色只允许以下公式**（其余参考 [docs/03 §3.2](docs/03-design-system.md)）：

| 用途 | 公式 |
|---|---|
| 进行中列底 / 待你确认列底 / 拖拽目标列 | `color-mix(in srgb, var(--kb-status-running) 3%, var(--kb-surface-column))` / `--kb-status-needs` 5% / `--kb-status-running` 9% |
| 卡片 hover | `color-mix(in srgb, var(--dsw-alias-label-primary) 1.5%, var(--kb-surface-card))` + 边框升 `border-l3` |
| 选中卡/选中行 | `inset 0 0 0 2px var(--dsw-alias-state-business-primary)` + 4–6% 业务蓝底 |

**状态文字构造规则**（`--kb-status-*-text` 定义在 `base.css`，统一用 `light-dark()`；百分比为离线计算 + 浏览器实测校准值）：

| 令牌 | 亮色（`color-mix` 向 `--dsw-alias-label-primary` 收敛） | 暗色 |
|---|---|---|
| `--kb-status-running-text` | `state-business-primary` 84% | 沿用 `state-business-primary` |
| `--kb-status-needs-text` | `state-warn-label` 68% | 沿用 `state-warn-label` |
| `--kb-status-done-text` | `state-success-primary` 60% | 沿用 `state-success-primary` |
| `--kb-status-failed-text` | `state-error-primary` 88% | 沿用 `state-error-primary` |

实测（11–12px 文字，口径见 docs/10 附录 A.1）：亮色 running 5.11 / needs 5.18 / done 5.49 / failed 5.43；暗色 4.77–6.89，全部 ≥4.5:1。调百分比时必须重测并回写本节。

### 2.6 颜色硬规则（对比度）

1. **可读正文/说明 ≥4.5:1**：11–12px 且承载信息（摘要、状态词、风险文案、计数、hint）一律按 WCAG AA 正文处理；**装饰 ≥3:1**，`caption` 仅限装饰/禁用。
2. **浅色语义色文字必须收敛**：高饱和状态色直接当 11–12px 正文只有 2.28–3.08:1。文字色统一用 `--kb-status-*-text` 语义令牌：`light-dark()` 浅色分支 = `color-mix` 向 `--dsw-alias-label-primary` 收敛（running 84% / needs 68% / done 60% / failed 88%），实测 5.11–5.49:1；**不在组件里临时混任意比例**。
3. **暗色已达标则沿用**：`light-dark()` 暗色分支直接用语义色，实测 4.77–6.89:1，不再收敛（避免发灰）；暗色不得回退。
4. **颜色不能是唯一状态标识**：状态点必须配中文状态词；受阻/失败有原因；审批选项有图标 + 说明；选中态同时有描边/底色/文字。
5. **禁止**：组件 CSS 字面色（hex/rgb）、渐变、第二品牌色、用 `caption` 承载信息。`tokens.css` 的字面色属主题镜像例外。

### 2.7 字体层级

| 角色 | 规格 / 令牌 | 用途 | 不要 |
|---|---|---|---|
| 页/顶栏当前标题 | **16/22/600** + `--dsw-font-family`（已落地 `app.css`，竖屏保持） | 页面级标题（`.kb-crumb-current` 等） | 不要回到 13–15/500（层级低于/等于卡片标题） |
| 卡片标题 | `--dsw-font-s-strong-14`（14/22 500）+ `line-height: 20px` | 折叠卡标题 | 不要 <14 或 600（与页标题抢层级） |
| 分区/列头 | **12/16/600 + `letter-spacing: 0.02em`**；从 `--dsw-font-xxs-strong-12` 起手并覆盖行高/字重 | 列头、列表组头、抽屉分区 | 不要 11px + tertiary（不可读） |
| 正文/摘要 | `--dsw-font-xs-13` / `--dsw-font-s-14` | 摘要、选项说明、输入 | 不要整体放大破坏密度 |
| 按钮/Tab | `--dsw-font-xxs-strong-12` | 按钮文字 | 不要大写/加大字距 |
| 列名/Tab（英文副标） | `--dsw-font-xs-strong-13` | 列名、Tab | 不要营销字体 |
| 元信息 | `--dsw-font-xxxs-11` / `--dsw-font-xxs-12` | 耗时、计数、标签、徽标 | 不要用 `caption` 承载信息 |
| 等宽 | `--ds-font-family-code` + `--dsw-font-xxxs-11` | session id、路径、迁移号 | 不要换成装饰性字体 |
| 数字 | `font-variant-numeric: tabular-nums` | metrics、耗时、时间、计数 | **不要为「柔和」去掉**（D-14） |

复合令牌实况：`tokens.css` 定义了 `--dsw-font-family`、`--dsw-font-xxxs-11`、`--dsw-font-xxs-12`、`--dsw-font-xs-13`、`--dsw-font-s-14`、`--dsw-font-xs-strong-13`、`--dsw-font-s-strong-14`、`--dsw-font-l-20`；`--dsw-font-xxxs-strong-11` / `--dsw-font-xxs-strong-12` 由宿主提供（tokens.css 未镜像，独立预览时需注意回落）。字体栈固定为 DSH 系统字体，**不引入外部字体**。

### 2.8 间距、密度与布局常量

| 常量 | 值 | 落点 |
|---|---|---|
| `--kb-gap` | 12px（≥1440 可 16） | 列间距、区块间距 |
| `--kb-pad-x` | 16px（<720 时 12px） | 工具条/页面水平 padding |
| 顶栏高度 | 52px（嵌入模式 `--kb-topbar-h`）；竖屏 `auto` + min 48 | `.kb-topbar` |
| 工具条高度 | 48px；竖屏 `auto` + min 48（搜索整行、`order:-1`） | `.kb-toolbar`；**窄屏禁止固定高度** |
| 列头高度 | min 40px | `.kb-column-head` |
| 卡片 | padding **10×12**（≤1439 10×10），卡间 8，卡内 gap 6，圆角 `--kb-r-card` | `.kb-card` |
| 列表行 | min-height **58px**（56–64 区间），padding 10×12，组头 36px；内容主栏 `max-width: 1180px` 居中 | `.kb-list__row` / `.kb-list` |
| 间距阶梯 | 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 | 卡片内 4–10，区块 16–20 |
| 抽屉宽度 | `clamp(400px, 36vw, 520px)` | `.kb-drawer` |
| 底部弹层 | `min-height: 42dvh`，`max-height: 92dvh` | 竖屏详情 |
| 触控热区 | **≥44×44**（可保持视觉尺寸，用 padding/`::before` 扩展） | 390px 主决策、菜单、关闭、复选框 |

### 2.9 圆角

| 令牌/值 | 用途 | 什么时候用 / 不要用 |
|---|---|---|
| `--kb-r-col` = 14px | 看板列 | 只用于列；不要用于卡片或按钮 |
| `--kb-r-card` = 12px | 卡片、列表分组 | 卡片/分组；不要把浮层做成 12 |
| 10px | 浮层（菜单、Toast、抽屉内浮块） | 浮层专用；不要用于卡片 |
| `--kb-radius-lg` = 16px（modal.css fallback） | Modal；底部弹层上两角 | 只用于 Modal/竖屏弹层 |
| `--kb-r-ctl` = 8px | 按钮、输入、控件 | 控件级；不要用于容器 |
| 5px | 徽标 | 小徽标/标签 |
| 50% / 99px | 全圆必须配 `corner-shape: round`（已用于状态点/圆点） | 仅圆点/头像；不要给卡片做全圆 |

### 2.10 浮层与 elevation

| 令牌 | 用途 | 规则 |
|---|---|---|
| `--dsw-elevation-panel` | 菜单、筛选浮层、Toast 容器、抽屉内浮块 | `border: 0` + 阴影（阴影自带 0.5px 环） |
| `--dsw-elevation-prominent` | 抽屉、Modal、确认框 | 同上，层级更高一档 |
| `--dsw-elevation-soft` | 大面积浮层（按需） | 不叠加描边 |
| `--dsw-shadow-lv1` | 分段控件选中指示 | 宿主令牌（tokens.css 未镜像） |
| `--dsw-shadow-lv2` | 兜底阴影 | 仅确认框类小面积 |

**浮层铁律**：所有浮层 `border: 0` + elevation，不叠描边；静态卡片**不用阴影**，只用发丝线 + hover 1.5% 提亮。

## 3. 组件规则

| 组件 | 结构与样式约束 | 不可改项 |
|---|---|---|
| **看板列** `.kb-column` | 固定 4 列；`--kb-surface-column` + 0.5px `border-l1` + `--kb-r-col`；列头 min 40（状态图标 + 中文名 + 英文副标 + 计数 + 折叠 + 新建）；列内独立滚动；列底 3%/5%/9% 状态色公式；空列可投放 | 不增删列；受阻/失败不单独开列（归待你确认）；列头不悬浮、不加侧边导航 |
| **卡片** `.kb-card` | 0.5px `border-l2` + `--kb-r-card` + `--kb-surface-card` + padding 10×12 + gap 6；标题→摘要→当前动作→属性→页脚；hover 1.5% 提亮 + `border-l3`；选中 `inset 2px` 业务蓝；失败/受阻卡 `inset 1px` 错误色；状态点标题首行中线、页脚 6px | 不加卡片阴影、不加彩色左边条、不把审批包成「卡中卡」；折叠卡承载 80% 信息 |
| **列表行** `.kb-list__row` | 状态点 + 标题 + 摘要 + 指标 + 动作簇 + 详情；**状态文字只出现一处**；宽屏行高 58（56–64 区间）、内容收进 `max-width: 1180px` 主栏 + meta 右栏，390 堆叠单列；折叠行快捷动作固定宽右对齐、窄屏换行左对齐；展开后隐藏行首动作簇 | 不改瀑布流；不复制状态信息；不隐藏字段（可重排）；不把动作做成多级菜单 |
| **抽屉** `.kb-drawer` | 桌面右侧 `clamp(400px, 36vw, 520px)`，竖屏底部弹层；header = kicker + 标题 + 编辑/归档/关闭；摘要独占第二行且与正文同宽；footer 用 `env(safe-area-inset-bottom)`；`role=dialog aria-modal` + 焦点圈定 + Esc/蒙层关闭 + 关闭归还焦点；离场 140/180ms | 不改全屏 Modal；不移除摘要行或主操作；不改焦点/安全区行为 |
| **审批** `.kb-decision*` + `.kb-approval-slot` | 作为卡片内**分区**，不再包卡；一张卡最多一个展开审批，其余一行摘要；单/多题字段、选项说明、备注、驳回/提交语义完整；风险文字用 `--kb-status-needs-text`；提交后 `.kb-approval-slot--leaving` 140ms 淡出 | 不折叠选项、不删选项说明、不改字段与提交语义；视觉权重低于卡片标题 |
| **批量条** `.kb-batchbar` | 选择模式出现：已选 N / 全选当前视图 / 清空 / 移动到 / 归档 / 取消；0 选时移动与归档禁用；竖屏换行、按钮 ≥36 高；离场 140ms | 不拆多级菜单；不在选择模式启用拖拽；不改变已选项语义 |
| **工具栏** `.kb-toolbar` | 48 高（竖屏 auto + min 48，搜索整行）；左侧搜索/筛选，右侧视图切换/主题/帮助；下边 0.5px `border-l1`；计数分隔 0.5px | 不恢复顶栏全局「新建卡片」；不加全局刷新按钮；窄屏不得固定高度 |
| **空态** `.kb-empty` | 说明「这里会出现什么」+ 下一步行动；全列无结果时只出现**一个**全局空态 + 一个清空入口；局部空态收为一行；列内空态只留「这一列还没有卡片」+ 新建入口（v0.26.1 起） | 不加营销插画/hero/彩色渐变背景；不重复四份 CTA；**列内空态不写跨列拖拽 / 「让 Agent 领取任务」等做不到的动作说明** |
| **加载** `.kb-skeleton*` | 骨架只在列内/内容区；首屏顶栏计数不显示 0，筛选/选择/新建在数据到达前置禁用；仅骨架呼吸动画 | 不用 spinner 替代骨架；不与空态视觉混淆；不给列表加 stagger |
| **错误** `.kb-error` / `.kb-errorbar` | 中文用户文案 + 诊断信息折叠；重试热区 ≥44；SSE 断线 ≤2s 出现可见状态（文案 + dot + 可点重试），恢复自动清除，`aria-live` 播报 | 不暴露英文原文/dev 命令/错误码到主文案；错误重试只放错误条内 |

## 4. 「不该改」清单（D-01 … D-14）

以下 14 条对应 [docs/10 §4](docs/10-visual-audit.md)，每条都是禁令；为「更高级」而违反会被打回。

1. **D-01 令牌与颜色纪律**：组件 CSS 只用 `--dsw-alias-*` / `--kb-*`；不写 hex/rgb、渐变、紫色、玻璃拟态（`tokens.css` 的主题兜底镜像除外）。
2. **D-02 单一主色 + 黑主按钮**：不引入第二个品牌色或营销渐变；语义色只做状态点。
3. **D-03 字体来源**：保持 DSH 系统字体栈，不引入 Geist/Satoshi 等外部字体替换中文界面，只调现有令牌的字号/字重。
4. **D-04 边框/圆角/浮层**：中性 0.5px 边框不动；浮层无边框 + elevation；不加粗边框、不加大面积阴影。
5. **D-05 看板结构**：固定 4 列、待你确认承载受阻/失败、列头计数、列内新建、拖拽换列；不改 5 列、不加侧边导航。
6. **D-06 列表结构**：状态/项目/优先级三档分组、组内折叠、宽屏行式布局；不改瀑布流。
7. **D-07 新建入口**：看板只用列头 `+`，列表只用工具条主按钮；不恢复顶栏全局「新建卡片」。
8. **D-08 批量选择结构**：工具栏「选择」+ 复选框 + 批量条组件 + 拖拽禁用 + Esc 退出；不拆成多级菜单。
9. **D-09 审批结构**：单题/多题字段、统一备注与提交、逐题校验、选项说明完整；不为简洁删说明。
10. **D-10 开始推进层级**：待办 footer 次级 → 展开主按钮 → 卡片菜单三级；不提升为顶栏全局按钮。
11. **D-11 暗色/focus-visible/reduced-motion/快捷键**：保留现有 1px/2px focus ring 与动效降级，不删不改弱。
12. **D-12 安全区**：`.kb-app--embedded` 用 `--kb-host-inset-top` 留宿主左上控件，抽屉/Modal footer 用 `env(safe-area-inset-bottom)`；不移除、不换固定 padding。
13. **D-13 加载/空/错误结构**：保留骨架、空态、初始错误页；不加入营销式插画/大 hero/彩色渐变背景。
14. **D-14 tabular 数字**：metrics、耗时、时间已用 `font-variant-numeric: tabular-nums`；不为「柔和」去掉。

## 5. 动效预算

> **动效细则以 [docs/11-motion.md](docs/11-motion.md) 为唯一事实源，本节只保留预算摘要**（docs/03 §4.4 已改为指向该文件；docs/09 是技能调研记录，不是动效预算来源）。本节数值与 `base.css` `.kb-app-scope` 令牌实值一致；若与 docs/11 或代码不一致，以 docs/11/代码为准并同步改正本节。

### 5.1 频率闸门（先判断该不该动）

| 频率 | 允许的动效 |
|---|---|
| 100+ 次/天（快捷键、搜索、筛选、列表渲染、键盘焦点） | **不加动效** |
| 几十次/天（hover、行导航） | 只允许 ≤120ms 的微反馈，或不动 |
| 偶发（抽屉、弹层、Toast、批量条、卡片展开） | 标准动效 120–220ms |
| 罕见/首次（来源高亮、成功反馈） | 一次性强调 ≤1.8s，仅颜色类（delight 预算） |

每个动效必须能说出目的（feedback / spatial consistency / state indication / prevent jarring change / explanation / delight），说不出就不加。

### 5.2 时长阶梯（只允许这六档）

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--kb-dur-press` | 120ms | 按压回弹（`:active` scale 0.97）、hover 颜色 |
| `--kb-dur-fast` | 120ms | 小浮层（菜单/筛选）、chevron 旋转、纯颜色反馈 |
| `--kb-dur` | 180ms | 卡片展开进入、Toast 进入、批量条进入、拖拽落位 |
| `--kb-dur-slow` | 220ms | 抽屉进入、底部弹层进入 |
| `--kb-dur-exit` | 140ms | Toast/批量条/卡片收起离场 |
| `--kb-dur-exit-slow` | 180ms | 抽屉/底部弹层离场 |

**退出比进入快一档**：系统响应要跟手；展开需要自解释，收回不需要再讲一遍。**UI 动效一律 ≤220ms**，唯一例外是来源高亮 1.8s。

### 5.3 曲线（只允许这三条）

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--kb-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 所有进入/退出 |
| `--kb-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | 屏幕内移动（跨列落位、位置重排） |
| `--kb-ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | 抽屉、底部弹层 |

**禁止**：内置 `ease`（太弱）、`ease-in`（在最受关注时拖慢）、线性（除非恒定运动如 progress/spinner）、`transition: all`、`scale(0)` 入场、keyframes 用于 Toast/开关类。宿主页注入元素（`lib/client.js` 的返回气泡）用 DSH 的 `--ds-transition-duration` / `--ds-transition-duration-fast` / `--ds-transition-duration-slow` / `--ds-ease-in-out`，**不要把 `--kb-*` 带进宿主页**。

### 5.4 reduced-motion（两级，不是一刀切）

| 级别 | 内容 | RM 下 |
|---|---|---|
| A 级：位移/缩放/高度 | 抽屉滑入滑出、底部弹层、卡片展开高度、拖拽落位、Toast/批量条位移 | **即时完成**（0ms） |
| B 级：纯透明度/颜色 | 遮罩、Toast、批量条淡变 | **保留 120ms 淡变**（只动 `opacity`，锁 `transition-property`） |

实现：`base.css` 末尾的总闸（`0.01ms !important`）保留；B 级例外写在同一个 `@media (prefers-reduced-motion: reduce)` 块里，用更具体选择器 + `!important` 压过总闸；JS 侧退出等待由 `presenceExitMs` 压到 0。来源高亮用静态描边。

### 5.5 性能预算（60fps）

- 只动 `transform` / `opacity`；唯一例外：卡片展开高度（手风琴，≤420px）。
- 不申请常驻 `will-change`；不做 FLIP、不做整列重排、不做逐卡 stagger。
- 同一时刻最多一个长动画在跑；`animation` 只用于恒定循环（呼吸/脉冲）与一次性强调，交互驱动一律 `transition`。
- 退出用 `usePresence`（CSS 过渡，不用 keyframes，可被打断）；`exitMs` 必须与 CSS 令牌同值。
- 进度条用 `transform: scaleX()` + `transform-origin: left`，不用 `width`。
- 2000 卡规模下的 60fps 是**架构性保证**，报告里必须写「未实测」而非「已达标」。

## 6. 验收与回归

### 6.1 必验矩阵

| 视口 | 尺寸 | 重点 |
|---|---|---|
| 宽屏 | 1440×900 | 四列密度、列表行高与扫视路径、抽屉宽度 |
| 紧凑 | 1024×768 | 列宽压缩、隐藏英文副标、动作区 56px |
| 窄屏 | 390×844 | 工具栏不重叠、触控热区 ≥44、底部弹层、安全区 |
| 宿主 iframe | ≥1280 宽 + top inset | 顶栏避让宿主控件、主题令牌跟随、无横向溢出 |

亮/暗双主题都要过（跟随/亮/暗三态）；暗色不得回退。**新界面改动必须同时给「亮/暗 × 宽/窄」四张证据**（1440 亮、1440 暗、390 亮或暗、iframe 一张），动效改动另附 `document.getAnimations()` 输出或录屏。

### 6.2 必跑命令

```bash
npm --prefix web run lint:tokens   # 0 error / 0 warning（当前 11 个 CSS 文件）
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build         # 交付前
```

### 6.3 批次与验收口径

- 三个批次与逐项验收标准见 [docs/10 §5](docs/10-visual-audit.md)：批次 1 移动端可用性与状态可感知、批次 2 浅色可读性与视觉层级、批次 3 状态细节与一致性。
- 对比度抽样清单见 [docs/10 附录 A.1](docs/10-visual-audit.md)；窄屏工具栏/触控目标见附录 A.2/A.3；批次 checklist JSON 见附录 B。
- 动效审查门槛（Block 条件）见 [docs/11 §8](docs/11-motion.md)，用 `review-animations` 独立审查，不接受「能跑就算过」。

### 6.4 回归红线

1. 不改数据契约、接口、状态机。
2. 不改安全区（宿主 inset / `env(safe-area-inset-bottom)` / `dvh`）。
3. 不引入外部字体、渐变、第二品牌色。
4. 不新增顶栏全局新建入口、不加全局刷新按钮。
5. 不改变审批/批量选择/开始推进的语义与字段完整性。
6. 视觉改动不降低既有对比度（暗色不回退）。

## 7. 变更流程

1. **先改本文件，再改代码**：规则/令牌/验收标准变化先落到 DESIGN.md（表格 + 一句理由），再动 `web/src`。
2. **令牌先行**：新令牌必须先在 `base.css` `.kb-app-scope`（看板语义 `--kb-*`）定义，经 `--dsw-alias-*` 自动获得亮/暗两套；命名 `--kb-<域>-<语义>`。**禁止在组件 CSS 里新增字面色或临时混色**。
3. **同源更新**：动效令牌/退出时长变更要同时改 `docs/11-motion.md`、`usePresence` 常量与 CSS 令牌；视觉规则变更要在同一次变更里回写 docs/03 对应小节（或标注「以 DESIGN.md 为准」）。
4. **自检**：`lint:tokens` 0/0、`typecheck`、`test`、`build` 全绿；`grep -rn '#' web/src/styles --include="*.css"`（除 tokens.css）应为空。
5. **证据**：按 §6.1 附四张视口/主题截图；动效附审查结论。
6. **冲突升级**：产品语义/数据契约冲突不改本文件，回到 docs/03 §10.3 的已拍板记录或重新决策。

## 附录 A · 令牌清单与权威来源

### A.1 令牌清单（全量 `--kb-*` 语义令牌）

| 组 | 令牌 | 定义位置（事实源） | 用途 |
|---|---|---|---|
| 圆角/间距 | `--kb-r-card` / `--kb-r-col` / `--kb-r-ctl` / `--kb-gap` / `--kb-pad-x` | `base.css` `.kb-app-scope`（`--kb-gap`/`--kb-pad-x` 另由 `responsive.css` 覆盖） | 卡片/列/控件圆角、列间距、水平 padding |
| 顶栏/安全区 | `--kb-topbar-h` / `--kb-host-inset-top` | `base.css` `.kb-app--embedded` / 桥运行时注入（样式用 `var(..., 0px)` 兜底） | 嵌入模式顶栏高、宿主左上安全区 |
| 表面/描边 | `--kb-surface-column` / `--kb-surface-card` / `--kb-hairline` | `base.css` | 列底、卡面、0.5px 发丝线 |
| 状态色点 | `--kb-status-backlog` / `--kb-status-running` / `--kb-status-needs` / `--kb-status-done` / `--kb-status-failed` | `base.css` | 状态点/图标（不是文字） |
| 状态文字 | `--kb-status-running-text` / `--kb-status-needs-text` / `--kb-status-done-text` / `--kb-status-failed-text` | `base.css`（`light-dark()`） | 11–12px 可读状态文字 |
| 链接文字 | `--kb-link-text` | `base.css`（`light-dark()`） | 11–12px 可读链接 |
| 禁用 | `--kb-disabled-border` / `--kb-disabled-fill` | `base.css` | 禁用态可辨边界/浅底（≥3:1） |
| 动效时长 | `--kb-dur-press` / `--kb-dur-fast` / `--kb-dur` / `--kb-dur-slow` / `--kb-dur-exit` / `--kb-dur-exit-slow` | `base.css` | 见 §5.2 |
| 缓动 | `--kb-ease-out` / `--kb-ease-in-out` / `--kb-ease-drawer` | `base.css` | 见 §5.3 |
| 图形色槽 | `--kb-git-lane-0` … `--kb-git-lane-7` / `--kb-fork-color` | `drawer.css` `.kb-git__fork-cN` | 抽屉 Git 分支图连线/圆点 |
| 组件兜底 | `--kb-radius-lg` | `modal.css` 使用 `var(--kb-radius-lg, 16px)`（未全局定义） | Modal/底部弹层上圆角 |

> 合计 41 个（39 个在 CSS 中定义 + `--kb-host-inset-top` 运行时注入 + `--kb-radius-lg` 仅兜底引用）。命名纪律：新增令牌必须是 `--kb-<域>-<语义>`，先定义在 `base.css` `.kb-app-scope`；组件 CSS 不得新增字面色或临时混色。

### A.2 权威顺序与来源

| 顺序 | 文件 | 职责 |
|---|---|---|
| 1 | `DESIGN.md`（本文件） | 视觉规则、令牌表、动效预算摘要、验收门槛 |
| 2 | [docs/11-motion.md](docs/11-motion.md) | 动效唯一事实源：逐项实现规格、`usePresence`、审查 Block 条件 |
| 3 | [docs/03-design-system.md](docs/03-design-system.md) | 信息架构、术语、交互细则、§9 设计验收 checklist、§10.3 已拍板 |
| 4 | [docs/10-visual-audit.md](docs/10-visual-audit.md) | 审计问题清单、批次、附录 A 实测对比度 |
| 5 | [docs/09-design-motion-skills.md](docs/09-design-motion-skills.md) | 历史调研记录（技能清单），不是规范/预算来源 |
| 6 | `web/src/styles/base.css` / `tokens.css` | 令牌事实（`--kb-*` 定义 / `--dsw-*` 兜底） |

## 附录 B · 自检命令

```bash
# 本文件里出现的每个 --kb-* 必须能在 web/src/styles 找到定义或用例
# （grep 会顺带抽出 --kb-* 这类前缀写法，用 grep -v -- '-$' 过滤）
grep -o "\-\-kb-[a-z0-9-]*" DESIGN.md | sort -u | grep -v -- '-$' | while read t; do
  grep -rq -- "$t" web/src/styles || echo "MISSING: $t"
done

# 组件 CSS 不得出现字面色（tokens.css 是主题镜像，除外）
grep -rn -E "#[0-9a-fA-F]{3,8}\b|rgba?\(" web/src/styles --include="*.css" | grep -v tokens.css

# 令牌 lint / 类型 / 测试
npm --prefix web run lint:tokens && npm --prefix web run typecheck && npm --prefix web test
```
