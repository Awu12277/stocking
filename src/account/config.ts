// ---------------------------------------------------------------------------
// 账户视图 · 配置读写
//
// 文件路径：~/.stocking/account.json（与自选股 settings.json 同目录）
//
// 结构：
//   {
//     "env": "pro",
//     "cookie": "userid=xxx; ticket=xxx; user=xxx",
//     "refreshSeconds": 30,
//     "lastAccount": "__all__"
//   }
//
// 与 tzzb-ext 的差异：浏览器扩展能从 chrome.cookies 直接读登录态，CLI 读不到，
// 因此凭证由用户显式提供（写入本文件 / 环境变量 / 命令行参数三选一）。
// 文件按 0600 落盘，避免同机其它用户直接读到 ticket。
// ---------------------------------------------------------------------------

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ACCOUNT_CONFIG_FILE,
  AUTH_COOKIES,
  CONFIG_VERSION,
  DEFAULT_ENV,
  DEFAULT_REFRESH_SECONDS,
  LEGACY_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
  isEnvKey,
} from "./constants.js";
import type { AccountConfig, ConfigNotice, EnvKey } from "./types.js";

/** 账户配置文件绝对路径 */
export const ACCOUNT_CONFIG_PATH = join(homedir(), ".stocking", ACCOUNT_CONFIG_FILE);

/* ------------------------------------------------------------------ *
 * Cookie 工具
 * ------------------------------------------------------------------ */

/** `k=v; k2=v2` -> `{k: v, k2: v2}`；非法片段忽略 */
export function parseCookie(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const text = typeof raw === "string" ? raw : "";
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 清洗用户粘贴的 Cookie：
 * 去掉换行、多余空白与首尾引号，统一成 `k=v; k2=v2` 形态。
 * 容忍整段 `Cookie: xxx` 前缀与 JSON 形式的误粘贴。
 */
export function normalizeCookie(raw: unknown): string {
  let text = typeof raw === "string" ? raw : "";
  text = text.replace(/^\s*cookie\s*:\s*/i, "");
  // 误粘贴成 JSON 对象时，尝试取出 cookie 字段
  if (text.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const candidate = parsed["cookie"] ?? parsed["Cookie"];
      if (typeof candidate === "string") text = candidate;
    } catch {
      /* 保持原样，交给后续解析 */
    }
  }
  const pairs = parseCookie(text.replace(/\s*\n\s*/g, "; "));
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** 缺失的鉴权 Cookie 名称（userid 缺失即无法发起请求） */
export function missingAuthCookies(raw: unknown): string[] {
  const jar = parseCookie(raw);
  return AUTH_COOKIES.filter((name) => !jar[name]);
}

/** 是否具备发起业务请求的最低条件（与原实现一致：以 userid 为硬性条件） */
export function hasCredentials(raw: unknown): boolean {
  return Boolean(parseCookie(raw)["userid"]);
}

/** 从 Cookie 串里取用户 ID */
export function cookieUid(raw: unknown): string {
  return parseCookie(raw)["userid"] ?? "";
}

/** 脱敏展示：只保留每个值的前 3 位 */
export function maskCookie(raw: unknown): string {
  const jar = parseCookie(raw);
  const entries = Object.entries(jar);
  if (!entries.length) return "(空)";
  return entries.map(([k, v]) => `${k}=${v.slice(0, 3)}***`).join("; ");
}

/* ------------------------------------------------------------------ *
 * 刷新间隔
 * ------------------------------------------------------------------ */

/** 把任意输入夹到 [MIN, MAX] 的整数秒；非法值回落默认 */
export function clampRefreshSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRESH_SECONDS;
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.floor(n)));
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

interface RawFile {
  /** 结构版本，缺失视为 0（升级默认配置时用于触发一次性迁移） */
  version?: unknown;
  env?: unknown;
  cookie?: unknown;
  refreshSeconds?: unknown;
  lastAccount?: unknown;
}

function defaultsFor(path: string): RawFile {
  return {
    version: CONFIG_VERSION,
    env: DEFAULT_ENV,
    cookie: "",
    refreshSeconds: DEFAULT_REFRESH_SECONDS,
  };
}

function writeRaw(path: string, raw: RawFile): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    // Windows 上无效，但 Linux / macOS 下确保只有属主可读（内含 ticket）
    chmodSync(target, 0o600);
  } catch {
    /* 忽略：权限收紧失败不应阻塞启动 */
  }
}

function readRaw(path: string): { raw: RawFile | null; reason?: string } {
  if (!existsSync(path)) return { raw: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { raw: null, reason: "文件内容不是 JSON 对象" };
    }
    return { raw: parsed as RawFile };
  } catch (err) {
    return { raw: null, reason: err instanceof Error ? err.message : "解析失败" };
  }
}

export interface LoadAccountConfigOptions {
  /** 配置文件路径（--account-config） */
  path?: string;
  /** 环境覆盖（--env） */
  env?: string;
  /** 凭证覆盖（--cookie） */
  cookie?: string;
  /** 刷新间隔覆盖（--account-refresh） */
  refreshSeconds?: number;
  notify?: (notice: ConfigNotice) => void;
}

