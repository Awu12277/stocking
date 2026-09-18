// ---------------------------------------------------------------------------
// 账户视图 · 终端尺寸 → 布局（纯函数，可单测）
//
// 需求：「界面布局适配终端窗口尺寸」。做法是按列数分三档断点，
// 逐步隐藏次要列而不是任由表格溢出换行；按行数算出主体可用行数，
// 交给 scroll.ts 的 computeWindow 做窗口化。
// ---------------------------------------------------------------------------

import { displayWidth, truncateDisplay } from "./format.js";

/** 持仓表列宽 */
export interface PositionColumns {
  mark: number;
  code: number;
  name: number;
  price: number;
  dayRate: number;
  holdProfit: number;
  holdRate: number;
  value: number;
  holdDays: number;
  broker: number;
  showValue: boolean;
  showHoldDays: boolean;
  showBroker: boolean;
}

/** 交易表列宽 */
export interface TradeColumns {
  mark: number;
  date: number;
  code: number;
  name: number;
  action: number;
  count: number;
  price: number;
  amount: number;
  fee: number;
  showCount: boolean;
  showFee: boolean;
}

export interface AccountLayout {
  columns: number;
  rows: number;
  /** 主体可用行数（标题/页签/页脚已扣除） */
  bodyRows: number;
  /** 窄终端：隐藏市值、持有天数、券商等次要列 */
  compact: boolean;
  /** 极窄终端：进一步隐藏数量列 */
  tiny: boolean;
  /** 总览指标排成几列 */
  metricColumns: 2 | 3 | 4;
  position: PositionColumns;
  trade: TradeColumns;
}

/** 标题 1 + 账户条 1 + 页签 1 + 分割线 1 + 页脚 2 + 上下留白 2 */
const CHROME_ROWS = 8;

/* ------------------------------------------------------------------ *
 * 顶部行的宽度预算
 *
 * 这是「不闪烁」的关键：一行内容一旦超过终端宽度就会折行，而折行数会随
 * 数值/状态文案的长度在两次刷新之间变化，帧高因此抖动，终端被迫反复滚动重绘。
 * 所以顶部行改为显式预算 —— 每段都截断到预算内，保证该行恒占一行。
 * ------------------------------------------------------------------ */

/** 低于该宽度连时钟都不展示（只留标题与账户） */
const MIN_CLOCK_COLUMNS = 56;
/** 低于该宽度不展示刷新状态文案 */
const MIN_STATUS_COLUMNS = 72;
/** 切换条两侧的 ‹ / › +N 指示位预留 */
const STRIP_INDICATOR_WIDTH = 8;

export interface HeaderLayout {
  /** 右侧文字（时钟 + 刷新状态），已按预算截断 */
  rightText: string;
  rightWidth: number;
  /** 账户切换条可用宽度 */
  stripBudget: number;
  /** 切换条最多能放几个账户 */
  stripCapacity: number;
  /** 宽度不足时退化为单行账户名 */
  showStrip: boolean;
  /** 该行各段之和的上界，必须 ≤ columns */
  reservedWidth: number;
}

export function computeHeaderLayout(options: {
  columns: number;
  clockText: string;
  statusText: string;
  /** 单个账户名允许的最大显示宽度 */
  tabNameWidth: number;
}): HeaderLayout {
  const { columns, clockText, statusText, tabNameWidth } = options;

  const rightText = truncateDisplay(
    [
      columns >= MIN_CLOCK_COLUMNS ? clockText : "",
      columns >= MIN_STATUS_COLUMNS ? statusText : "",
    ]
      .filter(Boolean)
      .join("  "),
    Math.max(12, Math.floor(columns * 0.45)),
  );
  const rightWidth = displayWidth(rightText);

  const tabSlotWidth = tabNameWidth + 3; // " name " + 尾随空格
  const stripBudget = Math.max(10, columns - 2 - rightWidth);
  const stripCapacity = Math.max(
    1,
    Math.floor((stripBudget - STRIP_INDICATOR_WIDTH) / tabSlotWidth),
  );
  const showStrip = stripBudget >= tabSlotWidth + STRIP_INDICATOR_WIDTH;

  return {
    rightText,
    rightWidth,
    stripBudget,
    stripCapacity,
    showStrip,
    // 切换条（≤ stripBudget）+ 右侧
    reservedWidth: stripBudget + rightWidth,
  };
}

/**
 * 持仓详情面板占用的行数（展开时从表格容量里扣除）。
 *
 * 面板实际高度 = 上下边框 2 + 标题 1 + 字段行 + 备注 0~1：
 *   宽终端两列铺开 → 6 字段行，约 10 行
 *   窄终端单列且只保留前 8 个字段 → 约 11 行
 * 取 12 覆盖最坏情况。**低估这个值会让帧高超出终端高度，Ink 反复滚动重绘，
 * 在 Windows 终端上表现为明显闪烁**，所以这里必须与实际渲染保持一致。
 */
export const POSITION_DETAIL_ROWS = 12;

/** 当前终端高度是否放得下持仓详情面板（额外留 2 行给表头与摘要/分割线） */
export function canShowPositionDetail(layout: AccountLayout): boolean {
  return layout.bodyRows - 1 - POSITION_DETAIL_ROWS >= 2;
}

export function computeAccountLayout(columns: number, rows: number): AccountLayout {
  const cols = Math.max(40, Math.floor(columns) || 80);
  const rowCount = Math.max(10, Math.floor(rows) || 24);

  const tiny = cols < 78;
  const compact = cols < 104;

  const nameWidth = tiny ? 10 : compact ? 12 : 16;

  return {
    columns: cols,
    rows: rowCount,
    bodyRows: Math.max(4, rowCount - CHROME_ROWS),
    compact,
    tiny,
    metricColumns: tiny ? 2 : compact ? 3 : 4,
    position: {
      mark: 3,
      code: 8,
      name: nameWidth,
      price: 9,
      dayRate: 10,
      holdProfit: 12,
      holdRate: 10,
      value: 12,
      holdDays: 8,
      broker: 12,
      showValue: !tiny,
      showHoldDays: !compact,
      showBroker: !compact,
    },
    trade: {
      mark: 2,
      date: 11,
      code: 8,
      name: nameWidth,
      action: 6,
      count: 10,
      price: 10,
      amount: 14,
      fee: 8,
      showCount: !tiny,
      showFee: !compact,
    },
  };
}

/** 持仓表可见行数（表头占 1 行，展开详情时再扣掉面板高度） */
export function positionRowCapacity(layout: AccountLayout, detailOpen: boolean): number {
  const headerRows = 1;
  const detailRows = detailOpen ? POSITION_DETAIL_ROWS : 0;
  return Math.max(2, layout.bodyRows - headerRows - detailRows);
}

/** 交易表可见行数（表头占 1 行） */
export function tradeRowCapacity(layout: AccountLayout): number {
  return Math.max(2, layout.bodyRows - 1);
}
