// ---------------------------------------------------------------------------
// StockList — 多分组自选股监控 + 详情视图 + 账户视图入口
//
// 键盘：
//   列表：↑/↓ 选股  ←/→ 切换分组  Enter 详情  r 刷新  o 排序  h 置灰  a 账户  q 退出
//   详情：Esc/q/Space 返回  b 买入价  s 卖出价  a 账户
//   编辑：数字/. 输入  Backspace 删除  Enter 确认  Esc 取消
//
// 账户视图（AccountView）由 `a` 键进入 / 返回，其内部键盘与取数全部自管；
// 进入后本组件的 useInput 会被禁用，避免两套按键同时响应。
// ---------------------------------------------------------------------------

import { Box, Text, useInput } from "ink";
import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import asciichart from "asciichart";
import type { Group, StockRow } from "./types.js";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import {
  fetchStocks,
  fetchStockMinute,
  getCachedMinute,
  setCachedMinute,
} from "./market.js";
import { SETTINGS_PATH, saveStockConfig } from "./settings.js";
import {
  applyTargetToGroup,
  clampGroupIndex,
  currentGroup,
  currentSymbols,
} from "./groups.js";
import { AccountView } from "./AccountView.js";
import type { AccountConfig } from "./account/types.js";
// 终端尺寸 / 窗口化 / 显示宽度这三样是布局类通用工具，与账户视图共用
import { displayWidth, truncateDisplay } from "./account/format.js";
import { computeWindow, sliceWindow } from "./account/scroll.js";
import { useTerminalSize } from "./account/useTerminalSize.js";

// ---------------------------------------------------------------------------
// OSC 8 终端超链接（点击打开 settings.json）
// ---------------------------------------------------------------------------

function toFileUrl(p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (process.platform === "win32") {
    return "file://" + norm.replace(/^([a-zA-Z]:)/, "/$1");
  }
  return "file://" + norm;
}

