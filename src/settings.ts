// ---------------------------------------------------------------------------
// settings.json 读写
//
// 文件路径：~/.stocking/settings.json
//
// 配置结构（v2，多分组）：
//   { "groups": [
//       { "name": "分组1",
//         "symbols": [
//           { "code": "sh000001", "buyPrice": 3200, "sellPrice": 3400 },
//           { "code": "sh601899" }
//         ]
//       },
//       { "name": "分组2", "symbols": [...] }
//   ] }
//
// v1 兼容：旧文件可能是 { symbols: [...] } 扁平结构。loadStockConfig()
// 会自动迁移成单分组并就地写回新结构。buyPrice / sellPrice 可选，
// 缺失或非法值时该方向不参与触发判断。
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import type { Group, StockSymbol } from "./types.js";

/** settings.json 绝对路径 */
export const SETTINGS_PATH = join(os.homedir(), ".stocking", "settings.json");

/** 默认两个分组（首次启动、配置无效时兜底） */
export const DEFAULT_GROUPS: Group[] = [
  { name: "分组1", symbols: [{ code: "sh000001" }, { code: "sz399300" }, { code: "sh601899" }] },
  { name: "分组2", symbols: [] },
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

/** 清洗单个分组：去空、去重、限制 name 长度 */
function normalizeGroup(raw: unknown): Group | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name =
    typeof o["name"] === "string" && o["name"].trim().length > 0
      ? o["name"].trim().slice(0, 32)
      : "未命名分组";
  const rawSymbols = o["symbols"];
  if (!Array.isArray(rawSymbols)) return { name, symbols: [] };
  const seen = new Set<string>();
  const cleaned: StockSymbol[] = [];
  for (const s of rawSymbols) {
    const sym = normalizeSymbol(s);
    if (!sym) continue;
    if (seen.has(sym.code)) continue;
    seen.add(sym.code);
    cleaned.push(sym);
  }
  return { name, symbols: cleaned };
}

/**
 * 读自选股配置（v2 形态）。内部会：
 * 1. 文件不存在 → 写入默认两组，返回默认配置；notifier 收到 "created"
 * 2. 解析失败 / 段缺失 / 全无效 → 返回默认配置（不写盘）；notifier 收到 "fallback"
 * 3. 命中 v1（{ symbols: [...] }）→ 迁移成单分组，就地写回 v2；notifier 收到 "migrated"
 * 4. 命中 v2 且只有 1 个分组 → 补上「分组2」（含 sh601318），就地写回；notifier 收到 "augmented"
 * 5. 命中 v2 且有 ≥ 2 个分组 → 跨组去重后返回（无 notifier）
 */
export function loadStockConfig(opts?: {
  notify?: (kind: "created" | "migrated" | "augmented" | "fallback") => void;
}): Group[] {
  const notify = opts?.notify;

  if (!existsSync(SETTINGS_PATH)) {
    const fresh = cloneDefaultGroups();
    writeStockConfig(fresh);
    notify?.("created");
    return fresh;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    const fallback = cloneDefaultGroups();
    notify?.("fallback");
    return fallback;
  }

  // v1：顶层 symbols 存在（数组）→ 迁移
  if (Array.isArray(parsed["symbols"])) {
    const v1Symbols = parsed["symbols"] as unknown[];
    const cleaned: StockSymbol[] = [];
    const seen = new Set<string>();
    for (const raw of v1Symbols) {
      const sym = normalizeSymbol(raw);
      if (!sym || seen.has(sym.code)) continue;
      seen.add(sym.code);
      cleaned.push(sym);
    }
    const migrated: Group[] = [{ name: "分组1", symbols: cleaned }];
    writeStockConfig(migrated);
    notify?.("migrated");
    return migrated;
  }

  // v2
  if (Array.isArray(parsed["groups"])) {
    const groups = (parsed["groups"] as unknown[])
      .map(normalizeGroup)
      .filter((g): g is Group => g !== null);
    if (groups.length > 0) {
      // 组内去重之外，跨组也去重：把重复代码归到第一个出现的组
      const seen = new Set<string>();
      const dedup: Group[] = [];
      for (const g of groups) {
        const filtered: StockSymbol[] = [];
        for (const s of g.symbols) {
          if (seen.has(s.code)) continue;
          seen.add(s.code);
          filtered.push(s);
        }
        dedup.push({ name: g.name, symbols: filtered });
      }
      // 单分组 → 自动补「分组2」（含 sh601318），跨组去重后 sh601318 留在第一组也无所谓
      if (dedup.length === 1) {
        const augmented: Group[] = [
          dedup[0]!,
          { name: "分组2", symbols: [{ code: "sh601318" }] },
        ];
        writeStockConfig(augmented);
        notify?.("augmented");
        return augmented;
      }
      return dedup;
    }
  }

  const fallback = cloneDefaultGroups();
  notify?.("fallback");
  return fallback;
}

/** 写自选股配置（v2 形态） */
export function saveStockConfig(groups: Group[]): void {
  writeStockConfig(groups);
}

function writeStockConfig(groups: Group[]): void {
  const path = resolve(SETTINGS_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ groups }, null, 2) + "\n", "utf-8");
}

function cloneDefaultGroups(): Group[] {
  return DEFAULT_GROUPS.map((g) => ({ name: g.name, symbols: g.symbols.map((s) => ({ ...s })) }));
}