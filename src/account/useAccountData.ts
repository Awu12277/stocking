// ---------------------------------------------------------------------------
// 账户视图 · 数据加载 hook
//
// 把「当前选中账户 + 当前页签 + 交易口径 + 流水页码」翻译成一次取数，
// 并统一处理：加载态、错误态、自动刷新倒计时、暂停、取消、结果缓存。
//
// 几个刻意的设计：
//   - **保留旧数据**：刷新失败时不清空上一次的结果，只在顶部挂错误条，
//     这样网络闪断不会把整屏变成空的（股票列表也是这个策略）；
//   - **结果缓存**：切页签回来时先渲染缓存再后台刷新，避免来回切时整屏闪；
//   - **取消优先**：切账户时 abort 在途请求，防止旧响应覆盖新账户的数据。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACCOUNT_TAB_KEYS, type AccountTabKey, type TradeScope } from "./constants.js";
import { hasCredentials, saveLastAccount } from "./config.js";
import { clockTime } from "./format.js";
import { loadOverview, loadPositions, loadStatus, loadTrades } from "./loaders.js";
import { isCancelledError, setRequestSignal, toUiError } from "./request.js";
import { clampIndex, wrapIndex } from "./scroll.js";
import { buildAggregateAccount, fetchAccountList } from "./services.js";
import type {
  Account,
  AccountConfig,
  OverviewData,
  PositionSummary,
  SelectableAccount,
  StatusData,
  TradeData,
  UiError,
} from "./types.js";

/** 当前页签对应的数据结构（判别联合，组件层按 kind 收窄） */
export type TabData =
  | { kind: "overview"; overview: OverviewData }
  | { kind: "positions"; positions: PositionSummary }
  | { kind: "trades"; trades: TradeData }
  | { kind: "status"; status: StatusData };

/** 一次取数的描述（含唯一 key，用于缓存命中判断） */
interface RequestDescriptor {
  key: string;
  selection: SelectableAccount;
  tab: AccountTabKey;
  scope: TradeScope;
  page: number;
}

async function fetchFor(descriptor: RequestDescriptor, accounts: Account[]): Promise<TabData> {
  const { selection, tab, scope, page } = descriptor;
  switch (tab) {
    case "overview":
      return { kind: "overview", overview: await loadOverview(selection, accounts) };
    case "positions":
      return { kind: "positions", positions: await loadPositions(selection, accounts) };
    case "trades":
      return { kind: "trades", trades: await loadTrades(selection, scope, page) };
    case "status":
      return { kind: "status", status: await loadStatus(selection, accounts) };
    default:
      return { kind: "overview", overview: await loadOverview(selection, accounts) };
  }
}

export interface UseAccountDataOptions {
  config: AccountConfig;
  /** 账户视图是否在前台；关闭时停止一切取数与计时 */
  active: boolean;
  initialAccountId?: string;
}

export interface UseAccountDataResult {
  /* 账户切换 */
  accounts: Account[];
  selectable: SelectableAccount[];
  selection: SelectableAccount | null;
  selectionIndex: number;
  moveSelection: (delta: number) => void;
  selectIndex: (index: number) => void;

  /* 页签 */
  tab: AccountTabKey;
  selectTab: (tab: AccountTabKey) => void;
  cycleTab: (delta: number) => void;

  /* 交易口径与分页 */
  tradeScope: TradeScope;
  changeScope: (scope: TradeScope) => void;
  historyPage: number;
  historyMaxPage: number;
  gotoHistoryPage: (page: number) => void;

  /* 数据 */
  tabData: TabData | null;
  bootLoading: boolean;
  loading: boolean;
  error: UiError | null;
  bootError: UiError | null;

  /* 刷新 */
  lastUpdate: string;
  countdown: number;
  /** 当前时间 HH:MM:SS（与倒计时同源，避免额外的每秒定时器） */
  now: string;
  paused: boolean;
  togglePaused: () => void;
  refresh: () => void;

  /* 凭证 */
  credentialIssue: string | null;
}

