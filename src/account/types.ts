// ---------------------------------------------------------------------------
// 账户视图 · 类型定义
//
// 约定（与 tzzb-ext 一致，改动前先读 format.ts 顶部「单位约定」）：
// - 金额字段一律是「元」的 number；
// - 比率 / 涨跌幅 / 收益率字段一律是**百分数**（0.68 表示 0.68%）；
//   服务端各接口原始量纲不一致，换算全部在 services.ts / loaders.ts 内完成；
// - 服务端原始字段名不允许泄漏到组件层。
// ---------------------------------------------------------------------------

import type { AccountTabKey, EnvKey, Layer, TradeScope } from "./constants.js";

export type { AccountTabKey, EnvKey, Layer, TradeScope };

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export interface AccountConfig {
  env: EnvKey;
  /** 鉴权 Cookie 原始串：`userid=..; ticket=..; user=..` */
  cookie: string;
  /** 自动刷新间隔（秒） */
  refreshSeconds: number;
  /** 上次选中的账户 id，下次启动自动恢复 */
  lastAccount?: string;
  /** 配置文件实际路径 */
  path: string;
  /** 凭证来源，用于启动提示 */
  source: "file" | "env" | "flag";
}

/** 加载配置时对外抛出的事件（供入口打印提示） */
export type ConfigNotice =
  | { kind: "created"; path: string }
  | { kind: "fallback"; path: string; reason: string }
  | { kind: "patched"; path: string; fields: string[] }
  /** 旧版本配置的一次性迁移（例如把过期的默认刷新间隔更新为当前默认值） */
  | { kind: "migrated"; path: string; fields: string[] };

/* ------------------------------------------------------------------ *
 * 账户
 * ------------------------------------------------------------------ */

export interface Account {
  id: string;
  name: string;
  /** manual | stockCommon | stockRzrq | fundManual | ijj */
  type: string;
  requestId: string;
  /** 该账户对应的请求参数名，如 manual_id / fund_key */
  paramKey: string;
  isAggregate?: false;
}

export interface AggregateAccount {
  id: string;
  name: string;
  type: "all";
  isAggregate: true;
  /** 参与汇总的账户数 */
  count: number;
  /** 该批账户里是否含股票类（决定 fund_card 的 init_time_flag 等） */
  hasStock: boolean;
  /** 逗号分隔的多账户标识，字段名与原插件 iw() 的返回一致 */
  groups: {
    manual_id: string;
    common: string;
    rzrq: string;
    fundManual: string;
    ijj: string;
  };
}

/** 账户切换器里可选的一行 */
export type SelectableAccount = Account | AggregateAccount;

/* ------------------------------------------------------------------ *
 * 持仓
 * ------------------------------------------------------------------ */

export interface PositionRow {
  code: string;
  name: string;
  market: string;
  /** 展示用价格字符串（港股带 HK$ 前缀） */
  price: string;
  priceRaw: number;
  count: string;
  holdDays: string;
  cost: string;
  value: number;
  /** 当日盈亏 / 当日收益率（百分数） */
  dayProfit: number;
  dayRate: number;
  /** 持仓盈亏 / 持仓收益率（百分数） */
  holdProfit: number;
  holdRate: number;
  remark: string;
  stockAccount: string;
  /** 基金专属：估值日期与确认净值日期，用于判断是否处于预估窗口 */
  estimateDate?: string;
  confirmDate?: string;
  confirmProfit?: number;
}

/**
 * 持仓汇总。
 * `liability` / `moneyRemain` / `marketValue` / `positionRate` 为 `null`
 * 表示**该口径下服务端没有对应字段**（例如基金账户没有「可用余额」），
 * 组件层统一渲染为 `—`，不要当成 0。
 */
export interface PositionSummary {
  /** 数据更新时间（服务端） */
  uploadTime: string;
  liability: number | null;
  moneyRemain: number | null;
  marketValue: number | null;
  asset: number;
  positionRate: number | null;
  positions: PositionRow[];
  /** 实际取到数据的账户数（汇总口径下用于提示部分失败） */
  members: number;
}

/* ------------------------------------------------------------------ *
 * 总览
 * ------------------------------------------------------------------ */

/**
 * 资产走势序列。
 *
 * 注意：界面当前**不再展示走势图**（`fetchAssetTrend` 已从取数链路移除），
 * 该结构与对应的服务函数仅作为已逆向的接口资产保留，便于后续按需启用。
 */
export interface TrendSeries {
  date: string;
  value: number;
}

export interface AssetTrend {
  monthAssets: TrendSeries[];
  monthProfits: TrendSeries[];
  monthInitAsset: number;
  yearInitAsset: number;
}

export interface FundEstimateInfo {
  amount: number;
  asOf: string;
  isEstimate: boolean;
}

export interface OverviewCard {
  asset: number;
  dayProfit: number;
  /** 当日收益率（百分数） */
  dayRate: number;
  profit: number;
  /** 累计收益率（百分数） */
  rate: number;
  positions: PositionRow[];
  /** 汇总口径下实际取到数据的账户数 */
  members?: number;
  /** 基金侧预估信息 */
  fundEstimate?: FundEstimateInfo | null;
}

export interface OverviewData {
  card: OverviewCard;
  /** 资产概览指标（可用余额 / 市值 / 仓位 / 负债），失败为 null */
  summary: PositionSummary | null;
}

/* ------------------------------------------------------------------ *
 * 交易
 * ------------------------------------------------------------------ */

export interface TradeRow {
  /** 成交日期；「当日成交」口径下服务端不返回该字段，为空串 */
  date: string;
  code: string;
  name: string;
  /** 操作名称：买入 / 卖出 / 银证转入 … */
  action: string;
  count: string;
  price: string;
  /** 金额：买负卖正 */
  amount: number;
  fee: number;
  broker: string;
  market: string;
  remark: string;
}

export interface HistoryMeta {
  page: number;
  maxPage: number;
  total: number;
}

export interface TradeData {
  scope: TradeScope;
  rows: TradeRow[];
  meta: HistoryMeta | null;
  /** 该账户类型在服务端没有对应口径（如基金账户没有当日成交流水） */
  unsupported: boolean;
}

/* ------------------------------------------------------------------ *
 * 账户状态
 * ------------------------------------------------------------------ */

export interface TradingDayInfo {
  isTradingDay: boolean;
  lastTradingDay: string;
  nextTradingDay: string;
  prevTradingDay: string;
  isHkTradingDay: boolean;
  systemTime: string;
}

export interface StatusData {
  tradingDay: TradingDayInfo | null;
  /** 账户维度的状态指标（复用持仓汇总接口的服务端字段） */
  summary: PositionSummary | null;
}

/* ------------------------------------------------------------------ *
 * 界面状态
 * ------------------------------------------------------------------ */

/** 界面内展示的错误（由 ApiError 归一化而来） */
export interface UiError {
  message: string;
  code: string;
  layer: string;
  /** 单行排查建议 */
  hint: string;
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

export interface RequestContext {
  env: EnvKey;
  cookie: string;
}

export interface RequestOptions {
  /** 默认 true（POST form-urlencoded） */
  usePost?: boolean;
  /** true 时返回完整信封，由调用方自行判断 error_code */
  ignoreEnvelope?: boolean;
  /** 是否注入 userid / user_id，默认 true */
  needUid?: boolean;
  /** 超时 ms */
  timeout?: number;
  /** 网络层失败重试次数，默认 DEFAULT_RETRIES */
  retries?: number;
  /** 外部取消信号（组件卸载 / 切换账户时中断在途请求） */
  signal?: AbortSignal;
}
