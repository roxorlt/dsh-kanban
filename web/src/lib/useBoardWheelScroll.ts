import { useCallback, useRef } from 'react';
import { WHEEL_GESTURE_IDLE_MS, createWheelGesture, resolveWheelGesture } from './boardWheel';

/**
 * 看板横向滚动手势（触摸板横滑 / Shift + 滚轮）。
 *
 * 为什么需要：看板四列总宽在窄屏（720–1099px）会横向溢出，但列体本身是纵向
 * 滚动容器（`overflow-y: auto` + `overscroll-behavior: contain`）。光标停在卡片
 * 或列体上时，横向 wheel 会被列体吞掉、无法冒泡给看板，只有光标落在列间隙/列头
 * 时才能横滚。这里在看板容器上统一接管横向手势，让整块看板区域都能横滑。
 *
 * 同时用轴向锁定避免「一次手势同时横滚 + 竖滚」：手势首帧判定轴向，横向手势
 * 由看板消费（preventDefault + scrollLeft），纵向手势完全交还给浏览器，列体
 * 照常自己滚动。
 *
 * 返回回调 ref：切桌面/竖屏布局时看板元素会更换，用回调 ref 保证监听始终挂在
 * 当前元素上。注意不要在 effect 里做解绑——StrictMode 的模拟卸载会让首次 effect
 * 的 cleanup 解掉二次挂载的监听，导致监听丢失（本项目 dev 环境就是 StrictMode）。
 */
export function useBoardWheelScroll(): (node: HTMLElement | null) => void {
  const detachRef = useRef<(() => void) | null>(null);

  return useCallback((node: HTMLElement | null) => {
    detachRef.current?.();
    detachRef.current = null;
    if (!node) return;

    let gesture = createWheelGesture();
    let overflowX = false;

    const measure = () => {
      overflowX = node.scrollWidth - node.clientWidth > 1;
    };
    measure();

    const onWheel = (event: WheelEvent) => {
      const idle = event.timeStamp - gesture.lastAt > WHEEL_GESTURE_IDLE_MS;
      if (gesture.axis === null || idle) measure();
      if (!overflowX) return;

      const decision = resolveWheelGesture(gesture, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        at: event.timeStamp,
      });
      gesture = decision.gesture;
      if (decision.scrollX === null) return;

      event.preventDefault();
      node.scrollLeft += decision.scrollX;
    };

    // 必须是非 passive 监听：React 的 onWheel 在根节点上是 passive 的，
    // 无法 preventDefault，列体会继续吃掉同一次手势的纵向 delta。
    node.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(node);

    detachRef.current = () => {
      node.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, []);
}
