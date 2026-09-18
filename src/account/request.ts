// ---------------------------------------------------------------------------
// 账户视图 · 统一请求层
//
// 移植自 tzzb-ext/src/request.js，按 CLI 场景做了三处适配：
//
//   1. 【鉴权】扩展用 chrome.cookies 读 Cookie；CLI 直传 `Cookie` 请求头
//      （Node 的 fetch 不做 Cookie 管理，必须自己带上）。
//   2. 【传输】扩展有「扩展直连 / 站点标签页注入」双通道降级；CLI 里站点注入
//      不可用，改为「显式 Cookie + Referer/Origin + 网络层指数退避重试」。
//   3. 【取消】CLI 界面会频繁切账户/切页签，在途请求必须可中断，
//      因此全程支持 AbortSignal，并把「主动取消」与「真失败」区分开。
//
// 其余（URL 组装、公共参数注入、响应信封解析、错误分层）与扩展逐行一致。
// ---------------------------------------------------------------------------

import {
  AUTH_COOKIES,
  CODE,
  COMMON_PARAMS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT,
  ENVELOPE,
  ENVS,
  FORWARD_PREFIX,
  LAYER,
  type Layer,
} from "./constants.js";
import { cookieUid, parseCookie } from "./config.js";
import type { RequestContext, RequestOptions, UiError } from "./types.js";

/* ------------------------------------------------------------------ *
 * 异常
 * ------------------------------------------------------------------ */

export interface ApiErrorInit {
  code?: string;
  layer?: Layer;
  status?: number;
  cancelled?: boolean;
}

/** 业务异常：携带 error_code 与分层信息，便于界面差异化提示 */
export class ApiError extends Error {
  readonly code: string;
  readonly layer: Layer;
  readonly status: number;
  readonly cancelled: boolean;

  constructor(message: string, init: ApiErrorInit = {}) {
    super(message || "请求异常");
    this.name = "ApiError";
    this.code = String(init.code ?? "");
    this.layer = init.layer ?? LAYER.BUSINESS;
    this.status = init.status ?? 0;
    this.cancelled = init.cancelled ?? false;
  }

  /** HTTP 401：未登录 / 登录态过期 */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === "401";
  }

  /** 账户已被删除 */
  get isAccountDeleted(): boolean {
    return this.code === CODE.ACCOUNT_DELETED;
  }

  /** 网络层异常（可重试 / 可降级） */
  get isNetwork(): boolean {
    return this.layer === LAYER.NETWORK;
  }

  /** 主动取消（组件卸载 / 切换账户），界面不应提示为错误 */
  get isCancelled(): boolean {
    return this.cancelled;
  }
}

/** 是否为取消异常（供界面直接判断，无需 instanceof） */
export function isCancelledError(err: unknown): boolean {
  return err instanceof ApiError && err.isCancelled;
}

function cancelledError(): ApiError {
  return new ApiError("已取消", { code: "aborted", layer: LAYER.NETWORK, cancelled: true });
}

/** 把任意异常归一化成界面可展示的错误（含一行排查建议） */
export function toUiError(err: unknown): UiError {
  if (err instanceof ApiError) {
    return { message: err.message, code: err.code, layer: err.layer, hint: hintOf(err) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    message,
    code: "",
    layer: LAYER.UNKNOWN,
    hint: "非预期异常：按 r 重试；若持续出现请附上复现步骤反馈。",
  };
}

function hintOf(err: ApiError): string {
  if (err.isUnauthorized) {
    return '凭证缺失或已过期：运行 stocking login --cookie "<cookie>" 重新保存。';
  }
  if (err.code === "timeout") {
    return "请求超时：稍后按 r 重试，或加大 --account-refresh 间隔。";
  }
  if (err.isAccountDeleted) {
    return "该账户已在服务端删除：按 ← / → 切换到其它账户。";
  }
  if (err.layer === LAYER.NETWORK) {
    // 不要在这里提内部环境参数：该提示会直接显示在界面上，属于面向客户的文案
    return "网络层失败：请检查网络连接或代理设置，稍后按 r 重试。";
  }
  if (err.layer === LAYER.FORMAT) {
    return "参数或配置不合法：检查 ~/.stocking/account.json。";
  }
  return "业务接口返回失败：按 r 重试，或切换到其它账户查看。";
}

/* ------------------------------------------------------------------ *
 * 请求上下文
 * ------------------------------------------------------------------ */

let context: RequestContext | null = null;

/** 启动时注入一次，之后所有服务调用共享（避免把 config 层层透传） */
export function setRequestContext(ctx: RequestContext): void {
  context = ctx;
}

/**
 * 统一取消信号。
 *
 * CLI 界面会频繁切账户 / 切页签，在途请求必须能中断，否则旧账户的响应
 * 会覆盖新账户的数据。逐层透传 signal 到每个服务函数代价太大，而 Ink 界面
 * 同一时刻只存在一批在途请求，因此这里用一个「当前信号」即可。
 */
let contextSignal: AbortSignal | null = null;

export function setRequestSignal(signal: AbortSignal | null): void {
  contextSignal = signal;
}

export function getRequestContext(): RequestContext {
  if (!context) {
    throw new ApiError("请求上下文未初始化", { layer: LAYER.FORMAT });
  }
  return context;
}

export function getContextEnv(): RequestContext["env"] {
  return getRequestContext().env;
}

/* ------------------------------------------------------------------ *
 * URL 与参数序列化
 * ------------------------------------------------------------------ */

/** POST：application/x-www-form-urlencoded */
function encodeBody(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    usp.append(k, v === null || v === undefined ? "" : String(v));
  }
  return usp.toString();
}

