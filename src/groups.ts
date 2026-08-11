// ---------------------------------------------------------------------------
// 分组相关的纯函数：UI 之外的分组逻辑集中在这里，方便测试
// ---------------------------------------------------------------------------

import type { Group, StockSymbol } from "./types.js";

/** 边界裁剪后的分组下标（[0, groups.length-1]） */
export function clampGroupIndex(idx: number, total: number): number {
  if (total <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= total) return total - 1;
  return idx;
}

/** 给定下标取当前组，越界返回 null */
export function currentGroup(groups: Group[], idx: number): Group | null {
  if (idx < 0 || idx >= groups.length) return null;
  return groups[idx] ?? null;
}

/** 当前组的所有代码（含 buyPrice / sellPrice 配置） */
export function currentSymbols(groups: Group[], idx: number): StockSymbol[] {
  const g = currentGroup(groups, idx);
  return g ? g.symbols : [];
}

/** 把"目标价变更"应用到指定分组，返回新 groups（不可变更新） */
export function applyTargetToGroup(
  groups: Group[],
  groupIdx: number,
  code: string,
  type: "buy" | "sell",
  price: number | undefined,
): Group[] {
  const key: "buyPrice" | "sellPrice" = type === "buy" ? "buyPrice" : "sellPrice";
  const next = groups.map((g, i) => {
    if (i !== groupIdx) return g;
    const existing = g.symbols.find((s) => s.code === code);
    // 该股从未配置且本次是清除 → 该组不动
    if (!existing && price === undefined) return g;
    let symbols: StockSymbol[];
    if (existing) {
      symbols = g.symbols.map((s) => {
        if (s.code !== code) return s;
        const copy: StockSymbol = { ...s };
        if (price === undefined) delete copy[key];
        else copy[key] = price;
        return copy;
      });
    } else {
      // 该组里第一次配置这只股票（临时查看模式下不会出现此分支，调用方已约束）
      symbols = [...g.symbols, { code, [key]: price } as StockSymbol];
    }
    return { ...g, symbols };
  });
  return next;
}