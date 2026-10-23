import { describe, expect, it } from 'vitest';
import type { WheelGesture } from './boardWheel';
import {
  WHEEL_GESTURE_IDLE_MS,
  createWheelGesture,
  normalizeWheelDelta,
  resolveWheelGesture,
} from './boardWheel';

const at = (ms: number) => ms;

describe('normalizeWheelDelta', () => {
  it('像素模式原样返回', () => {
    expect(normalizeWheelDelta(12, 0)).toBe(12);
    expect(normalizeWheelDelta(-12)).toBe(-12);
  });

  it('行模式按 16px / 行换算', () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(-2, 1)).toBe(-32);
  });

  it('页模式按 100px / 页换算', () => {
    expect(normalizeWheelDelta(1, 2)).toBe(100);
  });
});

describe('resolveWheelGesture', () => {
  it('首帧横向占优：锁定 x 轴并交回可滚动的 deltaX', () => {
    const decision = resolveWheelGesture(createWheelGesture(), { deltaX: 24, deltaY: 0, at: at(0) });
    expect(decision.scrollX).toBe(24);
    expect(decision.gesture.axis).toBe('x');
    expect(decision.gesture.lastAt).toBe(0);
  });

  it('首帧纵向占优：不接管，锁定 y 轴', () => {
    const decision = resolveWheelGesture(createWheelGesture(), { deltaX: 0, deltaY: 32, at: at(0) });
    expect(decision.scrollX).toBeNull();
    expect(decision.gesture.axis).toBe('y');
  });

  it('首帧两轴相等时按横向处理（优先横向，保证窄屏能滚到第 4 列）', () => {
    const decision = resolveWheelGesture(createWheelGesture(), { deltaX: 10, deltaY: 10, at: at(0) });
    expect(decision.scrollX).toBe(10);
    expect(decision.gesture.axis).toBe('x');
  });

  it('锁定 x 轴后，同一手势里出现的纵向 delta 被吞掉（不同时竖滚）', () => {
    const first = resolveWheelGesture(createWheelGesture(), { deltaX: 30, deltaY: 0, at: at(0) });
    const second = resolveWheelGesture(first.gesture, { deltaX: 0, deltaY: 40, at: at(16) });
    expect(second.scrollX).toBe(0);
    expect(second.gesture.axis).toBe('x');
    const third = resolveWheelGesture(second.gesture, { deltaX: 24, deltaY: 18, at: at(32) });
    expect(third.scrollX).toBe(24);
  });

  it('锁定 y 轴后，同一手势里出现的横向 delta 不接管（不同时横滚）', () => {
    const first = resolveWheelGesture(createWheelGesture(), { deltaX: 0, deltaY: 40, at: at(0) });
    const second = resolveWheelGesture(first.gesture, { deltaX: 60, deltaY: 90, at: at(16) });
    expect(second.scrollX).toBeNull();
    expect(second.gesture.axis).toBe('y');
  });

  it('停顿超过阈值后重新判定轴向', () => {
    const first = resolveWheelGesture(createWheelGesture(), { deltaX: 30, deltaY: 0, at: at(0) });
    const resumed = resolveWheelGesture(first.gesture, {
      deltaX: 0,
      deltaY: 40,
      at: at(WHEEL_GESTURE_IDLE_MS + 1),
    });
    expect(resumed.scrollX).toBeNull();
    expect(resumed.gesture.axis).toBe('y');
  });

  it('停顿未超过阈值时保持原轴向', () => {
    const first = resolveWheelGesture(createWheelGesture(), { deltaX: 30, deltaY: 0, at: at(0) });
    const resumed = resolveWheelGesture(first.gesture, {
      deltaX: 0,
      deltaY: 40,
      at: at(WHEEL_GESTURE_IDLE_MS - 1),
    });
    expect(resumed.gesture.axis).toBe('x');
    expect(resumed.scrollX).toBe(0);
  });

  it('⌘/Ctrl + 滚轮是缩放：不接管并结束手势', () => {
    const first = resolveWheelGesture(createWheelGesture(), { deltaX: 30, deltaY: 0, at: at(0) });
    const zoom = resolveWheelGesture(first.gesture, { deltaX: 5, deltaY: 60, ctrlKey: true, at: at(16) });
    expect(zoom.scrollX).toBeNull();
    expect(zoom.gesture.axis).toBeNull();
    const mac = resolveWheelGesture(createWheelGesture(), { deltaX: 5, deltaY: 60, metaKey: true, at: at(32) });
    expect(mac.scrollX).toBeNull();
  });

  it('Shift + 滚轮把纵向 delta 当作横向滚动', () => {
    const decision = resolveWheelGesture(createWheelGesture(), {
      deltaX: 0,
      deltaY: 48,
      shiftKey: true,
      at: at(0),
    });
    expect(decision.scrollX).toBe(48);
    expect(decision.gesture.axis).toBe('x');
  });

  it('行 / 页模式的横滑同样换算成像素', () => {
    const lines = resolveWheelGesture(createWheelGesture(), { deltaX: 2, deltaY: 0, deltaMode: 1, at: at(0) });
    expect(lines.scrollX).toBe(32);
    const pages = resolveWheelGesture(createWheelGesture(), { deltaX: 1, deltaY: 0, deltaMode: 2, at: at(0) });
    expect(pages.scrollX).toBe(100);
  });

  it('两轴都是噪声时不接管，并保持待判定状态', () => {
    const decision = resolveWheelGesture(createWheelGesture(), { deltaX: 0.004, deltaY: 0.003, at: at(0) });
    expect(decision.scrollX).toBeNull();
    expect(decision.gesture.axis).toBeNull();
  });

  it('反向横滑返回负值', () => {
    const decision = resolveWheelGesture(createWheelGesture(), { deltaX: -120, deltaY: 4, at: at(0) });
    expect(decision.scrollX).toBe(-120);
  });

  it('不修改传入的手势状态', () => {
    const gesture: WheelGesture = { axis: 'x', lastAt: 10 };
    resolveWheelGesture(gesture, { deltaX: 20, deltaY: 0, at: at(20) });
    expect(gesture).toEqual({ axis: 'x', lastAt: 10 });
  });
});
