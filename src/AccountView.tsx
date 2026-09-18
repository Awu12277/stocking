// ---------------------------------------------------------------------------
// AccountView — 投资账本账户视图（由股票列表按 `a` 切换进入）
//
// 键盘：
//   全局：a/q/Esc 返回股票列表   ←/→ 或 [/] 切换账户   Tab/Shift+Tab 或 1-4 切换页签
//         r 立即刷新   p 暂停/继续自动刷新   h 置灰   Ctrl+C 双击退出
//   持仓：↑/↓ (jk) 选择   Enter 展开/收起持仓详情
//   交易：↑/↓ (jk) 选择   t 切换「当日/历史」   n/b 历史流水翻页
//
// 布局：按终端列数分「宽 / 紧凑 / 极窄」三档断点隐藏次要列，
//       按行数窗口化长列表，保证不会溢出高度导致 Ink 反复清屏。
// ---------------------------------------------------------------------------

import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import {
  ACCOUNT_TABS,
  ACCOUNT_TAB_KEYS,
  ACCOUNT_TYPE_LABEL,
  COLORS,
  type AccountTabKey,
} from "./account/constants.js";
import { ACCOUNT_CONFIG_PATH, missingAuthCookies } from "./account/config.js";
import {
  alignRight,
  dataStamp,
  displayWidth,
  formatMoney,
  formatNullable,
  formatPercent,
  formatRatio,
  formatSignedMoney,
  shortDate,
  trendColor,
  truncateDisplay,
} from "./account/format.js";
import {
  canShowPositionDetail,
  computeAccountLayout,
  computeHeaderLayout,
  positionRowCapacity,
  tradeRowCapacity,
  type AccountLayout,
} from "./account/layout.js";
import { computeWindow, sliceWindow } from "./account/scroll.js";
import { useTerminalSize } from "./account/useTerminalSize.js";
import { useAccountData, type TabData } from "./account/useAccountData.js";
import type {
  AccountConfig,
  OverviewData,
  PositionRow,
  PositionSummary,
  TradeData,
  UiError,
} from "./account/types.js";

export interface AccountViewProps {
  config: AccountConfig;
  /** --account 指定的启动账户（id 或名称） */
  initialAccountId?: string;
  /** 返回股票列表 */
  onBack: () => void;
  /** 退出整个程序 */
  onExit: () => void;
}

/* ------------------------------------------------------------------ *
 * 通用小组件
 * ------------------------------------------------------------------ */

interface FlashState {
  text: string;
  color: string;
}

/**
 * 置灰模式下把 color 换成 dimColor，与股票列表的 `h` 键同一套做法。
 * 反馈类文案（错误条、操作提示）不参与置灰，保持可读。
 */
type ColorFn = (color: string) => { dimColor: boolean } | { color: string };

/** 错误条：主数据失败时显示在分割线下方，保留旧数据不清屏 */
function ErrorBar({ error, columns }: { error: UiError; columns: number }) {
  return (
    <Box flexDirection="column">
      <Text color={COLORS.error}>
        {"  ✘ "}
        {truncateDisplay(`${error.message}${error.code ? `（${error.code}）` : ""}`, columns - 6)}
      </Text>
      <Text color={COLORS.dim}>{"    "}{truncateDisplay(error.hint, columns - 6)}</Text>
    </Box>
  );
}

/** 可空指标的取值函数（null → —） */
const nullable = (fn: (v: unknown) => string, v: number | null | undefined): string =>
  formatNullable(fn, v ?? null);

/**
 * 金额 + 收益率的组合值：放得下就带收益率，放不下就退回只显示金额。
 *
 * 原先按「单元格 ≥ 30 列才带收益率」的全局开关判断，而 108 列终端排 4 项时
 * 单元格只有 26 列，收益率因此被整段隐藏。改成按每个指标的实际预算判断后，
 * 常见宽度下都能显示；并且宁可退回纯金额，也不把数字截断成
 * 「+408.20  +0…」这种半截片段。
 */
export function moneyWithRate(
  label: string,
  money: string,
  rate: number,
  cellWidth: number,
): string {
  const budget = Math.max(4, cellWidth - displayWidth(label) - 1);
  const percent = formatPercent(rate);

  // 先试两个空格（更好读），差一点点就改用单个空格，仍放不下才退回纯金额
  const roomy = `${money}  ${percent}`;
  if (displayWidth(roomy) <= budget) return roomy;

  const tight = `${money} ${percent}`;
  if (displayWidth(tight) <= budget) return tight;

  return money;
}

/* ------------------------------------------------------------------ *
 * 总览
 * ------------------------------------------------------------------ */

interface Metric {
  label: string;
  value: string;
  color: string;
}

