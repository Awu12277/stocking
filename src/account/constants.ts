// ---------------------------------------------------------------------------
// 账户视图 · 常量
//
// 移植自 tzzb-ext 的 src/constants.js（依据 tzzb-ext/docs/API.md），
// 已剔除全部 Chrome 扩展专有内容（cookie 读写、登录中心 iframe、chrome.storage）。
//
// 与扩展的关键差异：CLI 拿不到浏览器 Cookie 存储，凭证改为从
// ~/.stocking/account.json 读取，并在请求头里以 `Cookie: ...` 直传。
// ---------------------------------------------------------------------------

/** 接口环境 */
export type EnvKey = "pro" | "pretest";

export interface EnvConfig {
  label: string;
  /** 业务接口域名（不带尾部斜杠） */
  server: string;
  /** 站点入口：仅用于拼装 Referer / Origin，规避站点侧防盗链校验 */
  pageUrl: string;
}

export const ENVS: Record<EnvKey, EnvConfig> = {
  pro: {
    label: "正式环境",
    server: "https://tzzb.10jqka.com.cn",
    pageUrl: "https://tzzb.10jqka.com.cn/pc/index.html",
  },
  pretest: {
    label: "预发环境",
    server: "https://pretestcapital.hexin.cn",
    pageUrl: "https://pretestcapital.hexin.cn/pc/index.html",
  },
};

export const DEFAULT_ENV: EnvKey = "pro";

export const ENV_KEYS: EnvKey[] = ["pro", "pretest"];

/** 判断字符串是否为合法环境名 */
export function isEnvKey(value: unknown): value is EnvKey {
  return typeof value === "string" && Object.hasOwn(ENVS, value);
}

/* ------------------------------------------------------------------ *
 * 请求协议
 * ------------------------------------------------------------------ */

/** 所有业务接口统一前缀 */
export const FORWARD_PREFIX = "/caishen_httpserver/tzzb";

/** 每次请求自动注入的公共参数 */
export const COMMON_PARAMS: Record<string, string> = {
  terminal: "1",
  version: "0.0.0",
};

/** 鉴权 Cookie：缺 userid 即视为未登录 */
export const AUTH_COOKIES = ["userid", "ticket", "user"] as const;

/** 响应信封字段 */
export const ENVELOPE = {
  CODE: "error_code",
  MSG: "error_msg",
  DATA: "ex_data",
} as const;

/** 业务错误码 */
export const CODE = {
  SUCCESS: "0",
  ACCOUNT_DELETED: "-2",
  DUPLICATE_DELETE: "-200",
  DUPLICATE_ADD: "-300",
} as const;

/** 异常分层，便于界面差异化提示 */
export const LAYER = {
  NETWORK: "network",
  BUSINESS: "business",
  FORMAT: "format",
  UNKNOWN: "unknown",
} as const;

export type Layer = (typeof LAYER)[keyof typeof LAYER];

/** 单次请求超时（ms） */
export const DEFAULT_TIMEOUT = 15_000;

/** 网络层失败自动重试次数（不含首次） */
export const DEFAULT_RETRIES = 2;

/* ------------------------------------------------------------------ *
 * 接口路径（与 tzzb-ext/docs/API.md 一一对应）
 * ------------------------------------------------------------------ */

export const API = {
  // 账户
  accountList: "/caishen_fund/pc/account/v1/account_list",
  stockCard: "/caishen_fund/pc/account/v1/stock_card",
  fundCard: "/caishen_fund/pc/account/v1/fund_card",
  mergeDayTrading: "/caishen_fund/pc/account/v1/merge_day_trading",
  moneyHistory: "/caishen_fund/pc/account/v2/get_money_history",

  // 资产
  assetTrend: "/caishen_fund/pc/asset/v1/asset_trend",
  stockPosition: "/caishen_fund/pc/asset/v1/stock_position",
  mergeFund: "/caishen_fund/fund/v1/merge_fund",

  // 行情辅助
  lastTradingDay: "/caishen_fund/stock_common/v1/last_trading_day",
} as const;

/* ------------------------------------------------------------------ *
 * 账户类型
 * ------------------------------------------------------------------ */

/** 股票类账户类型 */
export const STOCK_ACCOUNT_TYPES: readonly string[] = ["manual", "stockCommon", "stockRzrq"];

