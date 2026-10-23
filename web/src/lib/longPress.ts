/**
 * 长按手势守卫（移动端看完整审批文案用）。
 *
 * 触摸/笔按下后延时触发一次长按；移动超过阈值、抬起或 pointercancel 都会放弃。
 * 鼠标不参与（桌面用 hover 提示）。`end()` 返回本次手势是否触发过长按，
 * 调用方用它决定是否吞掉抬起后浏览器补发的 click，避免长按误选中选项。
 */

export interface LongPressStartInput {
  /** PointerEvent.pointerType：'touch' | 'pen' | 'mouse' */
  pointerType?: string;
  clientX: number;
  clientY: number;
}

export interface LongPressGuardOptions {
  onLongPress: () => void;
  /** 默认 450ms */
  delayMs?: number;
  /** 默认 8px */
  moveTolerancePx?: number;
}

export interface LongPressGuard {
  /** 开始一次手势；鼠标按下返回 false（不参与） */
  start(input: LongPressStartInput): boolean;
  move(clientX: number, clientY: number): void;
  cancel(): void;
  /** 结束手势；返回本次是否已触发长按 */
  end(): boolean;
}

const DEFAULT_DELAY_MS = 450;
const DEFAULT_MOVE_TOLERANCE_PX = 8;

export function createLongPressGuard(options: LongPressGuardOptions): LongPressGuard {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const tolerance = options.moveTolerancePx ?? DEFAULT_MOVE_TOLERANCE_PX;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let fired = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    start(input) {
      // 鼠标有 hover 提示，长按只服务触摸/笔。
      if (input.pointerType === 'mouse') return false;
      clearTimer();
      fired = false;
      origin = { x: input.clientX, y: input.clientY };
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        options.onLongPress();
      }, delayMs);
      return true;
    },
    move(clientX, clientY) {
      if (origin === null || timer === null) return;
      if (Math.hypot(clientX - origin.x, clientY - origin.y) > tolerance) {
        clearTimer();
        origin = null;
      }
    },
    cancel() {
      clearTimer();
      origin = null;
    },
    end() {
      clearTimer();
      origin = null;
      const didFire = fired;
      fired = false;
      return didFire;
    },
  };
}
