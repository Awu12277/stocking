// ---------------------------------------------------------------------------
// 账户视图 · 格式化工具
//
// 移植自 tzzb-ext/src/format.js，额外补充终端列宽相关的显示宽度工具
// （Ink 的 <Box width> 只约束容器，文本超长仍会溢出，所以名称类字段
//  需要在渲染前按「终端显示列数」截断）。
//
// ## 单位约定（全项目唯一口径，改动前先读这里）
//
// | 概念 | 服务层存放形态 | 展示 |
// | --- | --- | --- |
// | 金额 | 元，number | formatMoney / formatSignedMoney |
// | 收益率、涨跌幅 | **百分数**：0.68 表示 0.68% | formatPercent |
// | 仓位 | 百分数：96.65 表示 96.65% | formatRatio |
//
// formatPercent 不接受「是否 ÷100」这类开关 —— 换算一律在服务层完成。
// ---------------------------------------------------------------------------

import { COLORS } from "./constants.js";

/** 空值安全字符串 */
export function safeString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** 空值安全数字（非法值回落为 0） */
export function safeNumber(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ *
 * 数值
 * ------------------------------------------------------------------ */

/** 金额：千分位 + 固定小数位 */
export function formatMoney(v: unknown, digits = 2): string {
  const n = safeNumber(v);
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 带符号金额 */
export function formatSignedMoney(v: unknown, digits = 2): string {
  const n = safeNumber(v);
  return (n > 0 ? "+" : "") + formatMoney(n, digits);
}

/** 大额金额自适应：≥ 1 亿用「亿」，≥ 1 万用「万」，否则原样 */
export function formatCompactMoney(v: unknown): string {
  const n = safeNumber(v);
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return formatMoney(n);
}

/** 带符号百分比（入参已是**百分数**，如 0.68 表示 0.68%） */
export function formatPercent(v: unknown, digits = 2): string {
  const n = safeNumber(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** 纯百分比，不带符号（用于仓位等） */
export function formatRatio(v: unknown): string {
  return `${safeNumber(v).toFixed(2)}%`;
}

/** 可空数值：null 渲染为破折号（表示服务端无此字段，而非 0） */
export function formatNullable(fn: (v: unknown) => string, v: number | null): string {
  return v === null || v === undefined ? "—" : fn(v);
}

/**
 * 港股金额加 HK$ 前缀（与源码 iw() 的判定逻辑一致）。
 * 港股判定：market === "15" 或代码以 HK 开头。
 */
export function withHkPrefix(code: unknown, market: unknown, value: unknown): string {
  const isHk = String(market) === "15" || /^HK/i.test(safeString(code));
  const text = safeString(value);
  return isHk && text !== "" ? `HK$${text}` : text;
}

/** 涨跌方向：1 涨 / -1 跌 / 0 平 */
export function trendOf(v: unknown): number {
  const n = safeNumber(v);
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/** 涨跌颜色（A 股习惯：红涨绿跌，与股票列表同一套主题） */
export function trendColor(v: unknown): string {
  const t = trendOf(v);
  if (t > 0) return COLORS.up;
  if (t < 0) return COLORS.down;
  return COLORS.dim;
}

/** 涨跌箭头 */
export function trendArrow(v: unknown): string {
  const t = trendOf(v);
  if (t > 0) return "▲";
  if (t < 0) return "▼";
  return "—";
}

/* ------------------------------------------------------------------ *
 * 日期
 * ------------------------------------------------------------------ */

/** 本地日期 YYYY-MM-DD */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 日期：YYYY-MM-DD -> MM/DD */
export function shortDate(date: unknown): string {
  const s = safeString(date);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? `${m[2]}/${m[3]}` : s;
}

/** 本地时间 HH:MM:SS */
export function clockTime(now: Date = new Date()): string {
  return now.toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 「数据时间」展示值：服务端给的是可解析的日期时间就用它，否则回退本地时间。
 * 实测 last_trading_day 的 system_time 偶发返回不可解析的数值（如 17897165777717），
 * 直接透传会在界面上露出原始数字。
 */
export function dataStamp(serverTime: unknown, now: Date = new Date()): string {
  const raw = safeString(serverTime);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 * 终端显示宽度
//
// Ink 内部用 string-width 度量文本，这里需要同口径的估算能力来
// 预截断名称类字段。覆盖：CJK / 全角 / 韩文 / emoji 记 2 列，
// 组合符与零宽字符记 0 列，其余记 1 列。ANSI 转义序列先剥离。
 * ------------------------------------------------------------------ */

/** 剥离 ANSI 转义序列（用于度量带样式的字符串） */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** 是否占两列的码点 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // 康熙部首 / CJK 符号
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 ~ CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 是否零宽（组合符 / 变体选择符 / 零宽连接符） */
function isZeroWidthCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

/** 字符串在终端占用的列数 */
export function displayWidth(text: unknown): number {
  const raw = stripAnsi(safeString(text));
  let width = 0;
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // 控制字符不占位
    if (isZeroWidthCodePoint(cp)) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度截断，超出时补省略号 */
export function truncateDisplay(text: unknown, width: number): string {
  const raw = safeString(text);
  if (width <= 0) return "";
  if (displayWidth(raw) <= width) return raw;
  const budget = width - 1;
  let out = "";
  let used = 0;
  for (const ch of raw) {
    const w = displayWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** 按显示宽度右对齐补空格（用于金额列） */
export function alignRight(text: unknown, width: number): string {
  const t = truncateDisplay(text, width);
  const pad = width - displayWidth(t);
  return pad > 0 ? " ".repeat(pad) + t : t;
}

/** 按显示宽度左对齐补空格 */
export function alignLeft(text: unknown, width: number): string {
  const t = truncateDisplay(text, width);
  const pad = width - displayWidth(t);
  return pad > 0 ? t + " ".repeat(pad) : t;
}
