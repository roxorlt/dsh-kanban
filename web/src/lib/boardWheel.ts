/**
 * 看板横滑手势的轴向判定（纯逻辑，便于单测）。
 *
 * 背景：看板列体是纵向滚动容器（`overflow-y: auto`），触摸板的横向 wheel 事件
 * 会被列体吞掉；同时，macOS 触摸板的斜向滑动会同时产生 deltaX / deltaY，
 * 如果逐事件分别处理就会出现「同一手势既横滚又竖滚」。
 *
 * 这里把一次连续滚动手势锁定到单一轴向：
 * - 手势第一帧按谁占优判定 x / y，之后整个手势保持该轴，直到停顿超过
 *   {@link WHEEL_GESTURE_IDLE_MS} 才允许重新判定；
 * - 横向手势由看板消费（滚动看板），纵向手势一律交还给浏览器（列体自己滚）。
 */

/** 手指停顿超过该时长即视为新手势（触摸板惯性事件间隔约 16ms）。 */
export const WHEEL_GESTURE_IDLE_MS = 150;

/** 小于该值的 delta 视为噪声：不判定轴向，也不接管。 */
const WHEEL_NOISE_FLOOR = 0.01;

/** deltaMode === 1（按行）时，一行按 16px 估算。 */
const WHEEL_LINE_PX = 16;

/** deltaMode === 2（按页）时，一页按 100px 估算。 */
const WHEEL_PAGE_PX = 100;

export type WheelAxis = 'x' | 'y';

export interface WheelGesture {
  /** 当前手势锁定的轴向；null 表示还在等第一帧判定。 */
  axis: WheelAxis | null;
  /** 上一次事件的 event.timeStamp（毫秒）。 */
  lastAt: number;
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** WheelEvent.deltaMode：0=像素 1=行 2=页；缺省按像素。 */
  deltaMode?: number;
  /** ⌘/Ctrl + 滚轮是缩放，不接管。 */
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Shift + 滚轮是经典的水平滚动，把纵向 delta 当作横向。 */
  shiftKey?: boolean;
  /** 事件时间（event.timeStamp），毫秒。 */
  at?: number;
}

export interface WheelDecision {
  /** 看板应横向滚动的像素；null 表示不接管、交还给浏览器。 */
  scrollX: number | null;
  /** 推进后的手势状态，调用方必须回写。 */
  gesture: WheelGesture;
}

export function createWheelGesture(): WheelGesture {
  return { axis: null, lastAt: Number.NEGATIVE_INFINITY };
}

/** 把行 / 页模式的 delta 统一换算成像素。 */
export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (deltaMode === 2) return delta * WHEEL_PAGE_PX;
  return delta;
}

export function resolveWheelGesture(gesture: WheelGesture, input: WheelInput): WheelDecision {
  const at = input.at ?? 0;

  if (input.ctrlKey || input.metaKey) {
    // 缩放手势：不接管，并结束当前手势，避免把缩放的 delta 当成横滑。
    return { scrollX: null, gesture: createWheelGesture() };
  }

  const deltaX = normalizeWheelDelta(input.deltaX, input.deltaMode);
  let deltaY = normalizeWheelDelta(input.deltaY, input.deltaMode);
  let horizontal = deltaX;
  if (input.shiftKey && Math.abs(deltaY) > Math.abs(deltaX)) {
    horizontal = deltaY;
    deltaY = 0;
  }

  const idle = at - gesture.lastAt > WHEEL_GESTURE_IDLE_MS;
  let axis = idle ? null : gesture.axis;
  if (axis === null) {
    if (Math.abs(horizontal) < WHEEL_NOISE_FLOOR && Math.abs(deltaY) < WHEEL_NOISE_FLOOR) {
      return { scrollX: null, gesture: { axis: null, lastAt: at } };
    }
    axis = Math.abs(horizontal) >= Math.abs(deltaY) ? 'x' : 'y';
  }

  return { scrollX: axis === 'x' ? horizontal : null, gesture: { axis, lastAt: at } };
}
