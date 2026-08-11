// ---------------------------------------------------------------------------
// settings.json 读写
//
// stocking 独立使用 ~/.stocking/settings.json。
// 结构：
//   { "symbols": [
//       { "code": "sh601899", "buyPrice": 32.5, "sellPrice": 38 },
//       { "code": "sh000001" }
//   ] }
// buyPrice / sellPrice 可选，缺失或非法值时该方向不参与触发判断。
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import type { StockConfig, StockSymbol } from "./types.js";

/** settings.json 绝对路径 */
export const SETTINGS_PATH = join(os.homedir(), ".stocking", "settings.json");

/** 默认自选股（找不到配置时兜底） */
export const DEFAULT_SYMBOLS: StockConfig["symbols"] = [
  { code: "sh000001" },
  { code: "sz399300" },
  { code: "sh601899" },
];

/** 只接受正数价格，其余（非数字 / ≤ 0 / NaN）一律视为未配置 */
function normalizePrice(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return undefined;
  return n;
}

/** 清洗单条自选股配置（容错：字段缺失 / 类型错误时降级为未配置） */
function normalizeSymbol(raw: unknown): StockSymbol | null {
  if (typeof raw === "string") return { code: raw };
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["code"] !== "string" || o["code"].length === 0) return null;
  return {
    code: o["code"],
    ...(typeof o["name"] === "string" ? { name: o["name"] } : {}),
    ...(normalizePrice(o["buyPrice"]) !== undefined
      ? { buyPrice: normalizePrice(o["buyPrice"])! }
      : {}),
    ...(normalizePrice(o["sellPrice"]) !== undefined
      ? { sellPrice: normalizePrice(o["sellPrice"])! }
      : {}),
  };
}

/** 读自选股配置（容错：文件不存在 / 解析失败 / 段缺失时回退默认） */
export function loadStockConfig(): StockConfig {
  try {
    if (!existsSync(SETTINGS_PATH)) return { symbols: [...DEFAULT_SYMBOLS] };
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const symbols = parsed["symbols"];
    if (Array.isArray(symbols) && symbols.length > 0) {
      const cleaned = symbols
        .map(normalizeSymbol)
        .filter((s): s is StockSymbol => s !== null);
      if (cleaned.length > 0) return { symbols: cleaned };
    }
  } catch {
    /* fallthrough */
  }
  return { symbols: [...DEFAULT_SYMBOLS] };
}

/** 写自选股配置 */
export function saveStockConfig(symbols: StockConfig["symbols"]): void {
  const path = resolve(SETTINGS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ symbols }, null, 2) + "\n", "utf-8");
}
