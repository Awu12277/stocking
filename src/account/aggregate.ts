// ---------------------------------------------------------------------------
// 账户视图 · 汇总域
//
// 移植自 tzzb-ext/src/services/aggregate.js，对应 docs/API.md 3.2.5（merge_fund）。
//
// ## 为什么汇总要自己拼
//
// 卡片接口是**单账户**的（原码 _getRequestAccountCardParam 只吃单个 requestId，
// requestAccountCard 还会先校验 isEmpty(requestId)），所以合计必须自己算：
//   - 股票侧：逐个 stock_card 累加（逐个请求，失败走 optional 跳过）
//   - 基金侧：走 merge_fund 一次拿到含「当日预估收益」的合计
//   - 持仓侧：股票侧 stock_position 多值参数 + is_merge，基金侧复用 merge_fund 明细
// ---------------------------------------------------------------------------

import { FUND_ACCOUNT_TYPES, STOCK_ACCOUNT_TYPES } from "./constants.js";
import {
  buildAggregateAccount,
  fetchAccountCard,
  fetchMergeFund,
  fetchStockPosition,
  isEstimateWindow,
  optional,
  positionRateOf,
  rateFromProfit,
  type FundAggregate,
} from "./services.js";
import { safeNumber } from "./format.js";
import type { Account, OverviewCard, PositionRow, PositionSummary } from "./types.js";

/** 该批账户里是否含股票类（决定 fund_card 的 init_time_flag 等） */
function hasStockAccount(accounts: Account[]): boolean {
  return accounts.some((account) => STOCK_ACCOUNT_TYPES.includes(account.type));
}

/** 按市值倒序，保证「持仓前 N」跨账户也正确 */
function byValueDesc(a: PositionRow, b: PositionRow): number {
  return safeNumber(b.value) - safeNumber(a.value);
}

interface FundSide {
  asset: number;
  dayProfit: number;
  profit: number;
  rows: PositionRow[];
  aggregate: FundAggregate | null;
  /** 实际取到数据的基金账户数 */
  count: number;
}

/**
 * 基金侧取值：优先 merge_fund（含当日预估），失败才回退逐个 fund_card。
 * 两条路径的降级都在这里收口，调用方不需要知道用的是哪个接口。
 */
async function fetchFundSide(
  fundAccounts: Account[],
  withStockAccount: boolean,
): Promise<FundSide> {
  if (!fundAccounts.length) {
    return { asset: 0, dayProfit: 0, profit: 0, rows: [], aggregate: null, count: 0 };
  }

  const aggregate = await optional(fetchMergeFund(fundAccounts), null, "merge_fund");
  if (aggregate) {
    return {
      asset: aggregate.asset,
      dayProfit: aggregate.dayProfit,
      profit: aggregate.sumProfit,
      rows: aggregate.funds,
      aggregate,
      count: fundAccounts.length,
    };
  }

  const cards = (
    await Promise.all(
      fundAccounts.map((account) =>
        optional(fetchAccountCard(account, { withStockAccount }), null, "fund_card"),
      ),
    )
  ).filter((card): card is OverviewCard => card !== null);

  return {
    asset: cards.reduce((sum, card) => sum + card.asset, 0),
    dayProfit: cards.reduce((sum, card) => sum + card.dayProfit, 0),
    profit: cards.reduce((sum, card) => sum + card.profit, 0),
    rows: cards.flatMap((card) => card.positions),
    aggregate: null,
    count: cards.length,
  };
}

/**
 * 汇总账户的总览卡片。
 *
 * 比率统一为**百分数**；收益率无法直接相加，按成本法反推：
 * `盈亏 ÷（资产 − 盈亏）`。该式已由 tzzb-ext 用真实账户与服务端 rate 逐位校验过。
 */
export async function fetchAggregateCard(accounts: Account[]): Promise<OverviewCard> {
  const withStockAccount = hasStockAccount(accounts);
  const stockAccounts = accounts.filter((a) => STOCK_ACCOUNT_TYPES.includes(a.type));
  const fundAccounts = accounts.filter((a) => FUND_ACCOUNT_TYPES.includes(a.type));

  const [stockCards, fund] = await Promise.all([
    Promise.all(
      stockAccounts.map((account) =>
        optional(fetchAccountCard(account, { withStockAccount }), null, "stock_card"),
      ),
    ),
    fetchFundSide(fundAccounts, withStockAccount),
  ]);

  const cards = stockCards.filter((card): card is OverviewCard => card !== null);
  const sum = (pick: (card: OverviewCard) => number) =>
    cards.reduce((total, card) => total + pick(card), 0);

  const asset = sum((c) => c.asset) + fund.asset;
  const dayProfit = sum((c) => c.dayProfit) + fund.dayProfit;
  const profit = sum((c) => c.profit) + fund.profit;

  return {
    asset,
    dayProfit,
    profit,
    // 与单账户卡片共用 rateFromProfit，保证「汇总」与「单账户」收益率口径一致
    dayRate: rateFromProfit(dayProfit, asset),
    rate: rateFromProfit(profit, asset),
    positions: [...cards.flatMap((c) => c.positions), ...fund.rows].sort(byValueDesc),
    /** 实际取到数据的账户数（用于提示部分账户失败） */
    members: cards.length + fund.count,
    fundEstimate: fund.aggregate
      ? {
          amount: fund.aggregate.dayProfit,
          asOf: fund.aggregate.transDate,
          isEstimate: isEstimateWindow(fund.aggregate),
        }
      : null,
  };
}

/**
 * 汇总账户的持仓：股票侧一次多值请求，基金侧复用 merge_fund 明细。
 * 总市值与仓位由合并后的持仓现算（服务端没有汇总口径可用）。
 */
export async function fetchAggregatePosition(accounts: Account[]): Promise<PositionSummary> {
  const aggregate = buildAggregateAccount(accounts);
  const { groups } = aggregate;
  const hasStockGroup = Boolean(groups.manual_id || groups.common || groups.rzrq);
  const fundAccounts = accounts.filter((a) => FUND_ACCOUNT_TYPES.includes(a.type));

  if (!hasStockGroup && !fundAccounts.length) {
    return {
      uploadTime: "",
      liability: null,
      moneyRemain: null,
      marketValue: 0,
      asset: 0,
      positionRate: null,
      positions: [],
      members: 0,
    };
  }

  const [stock, fund] = await Promise.all([
    hasStockGroup
      ? optional(fetchStockPosition(aggregate, true), null, "stock_position")
      : Promise.resolve(null),
    fetchFundSide(fundAccounts, aggregate.hasStock),
  ]);

  const positions = [...(stock ? stock.positions : []), ...fund.rows].sort(byValueDesc);
  const marketValue = positions.reduce((sum, row) => sum + safeNumber(row.value), 0);
  const asset = (stock ? stock.asset : 0) + fund.asset;

  return {
    uploadTime: stock ? stock.uploadTime : "",
    liability: stock ? stock.liability : null,
    moneyRemain: stock ? stock.moneyRemain : null,
    marketValue,
    asset,
    positionRate: positionRateOf(marketValue, asset),
    positions,
    members: accounts.length,
  };
}

