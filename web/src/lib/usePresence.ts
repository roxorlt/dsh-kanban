import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from './useMediaQuery';

/**
 * 退出动画的挂载保持（详见 docs/11-motion.md §5）。
 *
 * React 把 `open=false` 的元素直接卸载，CSS 拿不到「离场」这一帧。
 * 这里的做法统一：open 变 false 后先挂 `leaving` 状态（组件自己加 `.kb-*-leaving` 类跑
 * transform/opacity 过渡），等 exitMs 之后才真正卸载。全程只有 CSS 过渡、不用 keyframes，
 * 所以连续开关会从当前值重新起算，不会闪回起点。
 *
 * reduced-motion 分两级（docs/11-motion.md §4）：
 * - 默认 false：位移/缩放类离场均即时（exitMs 视为 0，直接卸载）；
 * - keepInReducedMotion: true：只做 opacity 淡变的浮层（Toast、批量条、审批区块）
 *   保留一个最短淡变窗口，配合 base.css 末尾的 B 级例外清单（只允许动 opacity）。
 */

export interface PresenceOptions {
  /** true = reduced-motion 下仍保留离场窗口（仅限纯 opacity 淡变）。 */
  keepInReducedMotion?: boolean;
}

/** 退出等待时长：位移类在 reduced-motion 下为 0；opacity 类可保留。 */
export function presenceExitMs(exitMs: number, reducedMotion: boolean, keepInReducedMotion = false): number {
  if (!Number.isFinite(exitMs) || exitMs <= 0) return 0;
  if (!reducedMotion) return exitMs;
  return keepInReducedMotion ? Math.min(exitMs, 120) : 0;
}

export interface Presence {
  /** 是否应该渲染（含离场等待期）。 */
  mounted: boolean;
  /** 是否处在离场过渡中（组件据此挂 leaving 类）。 */
  leaving: boolean;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function usePresence(open: boolean, exitMs: number, options: PresenceOptions = {}): Presence {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const keep = options.keepInReducedMotion === true;
  const exit = presenceExitMs(exitMs, reducedMotion, keep);
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) {
      setLeaving(false);
      return;
    }
    if (exit <= 0) {
      setMounted(false);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setMounted(false);
      setLeaving(false);
    }, exit);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, exit, mounted]);

  return { mounted, leaving };
}

export interface PresenceValue<T> extends Presence {
  /** 离场期间仍然要渲染的数据（保留最后一次非空值）。 */
  value: T | null;
}

/**
 * 带数据的 presence：抽屉关闭后还要用最后一张卡片的数据把离场画完，
 * 所以这里缓存最后一个非空 value。
 */
export function usePresenceValue<T>(
  open: boolean,
  value: T | null,
  exitMs: number,
  options: PresenceOptions = {},
): PresenceValue<T> {
  const presence = usePresence(open, exitMs, options);
  // 渲染期记录最后一次非空 value（幂等，不产生额外渲染）。
  // 不要改成 `useEffect` + `setState`：调用方传内联对象时 value 每次渲染都是新引用，
  // effect 会 setState → 再渲染 → 再 setState，触发 React「Maximum update depth exceeded」。
  const held = useRef<T | null>(value);
  if (value !== null) held.current = value;
  return { ...presence, value: value ?? held.current };
}
