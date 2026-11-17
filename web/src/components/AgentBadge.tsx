import type { CardAgent } from '../types';
import { useI18n } from '../i18n';
import { describeCardAgent } from '../lib/agentBadge';
import { IconAuto, IconSparkle } from './Icons';

interface AgentBadgeProps {
  agent?: CardAgent | null;
  compact?: boolean;
}

/**
 * 卡片执行 Agent / Harness 归属徽章（DESIGN.md §2.5 / §3）：
 * - DSH 宿主（`DSH · DeepSeek`）：终端图标 + 中性表面 `--kb-agent-host-bg` + 0.5px 描边
 * - 外部跨端 Harness（`Carbon · Gemini` / `Codex` / `Claude Code`）：星芒图标 + 业务浅底 `--kb-agent-ext-bg`
 */
export function AgentBadge({ agent, compact = false }: AgentBadgeProps) {
  const { t } = useI18n();
  const desc = describeCardAgent(agent);
  if (!desc) return null;

  const tooltip = t('card.agentTooltip', { agent: desc.label });
  const classes = [
    'kb-agent-badge',
    desc.kind === 'host' ? 'kb-agent-badge--host' : 'kb-agent-badge--external',
    compact ? 'kb-agent-badge--compact' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      title={tooltip}
      aria-label={tooltip}
      data-agent-kind={desc.kind}
      data-agent-harness={desc.harness}
    >
      <span className="kb-icon" aria-hidden="true">
        {desc.kind === 'host' ? <IconAuto /> : <IconSparkle />}
      </span>
      <span className="kb-agent-badge__label">{desc.label}</span>
    </span>
  );
}
