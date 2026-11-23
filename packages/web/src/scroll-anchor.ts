// 阅读位置属于实际正文节点；切换会话或交接段后，旧节点不能再恢复位置。
export interface ReadingAnchor {
  element: HTMLElement;
  offset: number;
  height: number;
}

export function captureReadingAnchor(scroller: HTMLElement): ReadingAnchor | null {
  const box = scroller.getBoundingClientRect();
  // 正文在玻璃页头下继续滚动，取页头下方正在阅读的段落，兼顾一条很长的回复。
  const top = box.top + Math.min(80, scroller.clientHeight / 4);
  let fallback: HTMLElement | null = null;
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-message-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= top || rect.top >= box.bottom) continue;
    let element = row;
    const blocks = row.querySelectorAll<HTMLElement>('.markdown > *');
    let visibleBlock = false;
    for (const block of blocks) {
      const bounds = block.getBoundingClientRect();
      // 图片占位自身会长高，优先锚定它下方可见的文字，避免锚点留在占位上缘。
      if (bounds.height > 0 && bounds.bottom > top && bounds.top < box.bottom && !block.classList.contains('file-images')) { element = block; visibleBlock = true; break; }
    }
    if (blocks.length && !visibleBlock) { fallback ??= row; continue; }
    return { element, offset: element.getBoundingClientRect().top - box.top, height: scroller.scrollHeight };
  }
  return fallback ? { element: fallback, offset: fallback.getBoundingClientRect().top - box.top, height: scroller.scrollHeight } : null;
}

// 返回实际补偿量；正文节点已被替换时返回 null，交由当前会话重新建立锚点。
export function restoreReadingAnchor(scroller: HTMLElement, anchor: ReadingAnchor | null): number | null {
  if (!anchor || !scroller.contains(anchor.element)) return null;
  const delta = anchor.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  const previous = scroller.scrollTop;
  if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
  return scroller.scrollTop - previous;
}
