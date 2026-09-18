// ---------------------------------------------------------------------------
// 账户视图 · 键盘导航的纯函数（可单测）
//
// 从 StockList 的 groups.ts 取同样的思路：把「下标计算」「列表滚动窗口」
// 这类易错的算术从组件里搬出来单独验证。
// ---------------------------------------------------------------------------

/** 边界裁剪后的下标（[0, total-1]）；total <= 0 时返回 0 */
export function clampIndex(idx: number, total: number): number {
  if (total <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= total) return total - 1;
  return idx;
}

/** 循环位移后的下标（用于页签切换） */
export function wrapIndex(idx: number, total: number): number {
  if (total <= 0) return 0;
  return ((idx % total) + total) % total;
}

export interface WindowSlice {
  /** 首个可见下标（含） */
  start: number;
  /** 末个可见下标（不含） */
  end: number;
  /** 上方被折叠的行数 */
  above: number;
  /** 下方被折叠的行数 */
  below: number;
  /** 实际渲染的行数 */
  size: number;
}

/**
 * 计算列表的可见窗口：尽量让 `selected` 居中，并整体夹在 [0, total) 内。
 *
 * 与 StockList 直接铺满全部行的做法不同：股票列表的分组通常只有几只，
 * 而账户持仓/流水可能上百条，铺满会溢出终端高度导致 Ink 反复清屏。
 */
export function computeWindow(total: number, selected: number, capacity: number): WindowSlice {
  if (total <= 0) return { start: 0, end: 0, above: 0, below: 0, size: 0 };

  const size = Math.max(1, Math.min(capacity, total));
  if (size >= total) return { start: 0, end: total, above: 0, below: 0, size: total };

  const sel = clampIndex(selected, total);
  // 先尝试居中，再夹回合法区间，保证选中行始终可见
  let start = sel - Math.floor(size / 2);
  start = clampIndex(start, total - size + 1);

  return {
    start,
    end: start + size,
    above: start,
    below: total - (start + size),
    size,
  };
}

/** 窗口划分后取切片（越界自动兜底为空数组） */
export function sliceWindow<T>(rows: readonly T[], slice: WindowSlice): T[] {
  return rows.slice(slice.start, slice.end);
}
