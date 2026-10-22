# OpenDesign 可复用设计 / 动效 skill 调研

> 调研对象：<https://github.com/nexu-io/open-design>（Apache-2.0，2026-10 快照，约 1.3 万文件）
> 目标：判断其中哪些 skill 适合「给 dsh-kanban 升级视觉规范」与「给 dsh-kanban 做动效」，并给出可直接使用的清单。
> 说明：OpenDesign 是设计 Agent 工作台，仓库里的 `skills/` 是可被任意 Agent 读取的 `SKILL.md`；`craft/` 是设计知识库（不是 skill）。我们按 DSH 的 `~/.dsh/skills/<name>/SKILL.md` 约定安装。

## 1. 结论

- **有，而且质量高于通用前端技能**：`redesign-existing-projects` 适合视觉规范升级；`animate` + `review-animations` + `motion-lab` 适合动效；`design-md` 适合把升级结果固化成 DESIGN.md；`craft/` 的 typography / color / anti-ai-slop / state-coverage / animation-discipline 可直接作为评审标尺。
- 但**不能整套照搬**：OpenDesign 大量 skill 面向 landing page / 视频模板 / Awwwards 风格，和 DSH 的产品型、克制、发丝线设计语言冲突。应挑选「审计 + 产品 UI + 动效纪律」这几类，并且**始终以 DSH `--dsw-alias-*` 令牌与 `docs/03` 为最高约束**。
- 已安装到 `~/.dsh/skills/`（下次会话即可在技能目录看到）：
  `animate`、`redesign-existing-projects`、`impeccable-design-polish`、`design-md`、`review-animations`、`motion-lab`。

## 2. 视觉规范升级：候选清单

| Skill / 资料 | 路径 | 体量 | 适合度 | 用法与注意 |
| --- | --- | --- | --- | --- |
| redesign-existing-projects | `skills/redesign-skill/` | 20K / 2 files | ★★★★★ | 先 Audit 再改，不重写；但它的字体/颜色建议偏营销站，需被 DSH 令牌覆盖（只取「审计清单 + 层级/状态完整性」） |
| impeccable-design-polish | `skills/impeccable-design-polish/` | 4K / 1 file | ★★★★ | 审计、批评、润色、animate、harden 一条龙；适合在功能完成后做最后一轮 polish |
| design-md | `skills/design-md/` | 4K / 1 file | ★★★★★ | 生成/维护 DESIGN.md 的单一事实源；建议本项目新增 `DESIGN.md`，把 docs/03 的规则 + 令牌 + 动效预算写进去 |
| ui-skills | `skills/ui-skills/` | 4K | ★★★ | 意见型 UI 约束，可摘录到 DESIGN.md；不单独安装也可 |
| design-review | `skills/design-review/` | — | ★★★ | 会话本身已有 gstack `design-review`；不重复安装 |
| craft/typography、color、anti-ai-slop、state-coverage、accessibility-baseline、laws-of-ux | `craft/*.md` | 各 4–20K | ★★★★★ | 不是 skill，但是最好的**评审标尺**；建议复制进本仓库 `docs/craft/` 或直接引用 GitHub 固定 commit |
| taste-skill / 社区 Awwwards 插件 | `skills/taste-skill/`、`plugins/community/...motion-choreographer...` | 92K+ | ★☆ | 面向 landing page / 作品集；要求换字体、渐变/玻璃、Awwwards 风格，与 DSH 冲突，不建议 |

## 3. 动效：候选清单

| Skill | 路径 | 体量 | 适合度 | 用法与注意 |
| --- | --- | --- | --- | --- |
| animate | `skills/animate/` | 32K / 4 files | ★★★★★ | Emil Kowalski 体系：先判断「该不该动」，再给时长/曲线/弹簧/打断/减少动态；要求复用现有 motion token，禁止新增平行体系。**首选** |
| review-animations | `skills/review-animations/` | 28K / 3 files | ★★★★★ | 高门槛动效审查，默认挑刺；适合在 animate 实现后做独立 QA |
| motion-lab | `skills/motion-lab/` | 176K / 9 files | ★★★★ | 160 个 HTML/CSS/JS 案例 + 中英文索引，用于选型与参数参考；不是直接产出 |
| impeccable-design-polish | 同上 | 4K | ★★★★ | 自带 animate/polish 步骤，适合与其他改动一起做 |
| ui-animation | `skills/ui-animation/` | 232K / 24 files | ★★★ | 强项是「录屏 → 帧提取 → 曲线拟合」，需要 FFmpeg/Python；做现有录屏复刻时再用 |
| motion-design / video templates | `skills/motion-design*`、`plugins/_official/video-templates` | 大 | ☆ | 视频/动效图形，不是产品 UI 动效，不适用 |
| emil-design-eng / animation-vocabulary | 本机已有 | — | ★★★★ | 与会话已有技能重合；`animate` 相当于可执行的加强版 |

## 4. 建议的落地方式（下一轮）

1. **视觉规范升级（建议独立迭代）**：用 `redesign-existing-projects` 做一次 Audit → 用 `design-md` 生成 `DESIGN.md`（强制：只用 DSH alias 令牌、密度/字号阶梯、状态覆盖、动效预算）→ 按 `docs/03` 的 checklist 逐项实现；不采用营销站字体/渐变建议。
2. **动效（建议紧随其后）**：用 `animate` 给「列拖拽落位、卡片展开、抽屉进出、审批提交、批量条出现、返回气泡」定义一套 motion tokens（duration/easing），再用 `review-animations` 做独立审查；`motion-lab` 只做选型参考，不引入新库。
3. **约束**：任何动效必须尊重 `prefers-reduced-motion`；键盘高频操作不加动画（animate 的硬规则）；动效 token 落在 `web/src/styles/tokens.css`，不新建平行体系。

## 5. 安装与复现

```bash
git clone --depth 1 https://github.com/nexu-io/open-design.git /tmp/open-design
for s in animate redesign-skill impeccable-design-polish design-md review-animations motion-lab; do
  rm -rf ~/.dsh/skills/$s
  cp -R /tmp/open-design/skills/$s ~/.dsh/skills/$s
done
```

- 已安装：`animate`、`redesign-existing-projects`（目录名 `redesign-skill`，skill name 见 frontmatter）、`impeccable-design-polish`、`design-md`、`review-animations`、`motion-lab`。
- 各 skill 自带 LICENSE/upstream 信息，个人使用保留原目录即可；若要进本仓库需单独处理许可证与署名。
- 调用示例（下次会话）：
  - 「用 redesign-existing-projects 给 kanban 做一次视觉审计，只输出问题清单」
  - 「用 design-md 把 docs/03 + 令牌 + 动效预算固化成 DESIGN.md」
  - 「用 animate 给看板做动效规范与实现，先判断哪些不该动」
  - 「用 review-animations 审查 web/src/styles 里的动效实现」