/** GET：忠实复刻源码实现 —— 值中的 `=` 会被移除 */
function encodeQuery(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${String(v ?? "").replace(/=/g, "")}`)
    .join("&");
}

/* ------------------------------------------------------------------ *
 * 单次发送
 * ------------------------------------------------------------------ */

interface SendResult {
  status: number;
  data: Record<string, unknown> | null;
}

async function sendOnce(
  url: string,
  method: "POST" | "GET",
  body: string,
  cookie: string,
  referer: string,
  timeout: number,
  externalSignal: AbortSignal | undefined,
  tag: string,
): Promise<SendResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw cancelledError();
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = {
    // Node 的 fetch 不会自动带 Cookie，鉴权全靠这一行
    Cookie: cookie,
    Accept: "application/json, text/plain, */*",
    Referer: referer,
    Origin: new URL(referer).origin,
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { [ENVELOPE.CODE]: String(res.status), [ENVELOPE.MSG]: "响应解析失败（非 JSON）" };
    }
    return { status: res.status, data };
  } catch (err) {
    if (externalSignal?.aborted) throw cancelledError();
    if (timedOut) {
      throw new ApiError(`请求超时：${tag}`, { code: "timeout", layer: LAYER.NETWORK });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(`网络异常：${message}`, { code: "", layer: LAYER.NETWORK });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** HTTP 状态码 -> 业务异常（见 API.md 1.7） */
function toHttpError(status: number, payload: Record<string, unknown> | null): ApiError {
  const msg = String(payload?.[ENVELOPE.MSG] ?? "");
  if (status === 401) {
    return new ApiError("登录信息过期，请重新登录", {
      code: "401",
      layer: LAYER.NETWORK,
      status: 401,
    });
  }
  if (status === 403) {
    return new ApiError(msg || "无访问权限，请稍后重试", {
      code: "403",
      layer: LAYER.NETWORK,
      status: 403,
    });
  }
  if (status === 502) {
    return new ApiError(msg || "服务暂时不可用（502）", {
      code: "502",
      layer: LAYER.NETWORK,
      status: 502,
    });
  }
  return new ApiError(msg || `请求失败（HTTP ${status}）`, {
    code: String(status),
    layer: LAYER.NETWORK,
    status,
  });
}

/* ------------------------------------------------------------------ *
 * 核心请求入口
 * ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发起一次业务请求。
 *
 * @param path    业务路径，如 /caishen_fund/pc/account/v1/account_list
 * @param params  业务参数（公共参数与鉴权参数自动注入）
 */
export async function request<T = Record<string, unknown>>(
  path: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<T> {
  const {
    usePost = true,
    ignoreEnvelope = false,
    needUid = true,
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    signal: explicitSignal,
  } = options;
  const signal = explicitSignal ?? contextSignal ?? undefined;

  const ctx = getRequestContext();
  const env = ENVS[ctx.env];

  // 1) 前置鉴权校验：未登录不发请求，直接抛 401（与源码一致）
  if (!parseCookie(ctx.cookie)[AUTH_COOKIES[0]]) {
    throw new ApiError("登录信息缺失", { code: "401", layer: LAYER.NETWORK, status: 401 });
  }

  // 2) 组装参数
  const finalParams: Record<string, unknown> = { ...COMMON_PARAMS, ...params };
  if (needUid) {
    const uid = cookieUid(ctx.cookie);
    finalParams["userid"] = uid;
    finalParams["user_id"] = uid;
  }

  // 3) 组装 URL
  const businessPath = path.startsWith("/") ? path : `/${path}`;
  const base = env.server + FORWARD_PREFIX + businessPath;
  const url = usePost ? base : `${base}?${encodeQuery(finalParams)}`;
  const body = usePost ? encodeBody(finalParams) : "";

  // 4) 发送（网络层失败按指数退避重试；业务错误立即抛出，不重试）
  let payload: Record<string, unknown> | null = null;
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= Math.max(0, retries); attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const res = await sendOnce(
        url,
        usePost ? "POST" : "GET",
        body,
        ctx.cookie,
        env.pageUrl,
        timeout,
        signal,
        businessPath,
      );
      if (res.status >= 400) throw toHttpError(res.status, res.data);
      payload = res.data;
      lastError = null;
      break;
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError(err instanceof Error ? err.message : "网络异常", {
              layer: LAYER.NETWORK,
            });
      if (apiErr.isCancelled) throw apiErr;
      lastError = apiErr;
      if (!apiErr.isNetwork || apiErr.status === 401 || apiErr.status === 403) break;
    }
  }

  if (lastError) throw lastError;
  if (!payload) throw new ApiError("请求异常", { layer: LAYER.UNKNOWN });

  // 5) 解析信封
  if (ignoreEnvelope) return payload as T;

  const code = payload[ENVELOPE.CODE];
  const data = payload[ENVELOPE.DATA];
  const isEmptyObject =
    typeof data === "object" && data !== null && !Array.isArray(data) && Object.keys(data).length === 0;
  const hasData = data !== undefined && data !== null && !isEmptyObject;

  if (String(code) !== CODE.SUCCESS || !hasData) {
    throw new ApiError(String(payload[ENVELOPE.MSG] ?? "") || "请求异常", {
      code: String(code),
      layer: LAYER.BUSINESS,
    });
  }

  return data as T;
}
