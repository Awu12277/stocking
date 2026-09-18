// ---------------------------------------------------------------------------
// 账户视图 · 视图级组合取数
//
// 把「当前选中账户 + 当前页签」翻译成一组服务调用，并聚合出组件直接可渲染的
// 结构。这一层是 CLI 新增的（扩展里等价逻辑散在 popup 控制器中）。
//
// 设计要点：
//   - 主数据（卡片 / 持仓 / 流水）失败向上抛出，由界面显示错误条并保留旧数据；
//   - 附加数据（走势、交易日、汇总指标）用 optional 降级为 null，
//     界面渲染成「暂不可用」而不是整页报错；
//   - 不吞 cancellation：切账户时在途请求被 abort，异常需要原样冒泡。
// ---------------------------------------------------------------------------

import { FUND_ACCOUNT_TYPES, STOCK_ACCOUNT_TYPES, type TradeScope } from "./constants.js";
import { fetchAggregateCard, fetchAggregatePosition } from "./aggregate.js";
import {
  fetchAccountCard,
  fetchDayTrading,
  fetchMoneyHistory,
  fetchStockPosition,
  fetchTradingDay,
  fundCardToSummary,
  isAggregateAccount,
  optional,
  positionRateOf,
} from "./services.js";
import type {
  Account,
  OverviewData,
  PositionSummary,
  SelectableAccount,
  StatusData,
  TradeData,
} from "./types.js";

/** 该批账户里是否含股票类（基金卡片请求需要知道这一点） */
function hasStockAccount(accounts: Account[]): boolean {
  return accounts.some((account) => STOCK_ACCOUNT_TYPES.includes(account.type));
}

/** 总览：卡片 + 资产概览指标（不含走势，走势图已从界面移除） */
export async function loadOverview(
  selection: SelectableAccount,
  accounts: Account[],
): Promise<OverviewData> {
  const withStockAccount = hasStockAccount(accounts);

  if (isAggregateAccount(selection)) {
    // 汇总口径下：
    //   card    → 逐个 stock_card 累加 + merge_fund（含当日预估）
    //   summary → 股票侧只借 stock_position 拿「可用余额 / 总负债」，
    //             市值与仓位直接用 card.positions 现算，
    //             从而避免再触发一次 merge_fund（网络往返减半）
    const [card, stock] = await Promise.all([
      fetchAggregateCard(accounts),
      optional(fetchStockPosition(selection, true), null, "stock_position"),
    ]);

    const marketValue = card.positions.reduce((sum, row) => sum + row.value, 0);
    const summary: PositionSummary = {
      uploadTime: stock ? stock.uploadTime : "",
      liability: stock ? stock.liability : null,
      moneyRemain: stock ? stock.moneyRemain : null,
      marketValue,
      asset: card.asset,
      positionRate: positionRateOf(marketValue, card.asset),
      positions: card.positions,
      members: card.members ?? 0,
    };

    return { card, summary };
  }

  // 基金账户：没有「可用余额 / 总负债」口径，汇总指标由卡片现算
  if (FUND_ACCOUNT_TYPES.includes(selection.type)) {
    const card = await fetchAccountCard(selection, { withStockAccount });
    return { card, summary: fundCardToSummary(card) };
  }

  // 单个股票账户：卡片与持仓汇总各取所需
  const [card, summary] = await Promise.all([
    fetchAccountCard(selection, { withStockAccount }),
    optional(fetchStockPosition(selection), null, "stock_position"),
  ]);

  return { card, summary };
}

/** 持仓：按账户类型选择合适口径 */
export async function loadPositions(
  selection: SelectableAccount,
  accounts: Account[],
): Promise<PositionSummary> {
  if (isAggregateAccount(selection)) return fetchAggregatePosition(accounts);

  if (FUND_ACCOUNT_TYPES.includes(selection.type)) {
    const card = await fetchAccountCard(selection, { withStockAccount: hasStockAccount(accounts) });
    return fundCardToSummary(card);
  }

  return fetchStockPosition(selection);
}

/** 交易：当日成交 / 历史流水 */
export async function loadTrades(
  selection: SelectableAccount,
  scope: TradeScope,
  page: number,
): Promise<TradeData> {
  return scope === "history" ? fetchMoneyHistory(selection, page) : fetchDayTrading(selection);
}

/** 账户状态：交易日历 + 资产概览 + 数据时间 */
export async function loadStatus(
  selection: SelectableAccount,
  accounts: Account[],
): Promise<StatusData> {
  const [summary, tradingDay] = await Promise.all([
    optional(loadPositions(selection, accounts), null, "position_summary"),
    optional(fetchTradingDay(), null, "last_trading_day"),
  ]);
  return { tradingDay, summary };
}
