// ---------------------------------------------------------------------------
// 行情数据获取
//
// 数据源：腾讯财经 ifzq JSON 接口（UTF-8，无需 GBK 转码）。
//   - 行情快照 + 分时数据：
//     https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=<code>&r=0.1
// 返回结构：data.<code>.data.data[] = ["HHMM price volume amount", ...]
//          data.<code>.qt.<code>[] = [1, name, code, price, ..., changePercent, ...]
// 失败时返回 null，调用方走 FALLBACK_STOCKS 兜底。
// ---------------------------------------------------------------------------

import type { StockRow } from "./types.js";

/** 行情 + 分时 复合接口 */
const MINUTE_API =
  "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}&r=0.1";

/** 缓存各股票分钟价格（key = 股票代码） */
const minuteCache = new Map<string, number[]>();

/** 给股票代码补上市场前缀（513090 → sh513090） */
function normalizeApiCode(code: string): string {
  if (code.startsWith("sh") || code.startsWith("sz")) return code;
  if (/^60|^68|^51/.test(code)) return "sh" + code;
  if (/^00|^30|^39/.test(code)) return "sz" + code;
  return "sh" + code;
}

interface MinuteResponse {
  code: number;
  data?: Record<
    string,
    {
      data?: { data?: string[]; date?: string };
      qt?: Record<string, (string | string[])[]>;
    }
  >;
}

/** 拉取单只股票的快照 + 分钟价格。与 fetchStocks 内部使用的实现一致，供详情页单独调用。 */
export async function fetchStockMinute(code: string): Promise<{
  prices: number[];
  quote: StockRow | null;
}> {
  const url = MINUTE_API.replace("{code}", normalizeApiCode(code));
  try {
    const resp = await fetch(url);
    const json = (await resp.json()) as MinuteResponse;
    if (json.code !== 0) return { prices: [], quote: null };

    const stockKey = normalizeApiCode(code);
    const stockData = json.data?.[stockKey];
    if (!stockData) return { prices: [], quote: null };

    const rawMinutes = stockData.data?.data ?? [];
    const prices: number[] = [];
    for (const line of rawMinutes) {
      const parts = line.split(" ");
      if (parts.length >= 2) {
        const p = parseFloat(parts[1]!);
        if (!isNaN(p)) prices.push(p);
      }
    }

    const qt = stockData.qt?.[stockKey] as unknown as string[] | undefined;
    let quote: StockRow | null = null;
    if (qt && qt.length >= 35) {
      quote = {
        code,
        name: qt[1] ?? "",
        price: parseFloat(qt[3] ?? "0"),
        changeAmount: parseFloat(qt[31] ?? "0"),
        changePercent: parseFloat(qt[32] ?? "0"),
        high: parseFloat(qt[33] ?? "0"),
        low: parseFloat(qt[34] ?? "0"),
        volume: parseInt(qt[6] ?? "0", 10),
        amount: parseFloat(qt[37] ?? "0") * 10_000,
      };
    }

    return { prices, quote };
  } catch {
    return { prices: [], quote: null };
  }
}

/** 取已缓存的分时数据 */
export function getCachedMinute(code: string): number[] | undefined {
  return minuteCache.get(code);
}

/** 写入分时数据缓存 */
export function setCachedMinute(code: string, prices: number[]): void {
  minuteCache.set(code, prices);
}

/** 清空缓存（仅供测试） */
export function _clearMinuteCache(): void {
  minuteCache.clear();
}

/** 失败兜底：本地默认自选股 demo 数据 */
export const FALLBACK_STOCKS: StockRow[] = [
  {
    code: "000001",
    name: "上证指数",
    price: 3150.0,
    changePercent: 0.35,
    changeAmount: 11.02,
    high: 3160.0,
    low: 3140.0,
    volume: 285_430_000,
    amount: 1_560_000_000_000,
  },
  {
    code: "601899",
    name: "紫金矿业",
    price: 18.2,
    changePercent: 1.85,
    changeAmount: 0.33,
    high: 18.45,
    low: 17.9,
    volume: 59_615_384,
    amount: 10_850_000_000,
  },
  {
    code: "399006",
    name: "创业板指",
    price: 1820.0,
    changePercent: -0.52,
    changeAmount: -9.5,
    high: 1835.0,
    low: 1815.0,
    volume: 98_650_000,
    amount: 18_240_000_000,
  },
];

/** 拉取多只股票快照（同时缓存分时数据，进详情页可复用）。
 * 注意：腾讯 ifzq 分钟接口单次只支持一个 code，多只必须并发请求。 */
export async function fetchStocks(codes: string[]): Promise<StockRow[]> {
  const results = await Promise.all(codes.map((c) => fetchStockMinute(c)));
  const real = results
    .map((r) => r.quote)
    .filter((r): r is StockRow => r !== null);
  if (real.length > 0) {
    // 缓存各股分钟数据
    for (let i = 0; i < codes.length; i++) {
      const prices = results[i]?.prices ?? [];
      if (prices.length > 0) setCachedMinute(codes[i]!, prices);
    }
    return real;
  }
  return FALLBACK_STOCKS;
}