export function useAccountData({
  config,
  active,
  initialAccountId,
}: UseAccountDataOptions): UseAccountDataResult {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [bootLoading, setBootLoading] = useState(false);
  const [bootError, setBootError] = useState<UiError | null>(null);

  const [selectionIndex, setSelectionIndex] = useState(0);
  const [tab, setTab] = useState<AccountTabKey>("overview");
  const [tradeScope, setTradeScope] = useState<TradeScope>("today");
  const [historyPage, setHistoryPage] = useState(1);

  const [snapshot, setSnapshot] = useState<{ key: string; data: TabData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [lastUpdate, setLastUpdate] = useState("");

  const [countdown, setCountdown] = useState(config.refreshSeconds);
  const [paused, setPaused] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** 当前时间串（HH:MM:SS），与倒计时共用同一个心跳 */
  const [now, setNow] = useState(() => clockTime());

  /** 页签/账户切换时的结果缓存，避免来回切时整屏闪烁 */
  const cacheRef = useRef(new Map<string, TabData>());

  const credentialIssue = useMemo(
    () => (hasCredentials(config.cookie) ? null : "尚未配置账户凭证"),
    [config.cookie],
  );

  /* ---------------------------------------------------------------- *
   * 可选账户列表
   * ---------------------------------------------------------------- */

  const selectable = useMemo<SelectableAccount[]>(() => {
    if (!accounts.length) return [];
    // 只有账户数 > 1 时才插入虚拟汇总账户，单账户没必要多一层
    return accounts.length > 1 ? [buildAggregateAccount(accounts), ...accounts] : [...accounts];
  }, [accounts]);

  const selectionCount = selectable.length;
  const selection = selectable[clampIndex(selectionIndex, selectionCount)] ?? null;

  // 首次拿到账户列表时决定初始选中项：--account 参数 > 配置里的 lastAccount > 第一个
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || !selectable.length) return;
    initializedRef.current = true;
    const wanted = initialAccountId ?? config.lastAccount;
    if (!wanted) return;
    const idx = selectable.findIndex((item) => item.id === wanted || item.name === wanted);
    if (idx > 0) setSelectionIndex(idx);
  }, [selectable, initialAccountId, config.lastAccount]);

  /* ---------------------------------------------------------------- *
   * 账户列表加载
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active || credentialIssue || accountsLoaded) return undefined;

    const controller = new AbortController();
    setRequestSignal(controller.signal);
    setBootLoading(true);

    fetchAccountList()
      .then((list) => {
        if (controller.signal.aborted) return;
        setAccounts(list);
        setAccountsLoaded(true);
        setBootError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isCancelledError(err)) return;
        setBootError(toUiError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBootLoading(false);
      });

    return () => {
      controller.abort();
    };
    // nonce 用于「按 r 重试」：失败后 accountsLoaded 仍为 false，
    // 依赖变化才会重新发起请求（不会因 setState 造成自触发循环）
  }, [active, credentialIssue, accountsLoaded, nonce]);

  /* ---------------------------------------------------------------- *
   * 当前页签取数
   * ---------------------------------------------------------------- */

  const descriptor = useMemo<RequestDescriptor | null>(() => {
    if (!selection) return null;
    const page = tab === "trades" && tradeScope === "history" ? historyPage : 1;
    const key = [selection.id, tab, tab === "trades" ? tradeScope : "", page].join("|");
    return { key, selection, tab, scope: tradeScope, page };
  }, [selection, tab, tradeScope, historyPage]);

  useEffect(() => {
    if (!active || credentialIssue || !descriptor) return undefined;

    const controller = new AbortController();
    setRequestSignal(controller.signal);
    let alive = true;

    // 命中缓存先渲染，再后台刷新
    const cached = cacheRef.current.get(descriptor.key);
    if (cached) setSnapshot({ key: descriptor.key, data: cached });
    setLoading(true);
    setCountdown(config.refreshSeconds);

    const { key } = descriptor;
    fetchFor(descriptor, accounts)
      .then((data) => {
        if (!alive) return;
        cacheRef.current.set(key, data);
        setSnapshot({ key, data });
        setError(null);
        setLastUpdate(clockTime());
      })
      .catch((err: unknown) => {
        if (!alive || isCancelledError(err)) return;
        // 保留旧数据，只挂错误条
        setError(toUiError(err));
        setLastUpdate(clockTime());
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [active, credentialIssue, descriptor, accounts, nonce, config.refreshSeconds]);

  /* ---------------------------------------------------------------- *
   * 自动刷新倒计时
   * ---------------------------------------------------------------- */

  // 单个 1s 心跳同时驱动时钟与倒计时。
  // 拆成两个 setInterval 会让界面每秒渲染两次；同一次回调里的多次 setState
  // 会被 React 合并成一次渲染，因此这里必须合并成一个定时器。
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setNow(clockTime());
      // 暂停时不递减倒计时，但时钟继续走
      if (!paused && !credentialIssue) {
        setCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [active, paused, credentialIssue]);

  useEffect(() => {
    if (countdown !== 0) return;
    setNonce((n) => n + 1);
    setCountdown(config.refreshSeconds);
  }, [countdown, config.refreshSeconds]);

  /* ---------------------------------------------------------------- *
   * 记住最后选中的账户（防抖，失败静默）
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!active || !selection) return undefined;
    const timer = setTimeout(() => {
      saveLastAccount(selection.id, config.path);
    }, 600);
    return () => clearTimeout(timer);
  }, [active, selection, config.path]);

  /* ---------------------------------------------------------------- *
   * 对外动作
   * ---------------------------------------------------------------- */

  const moveSelection = useCallback(
    (delta: number) => {
      setSelectionIndex((prev) => clampIndex(prev + delta, selectionCount));
      setHistoryPage(1);
    },
    [selectionCount],
  );

  const selectIndex = useCallback((index: number) => {
    setSelectionIndex((prev) => (prev === index ? prev : index));
    setHistoryPage(1);
  }, []);

  const selectTab = useCallback((next: AccountTabKey) => {
    setTab((prev) => (prev === next ? prev : next));
  }, []);

  const cycleTab = useCallback((delta: number) => {
    setTab((prev) => {
      const idx = ACCOUNT_TAB_KEYS.indexOf(prev);
      return ACCOUNT_TAB_KEYS[wrapIndex(idx + delta, ACCOUNT_TAB_KEYS.length)] ?? prev;
    });
  }, []);

  const changeScope = useCallback((scope: TradeScope) => {
    setTradeScope(scope);
    setHistoryPage(1);
  }, []);

  const tabData = descriptor && snapshot?.key === descriptor.key ? snapshot.data : null;

  const historyMaxPage =
    tabData?.kind === "trades" ? (tabData.trades.meta?.maxPage ?? 0) : 0;

  const gotoHistoryPage = useCallback(
    (page: number) => {
      const max = historyMaxPage || 1;
      setHistoryPage(Math.min(max, Math.max(1, page)));
    },
    [historyMaxPage],
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const togglePaused = useCallback(() => setPaused((p) => !p), []);

  return {
    accounts,
    selectable,
    selection,
    selectionIndex,
    moveSelection,
    selectIndex,
    tab,
    selectTab,
    cycleTab,
    tradeScope,
    changeScope,
    historyPage,
    historyMaxPage,
    gotoHistoryPage,
    tabData,
    bootLoading,
    loading,
    error,
    bootError,
    lastUpdate,
    countdown,
    now,
    paused,
    togglePaused,
    refresh,
    credentialIssue,
  };
}