function osc8Link(uri: string, text: string): string {
  return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function formatPrice(p: number): string {
  return p >= 100 ? p.toFixed(2) : p.toFixed(3);
}

/** 取最新 maxPoints 个点（用于折线图） */
function latestPoints(data: number[], maxPoints = 60): number[] {
  if (data.length <= maxPoints) return data;
  return data.slice(data.length - maxPoints);
}

/**
 * 列表页固定占用的实际行数（不含股票数据行）：
 *   标题 1 + 标题下留白 1 + 表头 1 + 分割线 1 + 页脚（留白 1 + 提示 1 + 更新行 1）3 = 7
 */
export const LIST_FIXED_ROWS = 7;

/**
 * 安全余量。这不是排版偏好，而是**硬性要求**：
 *
 * ink.js 的 shouldClearTerminalForFrame 在 Windows（process.platform === 'win32'）下，
 * 只要「帧高 ≥ 终端行数」就返回 true，于是每一帧都执行
 * `clearTerminal + 整屏重绘`，**并且直接绕过 incrementalRendering**
 * （源码注释说明这是为规避 #969 而保留的 pre-7.0 行为）。
 *
 * 结论：帧高必须严格小于终端行数，否则无论怎么优化都必然闪烁。
 * 留 2 行余量还能顺带吸收极端宽度下可能出现的意外折行。
 */
export const LIST_SAFETY_ROWS = 2;

/** 列表页固定开销（实际占用 + 安全余量） */
export const LIST_CHROME_ROWS = LIST_FIXED_ROWS + LIST_SAFETY_ROWS;

/**
 * 给定终端行数时列表能渲染多少只股票。
 * 不变式：LIST_FIXED_ROWS + 返回值 ≤ rows - LIST_SAFETY_ROWS < rows
 */
export function computeListCapacity(rows: number): number {
  const total = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
  return Math.max(1, total - LIST_CHROME_ROWS);
}

/** 操作列的三种状态。颜色写死，不走 cp()，不受 h 置灰影响。 */
const ACTION_STYLE = {
  sell: { label: "卖出", color: "#ff1493" },
  buy: { label: "买入", color: "#00ff41" },
  wait: { label: "等待", color: "#ffcc00" },
} as const;

/** 根据最新价与目标价判定操作。两侧目标价均未配置时返回 null（无可等待）。 */
function getAction(stock: StockRow): (typeof ACTION_STYLE)[keyof typeof ACTION_STYLE] | null {
  const { price, buyPrice, sellPrice } = stock;
  if (buyPrice === undefined && sellPrice === undefined) return null;
  if (sellPrice !== undefined && price >= sellPrice) return ACTION_STYLE.sell;
  if (buyPrice !== undefined && price <= buyPrice) return ACTION_STYLE.buy;
  return ACTION_STYLE.wait;
}

// ---------------------------------------------------------------------------
// StockList
// ---------------------------------------------------------------------------

export interface StockListProps {
  groups: Group[];
  /** 账户视图所需的配置（凭证 / 环境 / 刷新间隔） */
  accountConfig: AccountConfig;
  /** --account 指定的启动账户（id 或名称），透传给账户视图 */
  initialAccountId?: string;
  onExit: () => void;
}

export function StockList({
  groups: initialGroups,
  accountConfig,
  initialAccountId,
  onExit,
}: StockListProps) {
  // 当前激活的分组下标
  const [groupIndex, setGroupIndex] = useState(0);
  // 内存里的全部分组（每次改目标价时整个替换并写回 settings.json）
  const [groups, setGroups] = useState<Group[]>(initialGroups);

  /** 是否处于账户视图（按 a 进入，再按 a 返回） */
  const [accountView, setAccountView] = useState(false);

  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [detailView, setDetailView] = useState<StockRow | null>(null);
  const [detailPrices, setDetailPrices] = useState<number[] | null>(null);
  const [detailCountdown, setDetailCountdown] = useState(10);
  const [countdown, setCountdown] = useState(5);
  const [currentTime, setCurrentTime] = useState<string>(() =>
    new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  );
  const [dimMode, setDimMode] = useState(false);

  /** 目标价编辑态：null 未编辑；否则记录正在编辑的方向与已输入字符串 */
  const [targetEdit, setTargetEdit] = useState<{ type: "buy" | "sell"; value: string } | null>(null);
  /** 操作反馈（如 "✔ 已设置买入目标价 32.500"），3 秒后自动消失 */
  const [flashMsg, setFlashMsg] = useState<{ text: string; color: string } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  type SortOrder = "default" | "asc" | "desc";
  const [sortOrder, setSortOrder] = useState<SortOrder>("default");

  const group = useMemo(() => currentGroup(groups, groupIndex), [groups, groupIndex]);
  const activeSymbols = useMemo(() => currentSymbols(groups, groupIndex), [groups, groupIndex]);

  // 目标价查找表（code -> 配置），行情返回后按 code 合并
  const symbolMap = useMemo(
    () => new Map(activeSymbols.map((s) => [s.code, s])),
    [activeSymbols],
  );

  const sortedStocks = useMemo(() => {
    if (sortOrder === "default") return stocks;
    return [...stocks].sort((a, b) =>
      sortOrder === "desc"
        ? b.changePercent - a.changePercent
        : a.changePercent - b.changePercent,
    );
  }, [stocks, sortOrder]);

  const { handleCtrlC } = useDoubleCtrlC(onExit);

  /* ------------------------- 终端尺寸与高度预算 ------------------------- */

  const { columns, rows } = useTerminalSize();

  // 列表可见行数：窗口化后帧高恒为 LIST_CHROME_ROWS + cap，严格小于终端行数，
  // 从而避开 Ink 在 Windows 上的整屏清屏分支（详见 LIST_CHROME_ROWS 注释）。
  const listCapacity = computeListCapacity(rows);
  const listSlice = computeWindow(sortedStocks.length, selectedIndex, listCapacity);
  const visibleStocks = sliceWindow(sortedStocks, listSlice);
  const listTrimmed = listSlice.size < sortedStocks.length;

  // 详情页也要按高度收缩分时图：固定占用约 14 行
  // （标题 2 + 行情 2 + 目标价 2 + 输入/反馈 0~4 + 图标题 1 + 提示 2），故图高上限取 rows - 17。
  const detailChartHeight = Math.max(0, Math.min(10, rows - 17));

  // 切组时把选中行重置、退出详情、清空行情缓冲
  useEffect(() => {
    setSelectedIndex(0);
    setDetailView(null);
    setStocks([]);
    setLoading(true);
  }, [groupIndex]);

  // 数据加载
  const loadData = useCallback(async () => {
    const codes = [...symbolMap.keys()];
    if (codes.length === 0) {
      setStocks([]);
      setLastUpdate(new Date().toLocaleTimeString());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchStocks(codes);
      setStocks(
        data.map((row) => {
          const cfg = symbolMap.get(row.code);
          return {
            ...row,
            ...(cfg?.buyPrice !== undefined ? { buyPrice: cfg.buyPrice } : {}),
            ...(cfg?.sellPrice !== undefined ? { sellPrice: cfg.sellPrice } : {}),
          };
        }),
      );
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      /* 保留旧数据 */
    }
    setLoading(false);
  }, [symbolMap]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 操作反馈：3 秒后自动消失
  const showFlash = useCallback((text: string, color = "#ffcc00") => {
    setFlashMsg({ text, color });
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashMsg(null), 3000);
  }, []);

  /** 把目标价写入配置 + 内存行 + 详情视图；price 传 undefined 表示清除该方向 */
  const applyTarget = useCallback(
    (code: string, type: "buy" | "sell", price: number | undefined) => {
      const nextGroups = applyTargetToGroup(groups, groupIndex, code, type, price);
      // applyTargetToGroup 在「该股从未配置且清除」时返回同一引用 → 无变化
      if (nextGroups === groups) return;
      setGroups(nextGroups);
      saveStockConfig(nextGroups);

      // 同步列表行
      const key: "buyPrice" | "sellPrice" = type === "buy" ? "buyPrice" : "sellPrice";
      setStocks((rows) =>
        rows.map((r) => {
          if (r.code !== code) return r;
          const copy = { ...r };
          if (price === undefined) delete copy[key];
          else copy[key] = price;
          return copy;
        }),
      );
      // 同步详情视图（目标价区展示）
      setDetailView((dv) => {
        if (!dv || dv.code !== code) return dv;
        const copy = { ...dv };
        if (price === undefined) delete copy[key];
        else copy[key] = price;
        return copy;
      });
    },
    [groups, groupIndex],
  );

  /** 编辑模式下回车：空输入=清除；非法值=提示；合法正数=保存 */
  const confirmTargetEdit = useCallback(() => {
    if (!targetEdit || !detailView) return;
    const { type, value } = targetEdit;
    const code = detailView.code;
    const label = type === "buy" ? "买入" : "卖出";
    setTargetEdit(null);

    if (value.trim() === "") {
      applyTarget(code, type, undefined);
      showFlash(`已清除${label}目标价`, "#888888");
      return;
    }
    const price = parseFloat(value);
    if (!isFinite(price) || price <= 0) {
      showFlash("✘ 价格无效，未保存", "#ff5555");
      return;
    }
    applyTarget(code, type, price);
    showFlash(`✔ 已设置${label}目标价 ${formatPrice(price)}`, "#00ff41");
  }, [targetEdit, detailView, applyTarget, showFlash]);

  // 单一 1s 心跳，同时驱动时钟与列表刷新倒计时。
  //
  // 原先时钟和倒计时是两个独立的 setInterval，界面每秒因此要渲染两次。
  // 合并到同一个回调里，React 会把两次 setState 合并成一次渲染。
  //
  // 账户视图在前台时整块停掉：本组件重渲染会连带 AccountView 一起重渲染
  // （onBack 每次都是新函数，无法 bail out），而账户视图有自己的同频心跳。
  useEffect(() => {
    if (accountView) return;
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      setCountdown((prev) => {
        if (prev <= 1) {
          void loadData();
          return 5;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [accountView, loadData]);

  // 详情刷新
  useEffect(() => {
    if (!detailView) {
      setDetailPrices(null);
      return;
    }
    const code = detailView.code;
    const cached = getCachedMinute(code);
    if (cached) setDetailPrices(cached);

    const loadDetail = async () => {
      const data = await fetchStockMinute(code);
      if (data && data.prices.length > 0) {
        setCachedMinute(code, data.prices);
        setDetailPrices(data.prices);
      }
    };
    void loadDetail();
    setDetailCountdown(10);
    const timer = setInterval(loadDetail, 10_000);
    return () => clearInterval(timer);
  }, [detailView]);

  // 详情倒计时
  useEffect(() => {
    if (!detailView) return;
    const timer = setInterval(() => {
      setDetailCountdown((prev) => (prev > 0 ? prev - 1 : 10));
    }, 1000);
    return () => clearInterval(timer);
  }, [detailView]);

  // 键盘（账户视图前台时禁用本组件监听，交给 AccountView 自己处理）
  useInput(
    useCallback(
      (input, key) => {
        if (input === "c" && key.ctrl) {
          handleCtrlC();
          return;
        }

        // —— 目标价编辑模式（拦截所有按键）——
        if (targetEdit) {
          if (key.escape) {
            setTargetEdit(null);
          } else if (key.return) {
            confirmTargetEdit();
          } else if (key.backspace || key.delete) {
            setTargetEdit((prev) =>
              prev ? { ...prev, value: prev.value.slice(0, -1) } : prev,
            );
          } else if (/^[0-9.]$/.test(input)) {
            setTargetEdit((prev) => {
              if (!prev || prev.value.length >= 10) return prev;
              if (input === "." && prev.value.includes(".")) return prev; // 防重复小数点
              const next = prev.value + input;
              if (!/^\d*\.?\d{0,2}$/.test(next)) return prev; // 最多两位小数
              return { ...prev, value: next };
            });
          }
          return;
        }

        // —— 详情视图 ——
        if (detailView) {
          if (key.escape || input === "q" || input === " ") {
            setDetailView(null);
          } else if (input === "b") {
            setTargetEdit({ type: "buy", value: "" });
          } else if (input === "s") {
            setTargetEdit({ type: "sell", value: "" });
          } else if (input === "a") {
            // 从详情直接进账户视图，返回时不会再落在详情上
            setDetailView(null);
            setAccountView(true);
          }
          return;
        }

        // —— 列表视图 ——
        // 分组切换：←/→ 永远可用（即使当前组为空）
        // 同时兼容 ESC 序列 \x1b[D / \x1b[C（部分 Windows 终端或 kitty 协议下 key.leftArrow=false）
        if (key.leftArrow || input === "\x1b[D" || input === "\x1bOD") {
          setGroupIndex((prev) => clampGroupIndex(prev - 1, groups.length));
          showFlash(`← 分组 ${clampGroupIndex(groupIndex - 1, groups.length) + 1}/${groups.length}`);
          return;
        }
        if (key.rightArrow || input === "\x1b[C" || input === "\x1bOC") {
          setGroupIndex((prev) => clampGroupIndex(prev + 1, groups.length));
          showFlash(`→ 分组 ${clampGroupIndex(groupIndex + 1, groups.length) + 1}/${groups.length}`);
          return;
        }
        if (input === "[") {
          setGroupIndex((prev) => clampGroupIndex(prev - 1, groups.length));
          showFlash(`← 分组 ${clampGroupIndex(groupIndex - 1, groups.length) + 1}/${groups.length}`);
          return;
        }
        if (input === "]") {
          setGroupIndex((prev) => clampGroupIndex(prev + 1, groups.length));
          showFlash(`→ 分组 ${clampGroupIndex(groupIndex + 1, groups.length) + 1}/${groups.length}`);
          return;
        }

        if (stocks.length === 0) {
          // 空组时只允许刷新、进账户和退出
          if (key.escape || input === "q") {
            onExit();
          } else if (input === "r") {
            setCountdown(5);
            void loadData();
          } else if (input === "a") {
            setAccountView(true);
          }
          return;
        }

        if (key.upArrow || input === "k") {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : sortedStocks.length - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((prev) => (prev < sortedStocks.length - 1 ? prev + 1 : 0));
        } else if (key.return) {
          // 必须按排序后的列表取行：列表渲染的是 sortedStocks，
          // 用 stocks[selectedIndex] 在开启排序（o）后会打开错误的股票
          const stock = sortedStocks[selectedIndex];
          if (stock) setDetailView(stock);
        } else if (key.escape || input === "q") {
          onExit();
        } else if (input === "r") {
          setCountdown(5);
          void loadData();
        } else if (input === "a") {
          // 切换到账户视图（账户视图内再按 a 返回）
          setAccountView(true);
        } else if (input === "o") {
          setSortOrder((prev) =>
            prev === "default" ? "desc" : prev === "desc" ? "asc" : "default",
          );
        } else if (input === "h") {
          setDimMode((v) => !v);
        }
      },
      [
        stocks,
        sortedStocks,
        selectedIndex,
        detailView,
        targetEdit,
        groups,
        onExit,
        loadData,
        handleCtrlC,
        confirmTargetEdit,
      ],
    ),
    { isActive: !accountView },
  );

  // 账户视图：整体接管界面（按 a 进入 / 返回）
  if (accountView) {
    return (
      <AccountView
        config={accountConfig}
        initialAccountId={initialAccountId}
        onBack={() => setAccountView(false)}
        onExit={onExit}
      />
    );
  }

  // 详情
  if (detailView) {
    return renderDetail(
      detailView,
      targetEdit,
      flashMsg,
      detailPrices ?? undefined,
      detailCountdown,
      currentTime,
      detailChartHeight,
    );
  }

  // 列表
  const cp = (c: string) => (dimMode ? { dimColor: true } : { color: c });
  const groupEmpty = stocks.length === 0 && !loading;

  /*
   * 宽度预算（与账户视图同一套做法）。
   * 行内容超过终端宽度就会折行、多占 1 行 —— 帧高每多 1 行都可能顶到终端高度，
   * 从而触发 Ink 在 Windows 上的整屏清屏重绘分支（见 LIST_CHROME_ROWS 注释）。
   * 所以顶部行与页脚都按「显式预算 + 截断」排布。
   */
  const listTitleWidth = displayWidth("  📈 自选股监控  · ");
  const headerRight = truncateDisplay(
    `🕐 ${currentTime}   ${loading ? "⟳ 刷新中…" : `${countdown}s 后自动刷新`}`,
    Math.max(12, Math.floor(columns * 0.4)),
  );
  const tabNameWidth = columns < 104 ? 8 : 14;
  const tabSlotWidth = tabNameWidth + 4; // " name " + 两个空格
  const tabBudget = Math.max(10, columns - listTitleWidth - displayWidth(headerRight) - 8);
  const headerTabs = computeWindow(
    groups.length,
    groupIndex,
    Math.max(1, Math.floor(tabBudget / tabSlotWidth)),
  );

  // 页脚：给 settings.json 路径留出剩余宽度，保证整行不折行
  const footerFixed = displayWidth(`  最后更新: ${lastUpdate}  编辑自选股分组: `);
  const pathBudget = Math.max(12, columns - footerFixed - (listTrimmed ? 24 : 2));

  return (
    <Box flexDirection="column">
      {/* 顶部标题 + 分组 tab */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box flexShrink={0}>
          <Text bold {...cp("#00ffff")}>
            {"  📈 自选股监控"}
          </Text>
          <Text dimColor>{"  · "}</Text>
          {headerTabs.above > 0 ? <Text dimColor>{"‹ "}</Text> : null}
          {groups.slice(headerTabs.start, headerTabs.end).map((g, i) => {
            const index = headerTabs.start + i;
            const active = index === groupIndex;
            return (
              <Text key={index}>
                <Text bold={active} inverse={active} {...cp(active ? "#00ffff" : "#888888")}>
                  {` ${truncateDisplay(g.name, tabNameWidth)} `}
                </Text>
                <Text>{"  "}</Text>
              </Text>
            );
          })}
          {headerTabs.below > 0 ? <Text dimColor>{`› +${headerTabs.below}`}</Text> : null}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{headerRight}</Text>
        </Box>
      </Box>

      {/* 表头 */}
      <Box>
        <Box width={3} />
        <Box width={9}>
          <Text dimColor>代码</Text>
        </Box>
        <Box width={15}>
          <Text dimColor>名称</Text>
        </Box>
        <Box width={11}>
          <Text dimColor>最新价</Text>
        </Box>
        <Box width={10}>
          <Text dimColor>
            涨跌幅{sortOrder === "desc" ? " ▼" : sortOrder === "asc" ? " ▲" : ""}
          </Text>
        </Box>
        <Box width={9}>
          <Text dimColor>最高</Text>
        </Box>
        <Box width={9}>
          <Text dimColor>最低</Text>
        </Box>
        <Box width={11}>
          <Text dimColor>买入目标价</Text>
        </Box>
        <Box width={11}>
          <Text dimColor>卖出目标价</Text>
        </Box>
        <Box>
          <Text dimColor>操作</Text>
        </Box>
      </Box>

      <Box>
        <Text dimColor>{"  " + "─".repeat(Math.max(20, columns - 2))}</Text>
      </Box>

      <Box flexDirection="column">
        {groupEmpty && (
          <Box>
            <Text {...cp("#666666")}>
              {"  (当前分组为空)"}
            </Text>
          </Box>
        )}
        {visibleStocks.map((stock, i) => {
          const index = listSlice.start + i;
          const isSelected = index === selectedIndex;
          const isUp = stock.changePercent >= 0;
          const color = isUp ? "#ff1493" : "#00ff41";
          const action = getAction(stock);
          return (
            <Box key={stock.code}>
              <Box width={3} flexShrink={0}>
                {isSelected ? (
                  <Text bold {...cp("#00ffff")}>
                    {"▸ "}
                  </Text>
                ) : (
                  <Text>{"  "}</Text>
                )}
              </Box>
              <Box width={9}>
                <Text bold {...cp(isSelected ? "#00ffff" : "#ffffff")}>
                  {stock.code}
                </Text>
              </Box>
              <Box width={15}>
                <Text {...cp(isSelected ? "#ffffff" : "#cccccc")}>
                  {stock.name}
                </Text>
              </Box>
              <Box width={11}>
                <Text bold {...cp(color)}>
                  {formatPrice(stock.price)}
                </Text>
              </Box>
              <Box width={10}>
                <Text {...cp(color)}>
                  {isUp ? "+" : ""}
                  {stock.changePercent.toFixed(2)}%
                </Text>
              </Box>
              <Box width={9}>
                <Text {...cp("#cccccc")}>{formatPrice(stock.high)}</Text>
              </Box>
              <Box width={9}>
                <Text {...cp("#888888")}>{formatPrice(stock.low)}</Text>
              </Box>
              <Box width={11}>
                <Text {...cp("#888888")}>
                  {stock.buyPrice !== undefined ? formatPrice(stock.buyPrice) : "-"}
                </Text>
              </Box>
              <Box width={11}>
                <Text {...cp("#888888")}>
                  {stock.sellPrice !== undefined ? formatPrice(stock.sellPrice) : "-"}
                </Text>
              </Box>
              <Box>
                {action ? (
                  <Text bold color={action.color}>
                    {action.label}
                  </Text>
                ) : (
                  <Text {...cp("#888888")}>{"-"}</Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {truncateDisplay(
            "  ↑/↓ 选择  ←/→ 切换分组  Enter 详情  a 账户  r 刷新  o 排序  h 置灰  q 退出",
            Math.max(20, columns - 4),
          )}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{"  最后更新: "}{lastUpdate}{"  编辑自选股分组: "}</Text>
        <Text {...cp("#c792ea")}>
          {osc8Link(toFileUrl(SETTINGS_PATH), truncateDisplay(SETTINGS_PATH, pathBudget))}
        </Text>
        {listTrimmed ? (
          <Text dimColor>
            {`   显示 ${listSlice.start + 1}-${listSlice.end}/${sortedStocks.length}`}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function renderDetail(
  stock: StockRow,
  targetEdit: { type: "buy" | "sell"; value: string } | null,
  flashMsg: { text: string; color: string } | null,
  prices?: number[],
  countdown = 10,
  currentTime?: string,
  chartHeight = 10,
) {
  const isUp = stock.changePercent >= 0;
  const colorCode = isUp ? "#ff1493" : "#00ff41";
  const arrow = isUp ? "▲" : "▼";
  const editing = targetEdit !== null;

  let chartLines: string[] = [];
  // 终端放不下就干脆不画：帧高顶到终端行数会触发 Ink 的整屏清屏分支
  if (prices && prices.length > 0 && chartHeight >= 2) {
    const chartColor = isUp ? asciichart.red : asciichart.green;
    const latest = latestPoints(prices, 60);
    let raw = asciichart.plot(latest, { height: chartHeight, colors: [chartColor] });
    raw = raw
      .replaceAll("╭", "┌")
      .replaceAll("╮", "┐")
      .replaceAll("╰", "└")
      .replaceAll("╯", "┘");
    chartLines = raw.split("\n");
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text bold color="#00ffff">
            {"  📊 "}
            {stock.name}{" "}
          </Text>
          <Text dimColor>{stock.code}</Text>
          {currentTime && <Text dimColor>{"  🕐 "}{currentTime}</Text>}
        </Box>
        <Text dimColor>{`${countdown}s 后刷新`}</Text>
      </Box>

      <Box>
        <Box width={16}>
          <Text bold color="#888888">
            当前价
          </Text>
        </Box>
        <Box>
          <Text bold color={colorCode}>
            {arrow} {formatPrice(stock.price)}
          </Text>
        </Box>
      </Box>
      <Box>
        <Box width={16}>
          <Text color="#888888">涨跌幅</Text>
        </Box>
        <Box>
          <Text color={colorCode}>
            {isUp ? "+" : ""}
            {stock.changePercent.toFixed(2)}%
            {"  "}
            {isUp ? "+" : ""}
            {stock.changeAmount.toFixed(3)}
          </Text>
        </Box>
      </Box>

      {/* 目标价配置 */}
      <Box marginTop={1}>
        <Box width={16}>
          <Text color="#888888">买入目标价</Text>
        </Box>
        <Box width={12}>
          <Text color="#00ff41">
            {stock.buyPrice !== undefined ? formatPrice(stock.buyPrice) : "—"}
          </Text>
        </Box>
        <Box width={16}>
          <Text color="#888888">卖出目标价</Text>
        </Box>
        <Box>
          <Text color="#ff1493">
            {stock.sellPrice !== undefined ? formatPrice(stock.sellPrice) : "—"}
          </Text>
        </Box>
      </Box>

      {/* 目标价输入框 */}
      {targetEdit && (
        <Box marginTop={1}>
          <Text bold color="#00ffff">
            {"  "}
            {targetEdit.type === "buy" ? "买入" : "卖出"}
            {"目标价: "}
            {targetEdit.value || " "}
            {"▏"}
          </Text>
          <Text dimColor>{"  Enter 确认（空=清除）  Esc 取消"}</Text>
        </Box>
      )}

      {/* 操作反馈 */}
      {flashMsg && (
        <Box marginTop={1}>
          <Text color={flashMsg.color}>{"  "}{flashMsg.text}</Text>
        </Box>
      )}

      {chartLines.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {chartLines.map((line, i) => (
            <Box key={i}>
              <Text color={colorCode}>{line || " "}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {editing
            ? "  数字/小数点输入中…"
            : "  b 买入价  s 卖出价  a 账户  Space/q 返回"}
        </Text>
      </Box>
    </Box>
  );
}