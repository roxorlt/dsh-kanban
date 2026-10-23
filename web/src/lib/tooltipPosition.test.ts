import { describe, expect, it } from 'vitest';
import { computeTooltipPosition } from './tooltipPosition';

const viewport = { width: 1000, height: 800 };
const tooltip = { width: 240, height: 60 };

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, right: left + width, bottom: top + height };
}

describe('computeTooltipPosition', () => {
  it('空间充足时放在下方并水平居中', () => {
    const result = computeTooltipPosition({ anchor: rect(400, 200, 120, 40), tooltip, viewport });
    expect(result).toEqual({ left: 340, top: 246, placement: 'bottom' });
  });

  it('下方放不下时翻到上方', () => {
    const anchor = rect(400, 700, 120, 40); // bottom=740，下面只有 60，放不下 60+8
    const result = computeTooltipPosition({ anchor, tooltip, viewport });
    expect(result.placement).toBe('top');
    expect(result.top).toBe(700 - 6 - 60);
  });

  it('上下都放不下时选空间更大的一侧并夹在视口内', () => {
    const anchor = rect(400, 390, 120, 40); // 上下各约 390/390
    const tall = { width: 240, height: 500 };
    const result = computeTooltipPosition({ anchor, tooltip: tall, viewport });
    expect(result.placement).toBe('top');
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(result.top + tall.height).toBeLessThanOrEqual(viewport.height - 8 + 0.001);
  });

  it('锚点靠近左边缘时夹到左侧留白', () => {
    const result = computeTooltipPosition({ anchor: rect(0, 200, 80, 40), tooltip, viewport });
    expect(result.left).toBe(8);
  });

  it('锚点靠近右边缘时夹到右侧留白', () => {
    const result = computeTooltipPosition({ anchor: rect(920, 200, 80, 40), tooltip, viewport });
    expect(result.left).toBe(viewport.width - tooltip.width - 8);
  });

  it('支持自定义间距与留白', () => {
    const anchor = rect(400, 200, 120, 40);
    const result = computeTooltipPosition({ anchor, tooltip, viewport, gap: 12, margin: 16 });
    expect(result.top).toBe(200 + 40 + 12);
    expect(result.left).toBe(400 + 60 - 120);
  });

  it('气泡比视口还宽时不出现负偏移', () => {
    const wide = { width: 1200, height: 60 };
    const result = computeTooltipPosition({ anchor: rect(100, 200, 80, 40), tooltip: wide, viewport });
    expect(result.left).toBe(8);
  });

  it('锚点贴视口底部时仍不越界', () => {
    const anchor = rect(400, 780, 120, 20);
    const result = computeTooltipPosition({ anchor, tooltip, viewport });
    expect(result.placement).toBe('top');
    expect(result.top).toBeGreaterThanOrEqual(8);
  });
});
