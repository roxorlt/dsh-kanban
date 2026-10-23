import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalOption } from '../types';
import { createLongPressGuard } from '../lib/longPress';
import { pushOverlay } from '../lib/overlayStack';
import { computeTooltipPosition } from '../lib/tooltipPosition';
import type { TooltipPlacement } from '../lib/tooltipPosition';

/** hover 停留多久后弹完整文案 */
const HOVER_DELAY_MS = 320;
/** 移动端长按多久后弹完整文案 */
const LONG_PRESS_DELAY_MS = 450;
const TIP_GAP = 6;
const VIEWPORT_MARGIN = 8;
/** 长按触发后，吞掉浏览器在抬起时补发的 click（避免误选中） */
const CLICK_SUPPRESS_MS = 1500;

type TipSource = 'hover' | 'focus' | 'long-press';

interface DecisionOptionProps {
  option: ApprovalOption;
  /** 单题多选时是 checkbox，其余 radio */
  type: 'radio' | 'checkbox';
  name: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}

/**
 * 审批选项（单选/多选共用）。
 *
 * 选项 label 与 description 各最多 2 行（超出省略号，避免文案溢出选项边框、
 * 被下一个选项遮挡）；完整文案通过 hover（桌面）、键盘 focus-visible 或
 * 移动端长按查看：提示气泡 portal + fixed 定位，逃出卡片/列体/审批区的
 * overflow 裁剪，并在下方放不下时翻到上方。
 */
export function DecisionOption({ option, type, name, checked, disabled, onChange }: DecisionOptionProps) {
  const labelRef = useRef<HTMLLabelElement | null>(null);
  const labelTextRef = useRef<HTMLSpanElement | null>(null);
  const descriptionRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const tipSourceRef = useRef<TipSource | null>(null);
  const longPressActiveRef = useRef(false);

  const [tipSource, setTipSource] = useState<TipSource | null>(null);
  const [tipPosition, setTipPosition] = useState<{
    left: number;
    top: number;
    placement: TooltipPlacement;
  } | null>(null);

  /** label / description 任一被 2 行截断才需要提示 */
  const isTruncated = useCallback(() => {
    const isCut = (node: HTMLElement | null) => {
      if (!node) return false;
      return node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
    };
    return isCut(labelTextRef.current) || isCut(descriptionRef.current);
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const closeTip = useCallback(() => {
    clearHoverTimer();
    tipSourceRef.current = null;
    setTipSource(null);
    setTipPosition(null);
  }, [clearHoverTimer]);

  const openTip = useCallback(
    (source: TipSource) => {
      if (disabled) return;
      if (!isTruncated()) return;
      tipSourceRef.current = source;
      setTipSource(source);
    },
    [disabled, isTruncated],
  );

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  // Esc 只关最上层（提示气泡也参与浮层栈）
  useEffect(() => {
    if (!tipSource) return;
    return pushOverlay(closeTip);
  }, [tipSource, closeTip]);

  // 点外部 / 滚动 / 窗口缩放时收起，避免提示和锚点脱节
  useEffect(() => {
    if (!tipSource) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (labelRef.current?.contains(target) || tipRef.current?.contains(target)) return;
      closeTip();
    };
    const onScrollOrResize = () => closeTip();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [tipSource, closeTip]);

  // 气泡先渲染再测量位置（layout 阶段），避免先闪在左上角
  useLayoutEffect(() => {
    if (!tipSource) return;
    const anchor = labelRef.current?.getBoundingClientRect();
    const bubble = tipRef.current?.getBoundingClientRect();
    if (!anchor || !bubble) return;
    setTipPosition(
      computeTooltipPosition({
        anchor,
        tooltip: { width: bubble.width, height: bubble.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap: TIP_GAP,
        margin: VIEWPORT_MARGIN,
      }),
    );
  }, [tipSource]);

  /** 长按触发后吞掉抬起时补发的 click（否则会顺手选中该选项） */
  const suppressNextClick = useCallback(() => {
    let timerId = 0;
    const handler = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      window.clearTimeout(timerId);
      window.removeEventListener('click', handler, true);
    };
    window.addEventListener('click', handler, true);
    timerId = window.setTimeout(() => window.removeEventListener('click', handler, true), CLICK_SUPPRESS_MS);
  }, []);

  const longPress = useMemo(
    () =>
      createLongPressGuard({
        delayMs: LONG_PRESS_DELAY_MS,
        onLongPress: () => {
          suppressNextClick();
          openTip('long-press');
        },
      }),
    [suppressNextClick, openTip],
  );

  const handlePointerEnter = (event: ReactPointerEvent<HTMLLabelElement>) => {
    if (event.pointerType === 'touch' || disabled) return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      openTip('hover');
    }, HOVER_DELAY_MS);
  };

  const handlePointerLeave = (event: ReactPointerEvent<HTMLLabelElement>) => {
    if (event.pointerType === 'touch') return;
    clearHoverTimer();
    if (tipSourceRef.current === 'hover') closeTip();
  };

  const handleFocus = (event: ReactFocusEvent<HTMLInputElement>) => {
    if (disabled) return;
    // 鼠标点击也会聚焦：只对键盘 focus-visible 弹提示
    if (event.currentTarget.matches(':focus-visible')) openTip('focus');
  };

  const handleBlur = () => {
    if (tipSourceRef.current === 'focus') closeTip();
  };

  return (
    <>
      <label
        ref={labelRef}
        className={`kb-decision-option${checked ? ' kb-decision-option--selected' : ''}`}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerDown={(event) => {
          if (disabled) return;
          // 长按提示展开时，再点一次先只收起提示，避免误选中
          if (tipSourceRef.current === 'long-press') {
            closeTip();
            suppressNextClick();
            return;
          }
          if (event.pointerType === 'mouse') return;
          longPressActiveRef.current = true;
          longPress.start({ pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY });
        }}
        onPointerMove={(event) => longPress.move(event.clientX, event.clientY)}
        onPointerUp={() => {
          longPressActiveRef.current = false;
          longPress.end();
        }}
        onPointerCancel={() => {
          longPressActiveRef.current = false;
          longPress.cancel();
        }}
        onContextMenu={(event) => {
          // 长按手势期间屏蔽系统菜单/文字选择菜单
          if (longPressActiveRef.current || tipSourceRef.current === 'long-press') event.preventDefault();
        }}
      >
        <input
          type={type}
          name={name}
          value={option.id}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        <span ref={labelTextRef} className="kb-decision-option__label">
          {option.label}
        </span>
        {option.description ? (
          <span ref={descriptionRef} className="kb-decision-option__desc">
            {option.description}
          </span>
        ) : null}
      </label>
      {tipSource
        ? createPortal(
            <div
              ref={tipRef}
              className="kb-option-tip"
              role="tooltip"
              data-placement={tipPosition?.placement ?? 'bottom'}
              style={{
                left: tipPosition?.left ?? 0,
                top: tipPosition?.top ?? 0,
                visibility: tipPosition ? 'visible' : 'hidden',
              }}
            >
              <span className="kb-option-tip__label">{option.label}</span>
              {option.description ? <span className="kb-option-tip__desc">{option.description}</span> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
