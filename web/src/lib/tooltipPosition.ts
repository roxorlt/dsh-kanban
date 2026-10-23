/**
 * 固定定位提示气泡（tooltip）的位置计算。
 *
 * 审批选项文案被截断成两行时，hover/键盘聚焦/移动端长按会在选项旁弹出完整文案。
 * 气泡用 fixed 定位渲染到 body（逃出卡片/列体/审批区的 overflow 裁剪），
 * 这里只负责纯计算：优先放在选项下方，下方放不下翻到上方，并夹在视口内。
 */

export interface TipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type TooltipPlacement = 'top' | 'bottom';

export interface TooltipPositionOptions {
  /** 锚点（选项）在视口中的矩形 */
  anchor: TipRect;
  /** 气泡自身尺寸 */
  tooltip: { width: number; height: number };
  /** 视口尺寸（window.innerWidth/innerHeight） */
  viewport: { width: number; height: number };
  /** 锚点与气泡的间距，默认 6 */
  gap?: number;
  /** 距视口边缘的最小留白，默认 8 */
  margin?: number;
}

export interface TooltipPosition {
  left: number;
  top: number;
  placement: TooltipPlacement;
}

const DEFAULT_GAP = 6;
const DEFAULT_MARGIN = 8;

export function computeTooltipPosition(options: TooltipPositionOptions): TooltipPosition {
  const gap = options.gap ?? DEFAULT_GAP;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const { anchor, tooltip, viewport } = options;

  const anchorWidth = Math.max(0, anchor.right - anchor.left);
  const centered = anchor.left + anchorWidth / 2 - tooltip.width / 2;
  const maxLeft = Math.max(margin, viewport.width - tooltip.width - margin);
  const left = Math.min(Math.max(centered, margin), maxLeft);

  const below = anchor.bottom + gap;
  const above = anchor.top - gap - tooltip.height;
  const fitsBelow = below + tooltip.height + margin <= viewport.height;
  const fitsAbove = above >= margin;
  // 上下都放不下时，选剩余空间更大的一侧，再由下面的夹取保证不越界。
  const spaceBelow = viewport.height - anchor.bottom;
  const spaceAbove = anchor.top;
  const placement: TooltipPlacement = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove) ? 'bottom' : 'top';

  const maxTop = Math.max(margin, viewport.height - tooltip.height - margin);
  const top = Math.min(Math.max(placement === 'bottom' ? below : above, margin), maxTop);

  return { left, top, placement };
}