/** 单行指标网格：按终端宽度决定每行几个、以及是否附带收益率 */
function MetricGrid({
  metrics,
  perRow,
  cellWidth,
  cp,
}: {
  metrics: Metric[];
  perRow: number;
  cellWidth: number;
  cp: ColorFn;
}) {
  const rows: Metric[][] = [];
  for (let i = 0; i < metrics.length; i += perRow) {
    rows.push(metrics.slice(i, i + perRow));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, rowIdx) => (
        <Box key={rowIdx}>
          {row.map((metric) => (
            <Box key={metric.label} width={cellWidth} flexShrink={0}>
              <Text>
                <Text dimColor>{metric.label}</Text>
                <Text> </Text>
                <Text bold {...cp(metric.color)}>
                  {truncateDisplay(metric.value, Math.max(4, cellWidth - displayWidth(metric.label) - 1))}
                </Text>
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function OverviewBody({
  overview,
  layout,
  columns,
  cp,
}: {
  overview: OverviewData;
  layout: AccountLayout;
  columns: number;
  cp: ColorFn;
}) {
  const { card, summary } = overview;

  const perRow = layout.metricColumns;
  const cellWidth = Math.max(16, Math.floor((columns - 4) / perRow));

  const metrics: Metric[] = [
    { label: "总资产", value: formatMoney(card.asset), color: COLORS.selected },
    {
      label: "当日盈亏",
      value: moneyWithRate(
        "当日盈亏",
        formatSignedMoney(card.dayProfit),
        card.dayRate,
        cellWidth,
      ),
      color: trendColor(card.dayProfit),
    },
    {
      label: "累计盈亏",
      value: moneyWithRate("累计盈亏", formatSignedMoney(card.profit), card.rate, cellWidth),
      color: trendColor(card.profit),
    },
    { label: "可用余额", value: nullable(formatMoney, summary?.moneyRemain), color: COLORS.normal },
    { label: "总市值", value: nullable(formatMoney, summary?.marketValue), color: COLORS.normal },
    { label: "仓位", value: nullable(formatRatio, summary?.positionRate), color: COLORS.normal },
    {
      label: "总负债",
      value: nullable(formatMoney, summary?.liability),
      color: summary?.liability ? COLORS.warn : COLORS.dim,
    },
    {
      label: "持仓 / 账户",
      value: `${card.positions.length} 只 / ${card.members ?? 1} 个`,
      color: COLORS.dim,
    },
  ];

  return (
    <Box flexDirection="column">
      <MetricGrid metrics={metrics} perRow={perRow} cellWidth={cellWidth} cp={cp} />

      {card.fundEstimate && (
        <Box marginTop={1}>
          <Text {...cp(card.fundEstimate.isEstimate ? COLORS.warn : COLORS.dim)}>
            {"  基金当日 "}
            {formatSignedMoney(card.fundEstimate.amount)}
            {card.fundEstimate.isEstimate ? "（预估）" : "（已确认）"}
            {card.fundEstimate.asOf ? `  ${card.fundEstimate.asOf}` : ""}
          </Text>
        </Box>
      )}

    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * 持仓
 * ------------------------------------------------------------------ */

function PositionSummaryLine({
  summary,
  columns,
  cp,
}: {
  summary: PositionSummary | null;
  columns: number;
  cp: ColorFn;
}) {
  if (!summary) {
    return (
      <Box>
        <Text dimColor>{"  资产概览数据暂不可用（stock_position 请求失败）"}</Text>
      </Box>
    );
  }

  // 极窄终端只保留最关键的四项
  const compact = columns < 96;
  const items: Array<[string, string, string]> = compact
    ? [
        ["总资产", formatMoney(summary.asset), COLORS.selected],
        ["总市值", nullable(formatMoney, summary.marketValue), COLORS.normal],
        ["可用", nullable(formatMoney, summary.moneyRemain), COLORS.normal],
        ["仓位", nullable(formatRatio, summary.positionRate), COLORS.normal],
      ]
    : [
        ["总资产", formatMoney(summary.asset), COLORS.selected],
        ["总市值", nullable(formatMoney, summary.marketValue), COLORS.normal],
        ["可用余额", nullable(formatMoney, summary.moneyRemain), COLORS.normal],
        ["总负债", nullable(formatMoney, summary.liability), COLORS.normal],
        ["仓位", nullable(formatRatio, summary.positionRate), COLORS.normal],
        ["数据时间", summary.uploadTime ? dataStamp(summary.uploadTime) : "—", COLORS.dim],
      ];

  // 行宽预算：每个指标至少占 17 列才读得全，放不下就少显示几项。
  // 不设预算的话长数值会把整行挤到折行，而折行会随数值长度变化帧高 —— 闪。
  const maxItems = Math.max(2, Math.floor((columns - 4) / 17));
  const visible = items.slice(0, maxItems);
  const perItem = Math.floor((columns - 4) / visible.length);

  return (
    <Box>
      {visible.map(([label, value, color]) => (
        <Box key={label} width={perItem} flexShrink={0}>
          <Text>
            <Text dimColor>{`${label} `}</Text>
            <Text bold {...cp(color)}>
              {truncateDisplay(value, Math.max(4, perItem - displayWidth(label) - 2))}
            </Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function PositionTable({
  rows,
  selectedIndex,
  start,
  layout,
  cp,
}: {
  rows: PositionRow[];
  selectedIndex: number;
  start: number;
  layout: AccountLayout;
  cp: ColorFn;
}) {
  const c = layout.position;
  return (
    <Box flexDirection="column">
      {/* 表头 */}
      <Box>
        <Box width={c.mark} />
        <Box width={c.code}>
          <Text dimColor>代码</Text>
        </Box>
        <Box width={c.name}>
          <Text dimColor>名称</Text>
        </Box>
        <Box width={c.price}>
          <Text dimColor>现价</Text>
        </Box>
        <Box width={c.dayRate}>
          <Text dimColor>当日</Text>
        </Box>
        <Box width={c.holdProfit}>
          <Text dimColor>持仓盈亏</Text>
        </Box>
        <Box width={c.holdRate}>
          <Text dimColor>收益率</Text>
        </Box>
        {c.showValue && (
          <Box width={c.value}>
            <Text dimColor>市值</Text>
          </Box>
        )}
        {c.showHoldDays && (
          <Box width={c.holdDays}>
            <Text dimColor>持有</Text>
          </Box>
        )}
        {c.showBroker && (
          <Box width={c.broker}>
            <Text dimColor>券商</Text>
          </Box>
        )}
      </Box>

      {rows.map((row, i) => {
        const index = start + i;
        const isSelected = index === selectedIndex;
        return (
          <Box key={`${row.code}-${index}`}>
            <Box width={c.mark} flexShrink={0}>
              {isSelected ? (
                <Text bold {...cp(COLORS.primary)}>
                  {"▸ "}
                </Text>
              ) : (
                <Text>{"  "}</Text>
              )}
            </Box>
            <Box width={c.code}>
              <Text bold {...cp(isSelected ? COLORS.primary : COLORS.dim)}>
                {row.code}
              </Text>
            </Box>
            <Box width={c.name}>
              <Text {...cp(isSelected ? COLORS.selected : COLORS.normal)}>
                {truncateDisplay(row.name, c.name - 1)}
              </Text>
            </Box>
            <Box width={c.price}>
              <Text {...cp(COLORS.normal)}>{truncateDisplay(row.price, c.price - 1)}</Text>
            </Box>
            <Box width={c.dayRate}>
              <Text {...cp(trendColor(row.dayProfit))}>
                {alignRight(formatPercent(row.dayRate), c.dayRate - 1)}
              </Text>
            </Box>
            <Box width={c.holdProfit}>
              <Text bold {...cp(trendColor(row.holdProfit))}>
                {alignRight(formatSignedMoney(row.holdProfit), c.holdProfit - 1)}
              </Text>
            </Box>
            <Box width={c.holdRate}>
              <Text {...cp(trendColor(row.holdRate))}>
                {alignRight(formatPercent(row.holdRate), c.holdRate - 1)}
              </Text>
            </Box>
            {c.showValue && (
              <Box width={c.value}>
                <Text {...cp(COLORS.normal)}>{alignRight(formatMoney(row.value), c.value - 1)}</Text>
              </Box>
            )}
            {c.showHoldDays && (
              <Box width={c.holdDays}>
                <Text {...cp(COLORS.dim)}>
                  {alignRight(row.holdDays ? `${row.holdDays}天` : "—", c.holdDays - 1)}
                </Text>
              </Box>
            )}
            {c.showBroker && (
              <Box width={c.broker}>
                <Text {...cp(COLORS.faint)}>{truncateDisplay(row.stockAccount || "—", c.broker - 1)}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * 持仓详情：Enter 展开，展示成本、数量、备注等表内放不下的字段。
 *
 * 宽终端按两列铺开、窄终端单列且只保留前 8 个字段 —— 目的是让面板高度
 * 与 layout.ts 的 POSITION_DETAIL_ROWS 保持一致（帧高必须可预测，见该常量注释）。
 */
function PositionDetail({
  row,
  columns,
  cp,
}: {
  row: PositionRow;
  columns: number;
  cp: ColorFn;
}) {
  const perRow = columns >= 96 ? 2 : 1;
  const cellWidth = Math.max(20, Math.floor((columns - 6) / perRow));

  const allEntries: Array<[string, string, string]> = [
    ["证券代码", row.code, COLORS.normal],
    ["市场", row.market || "—", COLORS.dim],
    ["持仓数量", row.count || "—", COLORS.normal],
    ["成本价", row.cost || "—", COLORS.normal],
    ["现价", row.price || "—", COLORS.normal],
    ["持仓市值", formatMoney(row.value), COLORS.normal],
    ["当日盈亏", `${formatSignedMoney(row.dayProfit)}  ${formatPercent(row.dayRate)}`, trendColor(row.dayProfit)],
    ["持仓盈亏", `${formatSignedMoney(row.holdProfit)}  ${formatPercent(row.holdRate)}`, trendColor(row.holdProfit)],
    ["持有天数", row.holdDays ? `${row.holdDays} 天` : "—", COLORS.dim],
    ["所属账户", row.stockAccount || "—", COLORS.dim],
    ["估值日期", row.estimateDate || "—", COLORS.dim],
    ["确认净值", row.confirmDate || "—", COLORS.dim],
  ];
  const entries = perRow === 2 ? allEntries : allEntries.slice(0, 8);

  const lines: Array<Array<[string, string, string]>> = [];
  for (let i = 0; i < entries.length; i += perRow) {
    lines.push(entries.slice(i, i + perRow));
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={COLORS.faint} paddingX={1}>
      <Text bold {...cp(COLORS.primary)}>
        {`${row.name} ${row.code}`}
      </Text>
      {lines.map((line, i) => (
        <Box key={i}>
          {line.map(([label, value, color]) => (
            <Box key={label} width={cellWidth} flexShrink={0}>
              <Text>
                <Text dimColor>{`${label} `}</Text>
                <Text {...cp(color)}>
                  {truncateDisplay(value, Math.max(4, cellWidth - displayWidth(label) - 3))}
                </Text>
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {row.remark ? (
        <Text dimColor>{`备注 ${truncateDisplay(row.remark, Math.max(10, columns - 12))}`}</Text>
      ) : null}
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * 交易
 * ------------------------------------------------------------------ */

function TradeTable({
  trades,
  selectedIndex,
  start,
  layout,
  cp,
}: {
  trades: TradeData;
  selectedIndex: number;
  start: number;
  layout: AccountLayout;
  cp: ColorFn;
}) {
  const c = layout.trade;

  if (trades.unsupported) {
    return (
      <Box flexDirection="column">
        <Text {...cp(COLORS.warn)}>{"  该账户类型没有「当日成交流水」口径"}</Text>
        <Text dimColor>{"  基金类账户请改用「账户」页签查看资产，或按 t 查看历史资金流水。"}</Text>
      </Box>
    );
  }

  if (!trades.rows.length) {
    return (
      <Box>
        <Text dimColor>
          {trades.scope === "today" ? "  当日暂无成交记录" : "  该页暂无资金流水"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={c.mark} />
        <Box width={c.date}>
          <Text dimColor>{trades.scope === "today" ? "日期" : "发生日期"}</Text>
        </Box>
        <Box width={c.code}>
          <Text dimColor>代码</Text>
        </Box>
        <Box width={c.name}>
          <Text dimColor>名称</Text>
        </Box>
        <Box width={c.action}>
          <Text dimColor>操作</Text>
        </Box>
        {c.showCount && (
          <Box width={c.count}>
            <Text dimColor>数量</Text>
          </Box>
        )}
        <Box width={c.price}>
          <Text dimColor>价格</Text>
        </Box>
        <Box width={c.amount}>
          <Text dimColor>金额</Text>
        </Box>
        {c.showFee && (
          <Box width={c.fee}>
            <Text dimColor>费用</Text>
          </Box>
        )}
      </Box>

      {trades.rows.map((row, i) => {
        const index = start + i;
        const isSelected = index === selectedIndex;
        return (
          <Box key={`${row.code}-${row.date}-${index}`}>
            <Box width={c.mark} flexShrink={0}>
              {isSelected ? (
                <Text bold {...cp(COLORS.primary)}>
                  {"▸"}
                </Text>
              ) : (
                <Text>{" "}</Text>
              )}
            </Box>
            <Box width={c.date}>
              <Text {...cp(COLORS.dim)}>
                {row.date ? shortDate(row.date) : "当日"}
              </Text>
            </Box>
            <Box width={c.code}>
              <Text {...cp(isSelected ? COLORS.primary : COLORS.dim)}>{row.code || "—"}</Text>
            </Box>
            <Box width={c.name}>
              <Text {...cp(isSelected ? COLORS.selected : COLORS.normal)}>
                {truncateDisplay(row.name || "—", c.name - 1)}
              </Text>
            </Box>
            <Box width={c.action}>
              <Text {...cp(row.action.includes("卖") ? COLORS.down : COLORS.up)}>
                {truncateDisplay(row.action || "—", c.action - 1)}
              </Text>
            </Box>
            {c.showCount && (
              <Box width={c.count}>
                <Text {...cp(COLORS.normal)}>{alignRight(row.count || "—", c.count - 1)}</Text>
              </Box>
            )}
            <Box width={c.price}>
              <Text {...cp(COLORS.normal)}>{alignRight(row.price || "—", c.price - 1)}</Text>
            </Box>
            <Box width={c.amount}>
              <Text bold {...cp(trendColor(row.amount))}>
                {alignRight(formatSignedMoney(row.amount), c.amount - 1)}
              </Text>
            </Box>
            {c.showFee && (
              <Box width={c.fee}>
                <Text {...cp(COLORS.faint)}>
                  {alignRight(row.fee ? formatMoney(row.fee) : "—", c.fee - 1)}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * 账户状态
 * ------------------------------------------------------------------ */

function StatusBody({
  status,
  selectionName,
  selectionType,
  selectionId,
  accountCount,
  layout,
  cp,
}: {
  status: TabData & { kind: "status" };
  selectionName: string;
  selectionType: string;
  selectionId: string;
  accountCount: number;
  layout: AccountLayout;
  cp: ColorFn;
}) {
  const { tradingDay, summary } = status.status;
  const cellWidth = Math.max(20, Math.floor((layout.columns - 6) / layout.metricColumns));

  const metrics: Metric[] = [
    { label: "账户名称", value: truncateDisplay(selectionName, cellWidth - 10), color: COLORS.selected },
    { label: "账户类型", value: ACCOUNT_TYPE_LABEL[selectionType] ?? selectionType, color: COLORS.normal },
    { label: "账户标识", value: truncateDisplay(selectionId, cellWidth - 10), color: COLORS.dim },
    {
      label: "数据时间",
      value: summary?.uploadTime ? dataStamp(summary.uploadTime) : "—",
      color: COLORS.dim,
    },
    {
      label: "交易日",
      value: tradingDay ? (tradingDay.isTradingDay ? "是（今日开市）" : "否") : "—",
      color: tradingDay?.isTradingDay ? COLORS.up : COLORS.dim,
    },
    {
      label: "最近交易日",
      value: tradingDay?.lastTradingDay || "—",
      color: COLORS.normal,
    },
    {
      label: "下一交易日",
      value: tradingDay?.nextTradingDay || "—",
      color: COLORS.dim,
    },
    { label: "总资产", value: nullable(formatMoney, summary?.asset), color: COLORS.selected },
    { label: "总市值", value: nullable(formatMoney, summary?.marketValue), color: COLORS.normal },
    { label: "可用余额", value: nullable(formatMoney, summary?.moneyRemain), color: COLORS.normal },
    { label: "总负债", value: nullable(formatMoney, summary?.liability), color: COLORS.normal },
    { label: "仓位", value: nullable(formatRatio, summary?.positionRate), color: COLORS.normal },
    { label: "持仓数量", value: `${summary?.positions.length ?? 0} 只`, color: COLORS.normal },
    { label: "账户总数", value: `${accountCount} 个`, color: COLORS.dim },
  ];

  return (
    <Box flexDirection="column">
      <MetricGrid
        metrics={metrics}
        perRow={layout.metricColumns}
        cellWidth={cellWidth}
        cp={cp}
      />
      {!tradingDay && (
        <Box marginTop={1}>
          <Text dimColor>{"  交易日信息暂不可用（last_trading_day 请求失败）"}</Text>
        </Box>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * 未配置凭证
 * ------------------------------------------------------------------ */

function SetupPanel({ config, columns }: { config: AccountConfig; columns: number }) {
  const missing = missingAuthCookies(config.cookie);
  return (
    <Box flexDirection="column">
      <Text bold color={COLORS.warn}>
        {"  尚未配置账户凭证，无法读取账户数据"}
      </Text>
      <Text> </Text>
      <Text dimColor>{"  1. 浏览器登录投资账本（tzzb.10jqka.com.cn）后打开开发者工具"}</Text>
      <Text dimColor>{"     在 Console 执行 document.cookie 或从任意请求的请求头复制 Cookie"}</Text>
      <Text dimColor>{`  2. 保存凭证（需要 ${missing.length ? missing.join(" / ") : "userid / ticket / user"}）：`}</Text>
      <Text color={COLORS.primary}>
        {"     stocking login --cookie \"userid=...; ticket=...; user=...\""}
      </Text>
      <Text dimColor>{`  3. 或直接编辑配置文件：${truncateDisplay(ACCOUNT_CONFIG_PATH, columns - 26)}`}</Text>
      <Text dimColor>{"     也可用环境变量 TZZB_COOKIE 临时覆盖"}</Text>
      <Text> </Text>
      <Text dimColor>{"  配置完成后按 r 重新加载，或按 a 返回股票列表"}</Text>
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * 主组件
 * ------------------------------------------------------------------ */

export function AccountView({ config, initialAccountId, onBack, onExit }: AccountViewProps) {
  const { columns, rows } = useTerminalSize();
  const layout = useMemo(() => computeAccountLayout(columns, rows), [columns, rows]);

  const data = useAccountData({ config, active: true, initialAccountId });
  const { handleCtrlC } = useDoubleCtrlC(onExit);

  const [positionIndex, setPositionIndex] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tradeIndex, setTradeIndex] = useState(0);
  const [flash, setFlash] = useState<FlashState | null>(null);
  /** 置灰模式（h 键切换，与股票列表一致） */
  const [dimMode, setDimMode] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 置灰开关：把 color 换成 dimColor。反馈类文案不走这里，保持可读
  const cp: ColorFn = (c) => (dimMode ? { dimColor: true } : { color: c });

  const showFlash = useCallback((text: string, color: string = COLORS.warn) => {
    setFlash({ text, color });
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  /* --------------------------- 当前页签数据 --------------------------- */

  const tabData = data.tabData;

  const positions: PositionRow[] =
    tabData?.kind === "positions" ? tabData.positions.positions : [];

  const tradeRows: PositionRow[] | TradeData["rows"] =
    tabData?.kind === "trades" ? tabData.trades.rows : [];

  // 列表长度变化（切账户/切页签）时把选中行夹回合法范围
  useEffect(() => {
    setPositionIndex((prev) => (prev < positions.length ? prev : Math.max(0, positions.length - 1)));
    setDetailOpen(false);
  }, [positions.length]);

  useEffect(() => {
    setTradeIndex((prev) => (prev < tradeRows.length ? prev : Math.max(0, tradeRows.length - 1)));
  }, [tradeRows.length]);

  const selectedPosition = positions[positionIndex];
  const detailAvailable = canShowPositionDetail(layout);

  // 终端被缩小时若已展开详情，面板会超出可视高度 → 自动收起，避免 Ink 滚动重绘
  useEffect(() => {
    if (!detailAvailable) setDetailOpen(false);
  }, [detailAvailable]);

  /* ------------------------------ 键盘 ------------------------------ */

  useInput(
    useCallback(
      (input: string, key: { ctrl: boolean; shift: boolean; tab: boolean; escape: boolean; return: boolean; upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean }) => {
        if (input === "c" && key.ctrl) {
          handleCtrlC();
          return;
        }

        // 返回股票列表
        if (input === "a" || key.escape || input === "q") {
          onBack();
          return;
        }

        // 账户切换（←/→ 与 [ ] 双通道，兼容部分 Windows 终端的 ESC 序列）
        if (key.leftArrow || input === "\x1b[D" || input === "\x1bOD" || input === "[") {
          if (data.selectable.length > 1) {
            data.moveSelection(-1);
            showFlash("← 上一个账户");
          }
          return;
        }
        if (key.rightArrow || input === "\x1b[C" || input === "\x1bOC" || input === "]") {
          if (data.selectable.length > 1) {
            data.moveSelection(1);
            showFlash("→ 下一个账户");
          }
          return;
        }

        // 页签切换
        if (key.tab) {
          data.cycleTab(key.shift ? -1 : 1);
          return;
        }
        if (/^[1-4]$/.test(input)) {
          const next = ACCOUNT_TAB_KEYS[Number(input) - 1];
          if (next) data.selectTab(next);
          return;
        }

        // 刷新 / 暂停
        if (input === "r") {
          data.refresh();
          showFlash("⟳ 正在刷新账户数据…", COLORS.primary);
          return;
        }
        if (input === "p") {
          data.togglePaused();
          showFlash(data.paused ? "▶ 已恢复自动刷新" : "❚❚ 已暂停自动刷新", COLORS.warn);
          return;
        }

        // 交易页专属
        if (data.tab === "trades") {
          if (input === "t") {
            const next = data.tradeScope === "today" ? "history" : "today";
            data.changeScope(next);
            showFlash(next === "today" ? "口径：当日成交" : "口径：历史资金流水");
            return;
          }
          if (data.tradeScope === "history" && (input === "n" || input === "b")) {
            if (!data.historyMaxPage) {
              showFlash("流水尚未加载完成", COLORS.dim);
              return;
            }
            data.gotoHistoryPage(data.historyPage + (input === "n" ? 1 : -1));
            return;
          }
        }

        // 置灰（与股票列表 h 键一致）
        if (input === "h") {
          setDimMode((v) => !v);
          showFlash(dimMode ? "已恢复彩色" : "已切换为置灰", COLORS.warn);
          return;
        }

        // 列表选择
        if (key.upArrow || input === "k") {
          if (data.tab === "trades") {
            setTradeIndex((prev) => (prev > 0 ? prev - 1 : tradeRows.length - 1));
          } else {
            setPositionIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, positions.length - 1)));
          }
          return;
        }
        if (key.downArrow || input === "j") {
          if (data.tab === "trades") {
            setTradeIndex((prev) => (prev < tradeRows.length - 1 ? prev + 1 : 0));
          } else {
            setPositionIndex((prev) => (prev < positions.length - 1 ? prev + 1 : 0));
          }
          return;
        }

        // 持仓详情（高度放不下时明确拒绝，而不是让画面溢出滚动）
        if (key.return && data.tab === "positions") {
          if (!positions.length) return;
          if (!detailAvailable) {
            showFlash("终端高度不足，放大窗口后再看详情", COLORS.warn);
            return;
          }
          setDetailOpen((prev) => !prev);
          return;
        }
      },
      [
        data,
        handleCtrlC,
        onBack,
        positions.length,
        tradeRows.length,
        detailAvailable,
        showFlash,
      ],
    ),
  );

  /* ------------------------------ 渲染 ------------------------------ */

  const selection = data.selection;
  const selectionLabel = selection
    ? `${ACCOUNT_TYPE_LABEL[selection.type] ?? selection.type}`
    : "—";

  const statusText = data.credentialIssue
    ? "未配置凭证"
    : data.loading
      ? "⟳ 刷新中…"
      : data.paused
        ? "❚❚ 已暂停"
        : `${data.countdown}s 后自动刷新`;

  /*
   * 宽度预算。
   *
   * 行内容一旦超过终端宽度就会折行，折行数又会随数值/状态文案的长度变化，
   * 帧高因此在两次刷新之间跳变 —— 在 Windows 终端上就是肉眼可见的闪烁。
   * 所以顶部三行与页脚都按「显式预算 + 截断」排布，保证每行恒占一行。
   */
  const tabNameWidth = layout.tiny ? 6 : layout.compact ? 9 : 14;
  const header = computeHeaderLayout({
    columns,
    clockText: `🕐 ${data.now}`,
    statusText,
    tabNameWidth,
  });

  const tabStrip = useMemo(
    () => computeWindow(data.selectable.length, data.selectionIndex, header.stripCapacity),
    [data.selectable.length, data.selectionIndex, header.stripCapacity],
  );

  // 第二行右侧（环境 · 账户类型）在窄终端让位给页签
  const showScope = columns >= 72;
  const showRow2Right = columns >= 56;
  // 只展示账户类型：接口环境属于内部实现，不面向客户暴露
  const row2RightText = truncateDisplay(selectionLabel, Math.max(8, columns - 40));

  const divider = "─".repeat(Math.max(20, columns - 2));

  /* 主体 */
  let body: React.ReactNode = null;

  if (data.credentialIssue) {
    body = <SetupPanel config={config} columns={columns} />;
  } else if (data.bootError) {
    body = (
      <Box flexDirection="column">
        <Text bold color={COLORS.error}>{"  账户列表加载失败"}</Text>
        <ErrorBar error={data.bootError} columns={columns} />
        <Text dimColor>{"  按 r 重试；若持续失败请检查网络连接后稍后再试。"}</Text>
      </Box>
    );
  } else if (data.bootLoading || !data.accounts.length) {
    body = <Text {...cp(COLORS.primary)}>{"  ⟳ 正在加载账户列表…"}</Text>;
  } else if (!tabData) {
    body = (
      <Box flexDirection="column">
        <Text {...cp(COLORS.primary)}>{"  ⟳ 正在加载账户数据…"}</Text>
        {data.error ? <ErrorBar error={data.error} columns={columns} /> : null}
      </Box>
    );
  } else if (tabData.kind === "overview") {
    body = (
      <OverviewBody overview={tabData.overview} layout={layout} columns={columns} cp={cp} />
    );
  } else if (tabData.kind === "positions") {
    const capacity = positionRowCapacity(layout, detailOpen);
    const slice = computeWindow(positions.length, positionIndex, capacity);
    body = (
      <Box flexDirection="column">
        <PositionSummaryLine summary={tabData.positions} columns={columns} cp={cp} />
        <Text dimColor>{`  ${divider.slice(0, Math.max(20, columns - 4))}`}</Text>
        {detailOpen && selectedPosition ? (
          <PositionDetail row={selectedPosition} columns={columns} cp={cp} />
        ) : null}
        {positions.length ? (
          <PositionTable
            rows={sliceWindow(positions, slice)}
            selectedIndex={positionIndex}
            start={slice.start}
            layout={layout}
            cp={cp}
          />
        ) : (
          <Text dimColor>{"  该账户当前没有持仓"}</Text>
        )}
      </Box>
    );
  } else if (tabData.kind === "trades") {
    const capacity = tradeRowCapacity(layout);
    const slice = computeWindow(tradeRows.length, tradeIndex, capacity);
    const meta = tabData.trades.meta;
    body = (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            {tabData.trades.scope === "today"
              ? `  当日成交流水  共 ${tabData.trades.rows.length} 笔`
              : `  历史资金流水  第 ${data.historyPage}/${meta?.maxPage ?? 1} 页  共 ${meta?.total ?? 0} 条`}
          </Text>
          {tradeRows.length > 0 && (
            <Text dimColor>{`   显示 ${slice.start + 1}-${slice.end}`}</Text>
          )}
        </Box>
        <Text dimColor>{`  ${divider.slice(0, Math.max(20, columns - 4))}`}</Text>
        <TradeTable
          trades={tabData.trades}
          selectedIndex={tradeIndex}
          start={slice.start}
          layout={layout}
          cp={cp}
        />
      </Box>
    );
  } else {
    body = (
      <StatusBody
        status={tabData}
        selectionName={selection?.name ?? "—"}
        selectionType={selection?.type ?? "—"}
        selectionId={selection?.id ?? "—"}
        accountCount={data.accounts.length}
        layout={layout}
        cp={cp}
      />
    );
  }

  /* 键位提示：随宽度裁剪 */
  const hintWide =
    "a/q 返回股票  ←/→ 账户  Tab/1-4 页签  ↑/↓ 选择  Enter 详情  t 口径  n/b 翻页  r 刷新  p 暂停  h 置灰  Ctrl+C 退出";
  const hintTiny = "a 返回  ←→ 账户  Tab 页签  ↑↓ 选择  r 刷新  h 置灰  q 返回";
  const hint = layout.tiny ? hintTiny : hintWide;

  return (
    <Box flexDirection="column">
      {/* 行 1：账户切换 + 时钟 / 刷新状态 */}
      <Box justifyContent="space-between">
        <Box flexShrink={0}>
          {header.showStrip ? (
            <>
              {tabStrip.above > 0 ? <Text dimColor>{"‹ "}</Text> : null}
              {data.selectable.slice(tabStrip.start, tabStrip.end).map((item, i) => {
                const index = tabStrip.start + i;
                const active = index === data.selectionIndex;
                return (
                  <Text key={item.id}>
                    <Text
                      bold={active}
                      inverse={active}
                      {...cp(active ? COLORS.primary : COLORS.dim)}
                    >
                      {` ${truncateDisplay(item.name, tabNameWidth)} `}
                    </Text>
                    <Text>{" "}</Text>
                  </Text>
                );
              })}
              {tabStrip.below > 0 ? <Text dimColor>{`› +${tabStrip.below}`}</Text> : null}
              {!data.selectable.length ? <Text dimColor>{"（暂无账户）"}</Text> : null}
            </>
          ) : (
            <Text dimColor>
              {truncateDisplay(selection?.name ?? "（暂无账户）", header.stripBudget)}
            </Text>
          )}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{header.rightText}</Text>
        </Box>
      </Box>

      {/* 行 2：页签 + 账户类型 / 环境 */}
      <Box justifyContent="space-between">
        <Box>
          {ACCOUNT_TABS.map((tab, i) => {
            const active = tab.key === data.tab;
            return (
              <Text key={tab.key}>
                <Text
                  bold={active}
                  inverse={active}
                  {...cp(active ? COLORS.primary : COLORS.dim)}
                >
                  {` ${i + 1} ${tab.label} `}
                </Text>
                <Text>{" "}</Text>
              </Text>
            );
          })}
          {data.tab === "trades" && showScope ? (
            <Text>
              <Text dimColor>{" │ "}</Text>
              <Text
                bold={data.tradeScope === "today"}
                inverse={data.tradeScope === "today"}
                {...cp(data.tradeScope === "today" ? COLORS.up : COLORS.dim)}
              >
                {" 当日 "}
              </Text>
              <Text
                bold={data.tradeScope === "history"}
                inverse={data.tradeScope === "history"}
                {...cp(data.tradeScope === "history" ? COLORS.primary : COLORS.dim)}
              >
                {" 历史 "}
              </Text>
            </Text>
          ) : null}
        </Box>
        {showRow2Right ? (
          <Box flexShrink={0}>
            <Text dimColor>{row2RightText}</Text>
          </Box>
        ) : null}
      </Box>

      {/* 行 3：分割线 */}
      <Text dimColor>{`  ${divider}`}</Text>

      {/* 错误条（保留旧数据，仅提示） */}
      {data.error && !data.credentialIssue ? (
        <ErrorBar error={data.error} columns={columns} />
      ) : null}

      {/* 主体 */}
      {body}

      {/* 页脚：两行，且两行都不允许折行（见上方宽度预算说明） */}
      <Box marginTop={1}>
        <Text dimColor>{"  "}{truncateDisplay(hint, Math.max(20, columns - 4))}</Text>
      </Box>
      <Box>
        {flash ? (
          // 反馈文案与「最后更新」互斥显示，保证这一行恒为一行
          <Text color={flash.color}>
            {"  "}
            {truncateDisplay(flash.text, Math.max(10, columns - 4))}
          </Text>
        ) : (
          <>
            <Text dimColor>{"  最后更新: "}{data.lastUpdate || "—"}</Text>
            {data.loading ? <Text dimColor>{"   ⟳ 刷新中…"}</Text> : null}
          </>
        )}
      </Box>
    </Box>
  );
}

export type { AccountTabKey };
