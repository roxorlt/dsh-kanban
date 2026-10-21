/**
 * 浮层栈：Esc 只关闭最上层（菜单 → 弹窗 → 抽屉）。
 * 各浮层挂载时 push 自己的 close 函数，卸载时自动移除。
 */
const stack: Array<() => void> = [];

export function pushOverlay(close: () => void): () => void {
  stack.push(close);
  return () => {
    const index = stack.lastIndexOf(close);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function closeTopOverlay(): boolean {
  const close = stack[stack.length - 1];
  if (!close) return false;
  close();
  return true;
}

export function hasOverlay(): boolean {
  return stack.length > 0;
}

/** 仅测试用：清空栈。 */
export function resetOverlayStack(): void {
  stack.length = 0;
}
