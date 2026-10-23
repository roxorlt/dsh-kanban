import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPressGuard } from './longPress';

describe('createLongPressGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('触摸按下到点触发一次长按', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(399);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    guard.end();
  });

  it('鼠标按下不参与长按', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    expect(guard.start({ pointerType: 'mouse', clientX: 10, clientY: 10 })).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('笔（pen）按下同样可以长按', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    expect(guard.start({ pointerType: 'pen', clientX: 10, clientY: 10 })).toBe(true);
    vi.advanceTimersByTime(400);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('移动超过阈值取消长按', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400, moveTolerancePx: 8 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    guard.move(19, 10); // 位移 9 > 8
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('阈值内的轻微抖动仍会触发', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400, moveTolerancePx: 8 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    guard.move(13, 14); // 位移 5
    vi.advanceTimersByTime(400);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('触发前抬起（end）不会触发，并返回 false', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    expect(guard.end()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('触发后 end 返回 true（用于吞掉补发的 click）', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(400);
    expect(guard.end()).toBe(true);
    expect(guard.end()).toBe(false);
  });

  it('pointercancel（cancel）后不再触发', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    guard.cancel();
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('同一手势重复 start 会被最后一次覆盖', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress, delayMs: 400 });
    guard.start({ pointerType: 'touch', clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(300);
    guard.start({ pointerType: 'touch', clientX: 20, clientY: 20 });
    vi.advanceTimersByTime(399);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('默认延时 450ms', () => {
    const onLongPress = vi.fn();
    const guard = createLongPressGuard({ onLongPress });
    guard.start({ pointerType: 'touch', clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(449);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