/** 基金 / 爱基金类账户类型 */
export const FUND_ACCOUNT_TYPES: readonly string[] = ["fundManual", "ijj"];

/** 账户类型 -> 请求参数名 */
export const ACCOUNT_PARAM_KEY: Record<string, string> = {
  manual: "manual_id",
  stockCommon: "fund_key",
  stockRzrq: "rzrq_fund_key",
  fundManual: "fundid",
  ijj: "custid",
};

/** 账户类型中文名 */
export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  manual: "手动记账",
  stockCommon: "自动同步",
  stockRzrq: "融资融券",
  fundManual: "手动基金",
  ijj: "爱基金",
  all: "汇总",
};

/** 汇总账户（全部账户合计）的虚拟 id */
export const AGGREGATE_ID = "__all__";

/**
 * account_list 的响应按**分组**返回，不是扁平 list：
 *   ex_data = { manual: [], common: [], rzrq: [], fund: [] }
 * 顺序与源码 iw() 的拼接顺序一致。
 */
export const ACCOUNT_GROUPS: ReadonlyArray<{ key: string; type: string; idField: string }> = [
  { key: "common", type: "stockCommon", idField: "fund_key" },
  { key: "rzrq", type: "stockRzrq", idField: "fund_key" },
  { key: "manual", type: "manual", idField: "manualid" },
];

/** 基金分组内 type 的别名（manFund → fundManual） */
export const FUND_TYPE_ALIAS: Record<string, string> = {
  ijj: "ijj",
  manFund: "fundManual",
};

/** 从 fund 分组元素上取账户 ID 的字段名 */
export const FUND_ID_FIELD: Record<string, string> = {
  ijj: "custid",
  fundManual: "fundId",
};

/**
 * 基金预估口径的展示截止小时（本地时间）。
 * 只影响是否打「预估」标记，不参与任何数值换算 —— 数字始终取服务端返回。
 */
export const ESTIMATE_CUTOFF_HOUR = 20;

/* ------------------------------------------------------------------ *
 * 账户视图自身
 * ------------------------------------------------------------------ */

/** 账户视图页签（顺序即界面顺序，数字键 1-4 与之对应） */
export const ACCOUNT_TABS = [
  { key: "overview", label: "总览" },
  { key: "positions", label: "持仓" },
  { key: "trades", label: "交易" },
  { key: "status", label: "账户" },
] as const;

export type AccountTabKey = (typeof ACCOUNT_TABS)[number]["key"];

export const ACCOUNT_TAB_KEYS: readonly AccountTabKey[] = ACCOUNT_TABS.map((t) => t.key);

export function isAccountTabKey(value: unknown): value is AccountTabKey {
  return typeof value === "string" && (ACCOUNT_TAB_KEYS as readonly string[]).includes(value);
}

/** 交易页的数据口径 */
export type TradeScope = "today" | "history";

/** 默认自动刷新间隔（秒）。账户数据变动不快，10s 足够且比 30s 更"实时" */
export const DEFAULT_REFRESH_SECONDS = 10;

/**
 * 改版前的默认刷新间隔。
 * 只用于一次性迁移：识别「旧版本写入的默认值」并更新为当前默认值。
 */
export const LEGACY_REFRESH_SECONDS = 30;

/**
 * 配置文件结构版本。改动默认值或字段语义时递增，
 * 让 loadAccountConfig 能对用户已落盘的配置做一次性迁移。
 */
export const CONFIG_VERSION = 2;

/** 自动刷新间隔上下限，防止把服务端刷爆或界面几乎不动 */
export const MIN_REFRESH_SECONDS = 5;
export const MAX_REFRESH_SECONDS = 3600;

/** 历史流水每页条数 */
export const HISTORY_PAGE_SIZE = 20;

/** 账户配置文件（放在既有配置目录 ~/.stocking/ 下） */
export const ACCOUNT_CONFIG_FILE = "account.json";

/** 界面配色（与股票列表保持同一套终端主题） */
export const COLORS = {
  primary: "#00ffff",
  up: "#ff1493",
  down: "#00ff41",
  selected: "#ffffff",
  normal: "#cccccc",
  dim: "#888888",
  faint: "#666666",
  warn: "#ffcc00",
  error: "#ff5555",
  accent: "#c792ea",
} as const;
