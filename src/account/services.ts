// ---------------------------------------------------------------------------
// 账户视图 · 服务层
//
// 对应 tzzb-ext 的 services/normalize.js + services/account.js + services/asset.js，
// 另加两处扩展里没有、CLI 需求明确要求的口径：
//   - fetchDayTrading    当日成交流水（merge_day_trading）
//   - fetchMoneyHistory  历史资金流水（get_money_history，分页）
//
// 对外契约（与扩展一致）：
//   * 所有「服务端字段 → 视图字段」的转换都发生在本文件与 aggregate.ts 内；
//   * 所有比率统一为**百分数**，换算在这里收口，组件层不做除法；
//   * 本层不吞异常，可选项的容错由 loaders.ts 用 optional() 包裹。
// ---------------------------------------------------------------------------

import {
  ACCOUNT_GROUPS,
  ACCOUNT_PARAM_KEY,
  API,
  CODE,
  FUND_ACCOUNT_TYPES,
  FUND_ID_FIELD,
  FUND_TYPE_ALIAS,
  HISTORY_PAGE_SIZE,
  LAYER,
  STOCK_ACCOUNT_TYPES,
  type TradeScope,
} from "./constants.js";
import { ApiError, isCancelledError, request } from "./request.js";
import {
  localDate,
  safeNumber,
  safeString,
  withHkPrefix,
} from "./format.js";
import type {
  Account,
  AggregateAccount,
  AssetTrend,
  OverviewCard,
  PositionRow,
  PositionSummary,
  SelectableAccount,
  TradeData,
  TradeRow,
  TradingDayInfo,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/** 数组兜底：非数组一律返回空数组 */
export function pickArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 对象兜底：非对象一律返回空对象 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 可选请求：失败不抛出，返回 fallback。
 *
 * 注意这里**刻意不写 console**：Ink 接管了整个终端输出，运行期向
 * stdout/stderr 打印会把界面顶花。可选项缺失由组件层显式降级展示
 * （例如走势缺失时渲染「走势数据暂不可用」），保证用户看得到反馈。
 * 需要排查时用 STOCKING_DEBUG=1 打开日志。
 */
export async function optional<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    // 主动取消必须向上传播，否则切账户时会留下脏数据
    if (isCancelledError(err)) throw err;
    if (process.env["STOCKING_DEBUG"]) {
      process.stderr.write(`[stocking] 可选项失败 ${label}: ${(err as Error).message}\n`);
    }
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * 账户列表
 * ------------------------------------------------------------------ */

/** 组装视图层消费的账户对象 */
function toAccount(input: {
  type: unknown;
  requestId: unknown;
  name: unknown;
}): Account {
  const type = safeString(input.type);
  const id = safeString(input.requestId);
  return {
    id,
    name: safeString(input.name),
    type,
    requestId: id,
    paramKey: ACCOUNT_PARAM_KEY[type] ?? "manual_id",
  };
}

/**
 * 账户列表归一化，复刻原插件 module 26369 的 iw(ex_data)。
 *
 * 响应按**分组**返回：`ex_data = { manual, common, rzrq, fund }`，需要拍平并补齐
 * type / requestId / name —— `list` 是 iw 归一化后交给上层的字段名，不是接口原始字段，
 * 直接读 `ex_data.list` 会永远拿到空数组。
 *
 * 若服务端确实返回扁平的 `ex_data.list`（旧文档写法），回落到该分支。
 */
export function normalizeAccountList(data: unknown): Account[] {
  const root = asRecord(data);
  const list: Account[] = [];

  // 股票类三组：common（自动同步）/ rzrq（两融）/ manual（手动记账）
  for (const { key, type, idField } of ACCOUNT_GROUPS) {
    for (const item of pickArray(root[key])) {
      const row = asRecord(item);
      const requestId = safeString(row[idField] ?? row["manual_id"]);
      if (!requestId) continue;
      list.push(
        toAccount({
          type,
          requestId,
          name: row["manualname"] ?? row["qsmc"] ?? row["fundname"],
        }),
      );
    }
  }

  // 基金组：type 需经别名表归一化（manFund → fundManual），ID 字段随类型变化
  for (const item of pickArray(root["fund"])) {
    const row = asRecord(item);
    const type = FUND_TYPE_ALIAS[safeString(row["type"])] ?? safeString(row["type"]);
    const idField = FUND_ID_FIELD[type];
    const requestId = safeString((idField ? row[idField] : undefined) ?? row["manual_id"]);
    if (!type || !requestId) continue;
    list.push(
      toAccount({ type, requestId, name: row["fundname"] ?? row["manualname"] }),
    );
  }

  if (list.length) return list;

  // 兜底：兼容扁平 list 形状（requestId 由服务端直接给出）
  return pickArray(root["list"])
    .map((item) => {
      const row = asRecord(item);
      return toAccount({
        type: row["type"],
        requestId: row["requestId"] ?? row["manual_id"],
        name: row["manualname"],
      });
    })
    .filter((account) => Boolean(account.type && account.requestId));
}

/**
 * 账户列表
 * POST /caishen_fund/pc/account/v1/account_list
 */
export async function fetchAccountList(): Promise<Account[]> {
  const data = await request<Record<string, unknown>>(API.accountList, {});
  return normalizeAccountList(data);
}

/* ------------------------------------------------------------------ *
 * 汇总账户与参数构造
 * ------------------------------------------------------------------ */

/** 类型守卫：是否为虚拟汇总账户 */
export function isAggregateAccount(
  account: SelectableAccount | null | undefined,
): account is AggregateAccount {
  return Boolean(account && account.isAggregate);
}

/**
 * 把全部账户拼成一个虚拟的汇总账户。
 * 依据：原码 iw(ex_data) 返回的 manual_id / common / rzrq / fundManual / ijj
 * 均为**逗号分隔**的 id 串。
 */
export function buildAggregateAccount(accounts: Account[]): AggregateAccount {
  const join = (type: string) =>
    accounts
      .filter((account) => account.type === type)
      .map((account) => account.requestId)
      .join(",");

  return {
    id: "__all__",
    name: `汇总（全部 ${accounts.length} 个账户）`,
    type: "all",
    isAggregate: true,
    count: accounts.length,
    hasStock: accounts.some((account) => STOCK_ACCOUNT_TYPES.includes(account.type)),
    groups: {
      manual_id: join("manual"),
      common: join("stockCommon"),
      rzrq: join("stockRzrq"),
      fundManual: join("fundManual"),
      ijj: join("ijj"),
    },
  };
}

/**
 * 由账户对象构造查询参数（多账户合并查询时至少一个非空）。
 * 汇总账户五路都传逗号串 —— asset_trend / time_share / merge_compare
 * 的原码调用点就是这个形状。
 */
export function buildAccountParams(account: SelectableAccount): Record<string, string> {
  if (isAggregateAccount(account)) {
    const { groups } = account;
    return {
      manual_id: groups.manual_id,
      fund_key: groups.common,
      rzrq_fund_key: groups.rzrq,
      fundid: groups.fundManual,
      custid: groups.ijj,
    };
  }
  if (account.type === "ijj") return { custid: account.requestId };
  return { [account.paramKey]: account.requestId };
}

/** stock_position 只接受股票侧三路（原码 requestStockPosition 的参数形状） */
export function buildStockParams(account: SelectableAccount): Record<string, string> {
  if (!isAggregateAccount(account)) {
    // 单个基金账户在股票侧没有对应参数，返回空对象交给调用方判定
    const key = ACCOUNT_PARAM_KEY[account.type];
    return key === "manual_id" || key === "fund_key" || key === "rzrq_fund_key"
      ? { [key]: account.requestId }
      : {};
  }
  const { groups } = account;
  return { manual_id: groups.manual_id, fund_key: groups.common, rzrq_fund_key: groups.rzrq };
}

/**
 * merge_day_trading 只认股票侧三路参数（docs/API.md 3.1.x），
 * 基金账户在该接口上没有任何合法参数，返回空对象由调用方提示「无此口径」。
 */
export function buildDayTradingParams(account: SelectableAccount): Record<string, string> {
  return buildStockParams(account);
}

/* ------------------------------------------------------------------ *
 * 归一化：持仓与序列
 * ------------------------------------------------------------------ */

/**
 * 由「盈亏 + 市值」反推收益率（百分数）。
 *
 * ## 为什么不直接用服务端的 pre_rate / hold_rate
 *
 * 这两个字段的量纲**不可靠**：
 *   - `tzzb-ext/docs/API.md` 的示例标注它们为「原样百分数」（hold_rate "10.56" = 10.56%）；
 *   - 但实测 `stock_position` 返回的是**小数** —— 市值 14,844 / 持仓盈亏 -902.59
 *     时服务端给的是 -0.0573，按百分数直接展示就成了 -0.06%，与旁边显示的
 *     市值、盈亏自相矛盾（真实收益率是 -5.73%）。
 * 文档自己也在 3.2.5 备注了「同一响应内量纲不统一，必须逐字段确认」，
 * 因此这里不再猜测量纲。
 *
 * ## 采用的口径
 *
 * 会计恒等式：持仓成本 = 市值 − 持仓盈亏，收益率 = 盈亏 ÷ 成本 × 100。
 * 与 `aggregate.ts` 汇总卡片的算法完全一致（那里已注释「已用真实账户与服务端
 * rate 逐位校验过」），并且用文档自带的两个示例反算即可复现服务端数值：
 *   - stock_position：市值 168050、持仓盈亏 16050 → 10.56%（= 文档 hold_rate）
 *   - merge_fund：    市值 10948、持仓盈亏 948   → 9.48% （= 文档 pospercent）
 *
 * 好处是页面上「市值 / 盈亏 / 收益率」三者永远自洽，不会再出现同一行内
 * 数字互相打架的情况；代价是放弃服务端在摊薄成本等特殊口径下的算法差异。
 */
export function rateFromProfit(profit: unknown, value: unknown): number {
  const p = safeNumber(profit);
  const v = safeNumber(value);
  if (v === 0) return 0;
  const basis = v - p;
  return basis !== 0 ? (p / basis) * 100 : 0;
}

/**
 * 仓位（百分数）= 市值 ÷ 总资产 × 100。
 *
 * 与收益率同样是「不信任服务端量纲」的字段：实测总资产 60,554.81 /
 * 总市值 60,405.50 时服务端给的是 0.9975，按百分数直接展示就成了 1.00%，
 * 而真实仓位是 99.75%（docs/API.md 也只写「仓位」未标注量纲）。
 *
 * 同一份响应里资产与市值都是成对给出的，用它们反推可以让页面上
 * 「总资产 / 总市值 / 仓位」三者永远自洽。
 *
 * @returns 总资产为 0 时返回 null（组件渲染为 —，而不是伪造一个 0%）
 */
export function positionRateOf(marketValue: unknown, asset: unknown): number | null {
  const mv = safeNumber(marketValue);
  const total = safeNumber(asset);
  return total !== 0 ? (mv / total) * 100 : null;
}

/**
 * 持仓行归一化。
 * stock_card.position 与 stock_position.position 服务端字段同构，
 * 统一在此转换，避免出现两套形状。
 *
 * 注意：本函数同时是**股票侧持仓收益率的唯一换算点** —— 单账户持仓、
 * 汇总持仓、账户卡片里的持仓都经由它，改这里即可覆盖全部展示路径。
 */
export function toPosition(item: unknown): PositionRow {
  const row = asRecord(item);
  const code = safeString(row["code"]);
  const market = safeString(row["market"]);
  const value = safeNumber(row["value"]);
  const dayProfit = safeNumber(row["pre_profit"]);
  const holdProfit = safeNumber(row["hold_profit"]);

  return {
    code,
    name: safeString(row["name"]),
    market,
    price: withHkPrefix(code, market, row["price"]),
    priceRaw: safeNumber(row["price"]),
    count: safeString(row["count"]),
    holdDays: safeString(row["hold_days"]),
    cost: withHkPrefix(code, market, row["cost"]),
    value,
    // 当日盈亏 / 当日收益率（百分数，由盈亏与市值反推）
    dayProfit,
    dayRate: rateFromProfit(dayProfit, value),
    // 持仓盈亏 / 持仓收益率（百分数，由盈亏与市值反推）
    holdProfit,
    holdRate: rateFromProfit(holdProfit, value),
    remark: safeString(row["remark"]),
    stockAccount: safeString(row["stock_account"]),
  };
}

/** 时间序列：[{date, <valueKey>}] → [{date, value}] */
export function toSeries(list: unknown, valueKey = "profit"): Array<{ date: string; value: number }> {
  return pickArray(list).map((point) => {
    const row = asRecord(point);
    return { date: safeString(row["date"]), value: safeNumber(row[valueKey]) };
  });
}

/* ------------------------------------------------------------------ *
 * 账户卡片
 * ------------------------------------------------------------------ */

/**
 * 账户卡片：总资产 / 当日盈亏 / 累计盈亏 / 持仓
 * POST stock_card（股票类）| fund_card（基金类）
 *
 * 需 ignoreEnvelope：该接口成功时 error_code 为 "0"，但 ex_data 可能为空对象。
 *
 * 比率不再直接取服务端字段，而是由「盈亏 ÷ (资产 − 盈亏)」反推（见 rateFromProfit）。
 * 实测该式与 tzzb-ext 记录的字段值互相印证：累计收益率反推得 17.11%，
 * 与服务端 rate = 0.1711（小数）一致；当日收益率反推得 0.68%，与 now_rate = 0.68
 * （百分数）一致 —— 也就是说同一接口的两个字段量纲确实不同，
 * 反推法对两者都能得到正确结果，因此不再逐字段猜量纲。
 */
export async function fetchAccountCard(
  account: Account,
  options: { withStockAccount?: boolean } = {},
): Promise<OverviewCard> {
  const isFundGroup = FUND_ACCOUNT_TYPES.includes(account.type);
  const path = isFundGroup ? API.fundCard : API.stockCard;
  const params = buildAccountParams(account);

  // 原码 _getRequestAccountCardParam：hk 组（手动/自动/两融）走 stock_card 且不带
  // init_time_flag；U1 组（手动基金/爱基金）走 fund_card 且必带 init_time_flag。
  if (isFundGroup) params["init_time_flag"] = options.withStockAccount ? "1" : "0";

  const raw = await request<Record<string, unknown>>(path, params, { ignoreEnvelope: true });
  const code = String(raw["error_code"] ?? "");

  if (code === CODE.ACCOUNT_DELETED) {
    throw new ApiError("该账户已被删除", { code, layer: LAYER.BUSINESS });
  }
  if (code !== CODE.SUCCESS || !raw["ex_data"]) {
    throw new ApiError(String(raw["error_msg"] ?? "") || "请求异常", { code });
  }

  const data = asRecord(raw["ex_data"]);
  const asset = safeNumber(data["asset"]);
  const dayProfit = safeNumber(data["now_profit"]);
  const profit = safeNumber(data["profit"]);

  return {
    asset,
    dayProfit,
    profit,
    // 收益率同样改为反推，理由见 rateFromProfit：
    // 服务端 stock_card.rate 是小数量纲、now_rate 号称是百分数，而同一后端在
    // stock_position 上给的又是小数 —— 逐字段猜量纲不可靠。
    // 反推法对两种量纲都能得到正确结果，并且与「汇总」账户、与持仓行口径完全一致，
    // 避免用户在「汇总」和单账户之间切换时看到收益率相差 100 倍。
    dayRate: rateFromProfit(dayProfit, asset),
    rate: rateFromProfit(profit, asset),
    positions: pickArray(data["position"]).map(toPosition),
  };
}

/* ------------------------------------------------------------------ *
 * 资产
 * ------------------------------------------------------------------ */

/**
 * 资产走势
 * POST /caishen_fund/pc/asset/v1/asset_trend
 *
 * 注：界面当前不展示走势图，取数链路已不再调用该函数（详见 types.ts 的说明）。
 * 保留实现是为了让资产域保持与 tzzb-ext 对齐，后续需要时可直接接回。
 */
export async function fetchAssetTrend(account: SelectableAccount): Promise<AssetTrend> {
  const data = await request<Record<string, unknown>>(API.assetTrend, buildAccountParams(account));
  return {
    monthAssets: toSeries(data["total_asset"], "asset"),
    monthProfits: toSeries(data["month_profit"], "profit"),
    monthInitAsset: safeNumber(data["month_init_zczs"]),
    yearInitAsset: safeNumber(data["year_init_zczs"]),
  };
}

/**
 * 股票持仓汇总
 * POST /caishen_fund/pc/asset/v1/stock_position
 *
 * @param isMerge 汇总账户传 true（服务端按 is_merge 区分单账户 / 多账户合并）
 */
export async function fetchStockPosition(
  account: SelectableAccount,
  isMerge = false,
): Promise<PositionSummary> {
  const data = await request<Record<string, unknown>>(API.stockPosition, {
    ...buildStockParams(account),
    is_merge: isMerge ? "1" : "0",
  });

  const marketValue = safeNumber(data["total_value"]);
  const asset = safeNumber(data["total_asset"]);

  return {
    uploadTime: safeString(data["upload_time"]),
    liability: safeNumber(data["total_liability"]),
    moneyRemain: safeNumber(data["money_remain"]),
    marketValue,
    asset,
    // 不用服务端的 position_rate：它是小数（0.9975），量纲与文档不符（见 positionRateOf）
    positionRate: positionRateOf(marketValue, asset),
    positions: pickArray(data["position"]).map(toPosition),
    members: 1,
  };
}

/**
 * 由基金账户卡片构造持仓汇总。
 * 基金侧没有「可用余额 / 总负债」口径，显式置 null（组件渲染为 —），
 * 而不是填 0 —— 0 会被误读成「余额为零」。
 */
export function fundCardToSummary(card: OverviewCard): PositionSummary {
  const marketValue = card.positions.reduce((sum, row) => sum + safeNumber(row.value), 0);
  return {
    uploadTime: "",
    liability: null,
    moneyRemain: null,
    marketValue,
    asset: card.asset,
    positionRate: positionRateOf(marketValue, card.asset),
    positions: card.positions,
    members: 1,
  };
}

/* ------------------------------------------------------------------ *
 * 交易
 * ------------------------------------------------------------------ */

/** 当日成交行归一化（merge_day_trading.data[]） */
function toDayTrade(item: unknown): TradeRow {
  const row = asRecord(item);
  const code = safeString(row["zqdm"]);
  const market = safeString(row["market"]);
  return {
    // 该接口不返回成交时间，只有「当日」这一层语义
    date: "",
    code,
    name: safeString(row["zqmc"]),
    action: safeString(row["czlx"]),
    count: safeString(row["cjsl"]),
    price: withHkPrefix(code, market, row["cjjg"]),
    // 成本变动：买为负、卖为正
    amount: safeNumber(row["moneychg"]),
    fee: safeNumber(row["fee"]),
    broker: safeString(row["stock_account"]),
    market,
    remark: "",
  };
}

/**
 * 当日成交流水
 * POST /caishen_fund/pc/account/v1/merge_day_trading
 *
 * @returns unsupported = true 表示该账户类型在服务端没有这个口径（基金账户）
 */
export async function fetchDayTrading(account: SelectableAccount): Promise<TradeData> {
  const params = buildDayTradingParams(account);
  if (!Object.values(params).some((value) => value)) {
    return { scope: "today", rows: [], meta: null, unsupported: true };
  }

  const data = await request<Record<string, unknown>>(API.mergeDayTrading, params);
  return {
    scope: "today",
    rows: pickArray(data["data"]).map(toDayTrade),
    meta: null,
    unsupported: false,
  };
}

/** 历史流水行归一化（get_money_history.list[]） */
function toHistoryTrade(item: unknown): TradeRow {
  const row = asRecord(item);
  const code = safeString(row["code"]);
  const market = safeString(row["market_code"]);
  return {
    date: safeString(row["entry_date"]),
    code,
    name: safeString(row["name"]),
    action: safeString(row["op_name"]) || safeString(row["op"]),
    count: safeString(row["entry_count"]),
    price: withHkPrefix(code, market, row["entry_price"]),
    // 金额：买负卖正
    amount: safeNumber(row["entry_money"]),
    fee: safeNumber(row["fee_total"]),
    broker: "",
    market,
    remark: safeString(row["remark"]),
  };
}

/**
 * 历史资金流水（分页）
 * POST /caishen_fund/pc/account/v2/get_money_history
 *
 * 该接口要求下划线形式的 `user_id`（由 request 层统一注入 userid + user_id），
 * 账户标识五路至少一个非空。
 */
export async function fetchMoneyHistory(
  account: SelectableAccount,
  page = 1,
): Promise<TradeData> {
  const data = await request<Record<string, unknown>>(API.moneyHistory, {
    ...buildAccountParams(account),
    page: String(Math.max(1, page)),
    count: String(HISTORY_PAGE_SIZE),
  });

  const rows = pickArray(data["list"]).map(toHistoryTrade);
  // 服务端未保证跨页有序，这里按日期倒序稳定排序（同日内保持服务端顺序）
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const maxPage = Math.max(1, safeNumber(data["max_page"]) || 1);
  return {
    scope: "history",
    rows,
    meta: {
      page: Math.min(maxPage, Math.max(1, safeNumber(data["page"]) || page)),
      maxPage,
      total: safeNumber(data["count"]),
    },
    unsupported: false,
  };
}

/* ------------------------------------------------------------------ *
 * 交易日
 * ------------------------------------------------------------------ */

/**
 * 最近交易日
 * POST /caishen_fund/stock_common/v1/last_trading_day
 */
export async function fetchTradingDay(): Promise<TradingDayInfo> {
  const data = await request<Record<string, unknown>>(API.lastTradingDay, {});
  return {
    isTradingDay: String(data["is_trading_day"]) === "1",
    lastTradingDay: safeString(data["last_trading_day"]),
    nextTradingDay: safeString(data["next_trading_day"]),
    prevTradingDay: safeString(data["prev_trading_day"]),
    isHkTradingDay: String(data["is_hk_trading_day"]) === "1",
    // 服务端偶发返回不可解析的数值，展示前请走 format.dataStamp 兜底
    systemTime: safeString(data["system_time"]),
  };
}

/* ------------------------------------------------------------------ *
 * 基金侧聚合（merge_fund）
 * ------------------------------------------------------------------ */

export interface FundAggregate {
  transDate: string;
  /** 当日初始资产 */
  startAsset: number;
  /** 当前总资产（含当日预估盈亏） */
  asset: number;
  dayProfit: number;
  sumProfit: number;
  funds: PositionRow[];
  /** 估值日期 / 确认净值日期集合，供 isEstimateWindow 判断 */
  estimateDates: string[];
  confirmDates: string[];
}

/** merge_fund 的 fund[] → 与 toPosition() 同构的持仓行，组件层无需区分来源 */
export function toFundPosition(item: unknown): PositionRow {
  const row = asRecord(item);
  const estimatePrice = safeString(row["now_price"]);
  return {
    code: safeString(row["fundcode"]),
    name: safeString(row["fundname"]),
    market: "",
    // 优先展示估值价，估值缺失时退回确认净值
    price: estimatePrice || safeString(row["conf_price"]),
    priceRaw: safeNumber(row["now_price"] || row["conf_price"]),
    count: safeString(row["fundcount"]),
    holdDays: safeString(row["leftday"]),
    cost: safeString(row["percost"]),
    value: safeNumber(row["fundvalue"]),
    dayProfit: safeNumber(row["now_profit"]),
    // now_rate 服务端为「百分数 × 100」（docs 3.2.5），÷100 归一到百分数
    dayRate: safeNumber(row["now_rate"]) / 100,
    holdProfit: safeNumber(row["posprofit"]),
    holdRate: safeNumber(row["pospercent"]),
    remark: "",
    stockAccount: "",
    estimateDate: safeString(row["now_date"]),
    confirmDate: safeString(row["conf_nav_date"]),
    confirmProfit: safeNumber(row["conf_profit"]),
  };
}

/**
 * 基金侧聚合（**含当日预估收益**）
 * POST /caishen_fund/fund/v1/merge_fund
 *
 * 响应 account.total_asset 是「不含当日预估收益」的口径，而
 * account.now_start_value（当日初始资产）+ account.now_profit（当日盈亏，估值口径）
 * 才是当前总资产，因此这里按会计恒等式还原。
 *
 * @returns 不含基金账户时返回 null，不发起请求
 */
export async function fetchMergeFund(accounts: Account[]): Promise<FundAggregate | null> {
  const custIds = accounts.filter((a) => a.type === "ijj").map((a) => a.requestId);
  const fundIds = accounts.filter((a) => a.type === "fundManual").map((a) => a.requestId);
  if (!custIds.length && !fundIds.length) return null;

  const data = await request<Record<string, unknown>>(API.mergeFund, {
    from_id: "pcweb",
    custid: custIds.join(","),
    fundid: fundIds.join(","),
  });

  const account = asRecord(data["account"]);
  const funds = pickArray(data["fund"]).map(toFundPosition);
  const dayProfit = safeNumber(account["now_profit"]);
  const startAsset = safeNumber(account["now_start_value"]);

  return {
    transDate: safeString(account["trans_date"]),
    startAsset,
    asset: startAsset ? startAsset + dayProfit : safeNumber(account["total_asset"]),
    dayProfit,
    sumProfit: safeNumber(account["total_sumprofit"]),
    funds,
    estimateDates: funds.map((f) => f.estimateDate ?? "").filter(Boolean),
    confirmDates: funds.map((f) => f.confirmDate ?? "").filter(Boolean),
  };
}

/**
 * 是否应标注「预估」。
 *
 * 服务端对基金天然区分「当日估值」与「确认净值」：
 *   now_profit / now_price / now_date        ← 估值（预估）
 *   conf_profit / conf_price / conf_nav_date ← 已确认
 * 因此「预估还是真实」不需要客户端按小时换算金额，只看三件事：
 *   1. 服务端给了**当日**估值；
 *   2. 当日净值尚未确认；
 *   3. 未到 ESTIMATE_CUTOFF_HOUR（20 点前标注，20 点后不再自称预估）。
 * 任一不成立就去掉标注 —— 数字始终是服务端那一个，不会因标注消失而跳变。
 */
export function isEstimateWindow(
  fundAggregate: FundAggregate | null,
  now: Date = new Date(),
): boolean {
  if (!fundAggregate) return false;
  const today = localDate(now);
  return (
    fundAggregate.estimateDates.includes(today) &&
    !fundAggregate.confirmDates.includes(today) &&
    now.getHours() < 20
  );
}

/* ------------------------------------------------------------------ *
 * 账户异步计算任务（拉取前的可选触发）
 * ------------------------------------------------------------------ */

export const TRADE_SCOPES: readonly TradeScope[] = ["today", "history"];