/**
 * 读取账户配置。优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。
 *
 * - 文件不存在 → 写入一份默认配置（cookie 为空）并通知 `created`，
 *   这样用户按提示编辑即可，不必去猜文件路径与字段名；
 * - 文件损坏 → 用默认值继续（**不覆盖**损坏文件，避免丢凭证），通知 `fallback`；
 * - 文件里的非法字段 → 用默认值替换并通知 `patched`，同时就地写回修复后的内容。
 */
export function loadAccountConfig(opts: LoadAccountConfigOptions = {}): AccountConfig {
  const notify = opts.notify;
  const path = resolve(
    opts.path ?? process.env["TZZB_ACCOUNT_CONFIG"] ?? ACCOUNT_CONFIG_PATH,
  );

  let raw: RawFile;
  const { raw: parsed, reason } = readRaw(path);

  if (!existsSync(path)) {
    raw = defaultsFor(path);
    writeRaw(path, raw);
    notify?.({ kind: "created", path });
  } else if (!parsed) {
    raw = defaultsFor(path);
    notify?.({ kind: "fallback", path, reason: reason ?? "未知原因" });
  } else {
    // 逐字段校验，非法值就地修正并写回
    const patched: string[] = [];
    let env = parsed.env;
    if (env !== undefined && !isEnvKey(env)) {
      env = DEFAULT_ENV;
      patched.push("env");
    }
    // 一次性迁移：旧版本把默认刷新间隔写成了 30s，这里更新为当前默认值。
    // 只在「版本落后」且「值仍等于旧默认值」时触发，不会覆盖用户自己设过的值。
    const fileVersion = typeof parsed.version === "number" ? parsed.version : 0;
    let refresh = parsed.refreshSeconds;
    if (
      fileVersion < CONFIG_VERSION &&
      refresh === LEGACY_REFRESH_SECONDS &&
      opts.refreshSeconds === undefined
    ) {
      refresh = DEFAULT_REFRESH_SECONDS;
      patched.push("refreshSeconds");
    }
    if (refresh !== undefined && clampRefreshSeconds(refresh) !== refresh) {
      refresh = clampRefreshSeconds(refresh);
      patched.push("refreshSeconds");
    }
    if (typeof parsed.cookie !== "string") {
      if (parsed.cookie !== undefined) patched.push("cookie");
      parsed.cookie = "";
    }
    if (typeof parsed.lastAccount !== "string") {
      if (parsed.lastAccount !== undefined) patched.push("lastAccount");
      delete parsed.lastAccount;
    }
    raw = { ...parsed, env, refreshSeconds: refresh, version: CONFIG_VERSION };
    if (patched.length) {
      writeRaw(path, raw);
      notify?.({
        kind: fileVersion < CONFIG_VERSION ? "migrated" : "patched",
        path,
        fields: patched,
      });
    } else if (fileVersion < CONFIG_VERSION) {
      // 只是补齐版本号，不打扰用户
      writeRaw(path, raw);
    }
  }

  const envFlag = opts.env;
  const envVar = process.env["TZZB_ENV"];
  let env: EnvKey = DEFAULT_ENV;
  if (isEnvKey(envFlag)) env = envFlag;
  else if (isEnvKey(raw.env)) env = raw.env;
  else if (isEnvKey(envVar)) env = envVar;

  const flagCookie = typeof opts.cookie === "string" ? opts.cookie : undefined;
  const envCookie = process.env["TZZB_COOKIE"];
  const cookieRaw = flagCookie ?? envCookie ?? (typeof raw.cookie === "string" ? raw.cookie : "");

  const source: AccountConfig["source"] =
    flagCookie !== undefined ? "flag" : envCookie ? "env" : "file";

  return {
    env,
    cookie: normalizeCookie(cookieRaw),
    refreshSeconds: clampRefreshSeconds(
      opts.refreshSeconds ?? raw.refreshSeconds ?? DEFAULT_REFRESH_SECONDS,
    ),
    ...(typeof raw.lastAccount === "string" ? { lastAccount: raw.lastAccount } : {}),
    path,
    source,
  };
}

/** 保存凭证（stocking login 使用）。返回写入后的配置 */
export function saveAccountCookie(cookie: string, path: string): AccountConfig {
  const normalized = normalizeCookie(cookie);
  const target = resolve(path);
  const { raw } = readRaw(target);
  writeRaw(target, { ...(raw ?? defaultsFor(target)), cookie: normalized });
  return loadAccountConfig({ path: target });
}

/** 记住最后选中的账户（静默失败，不能因为写盘失败影响界面） */
export function saveLastAccount(accountId: string, path: string): void {
  try {
    const target = resolve(path);
    const { raw } = readRaw(target);
    writeRaw(target, { ...(raw ?? defaultsFor(target)), lastAccount: accountId });
  } catch {
    /* 忽略 */
  }
}


