// ---------------------------------------------------------------------------
// StockList — 自选股监控 + 详情视图
// ---------------------------------------------------------------------------

import { Box, Text, useInput } from "ink";
import React, { useState, useCallback, useEffect, useMemo } from "react";
import asciichart from "asciichart";
import type { StockRow, StockSymbol } from "./types.js";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import {
  fetchStocks,
  fetchStockMinute,
  getCachedMinute,
  setCachedMinute,
  _clearMinuteCache,
} from "./market.js";
import { SETTINGS_PATH } from "./settings.js";

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

/** 名称过长时截断：最多取前 maxLen 个字符（按 Unicode 码点切分，兼容 emoji 等代理对） */
function truncateName(name: string, maxLen = 5): string {
  const chars = [...name];
  return chars.length > maxLen ? chars.slice(0, maxLen).join("") : name;
}

/** 取最新 maxPoints 个点（用于折线图） */
function latestPoints(data: number[], maxPoints = 60): number[] {
  if (data.length <= maxPoints) return data;
  return data.slice(data.length - maxPoints);
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
  symbols?: StockSymbol[];
  onExit: () => void;
}

export function StockList({ symbols, onExit }: StockListProps) {
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

  type SortOrder = "default" | "asc" | "desc";
  const [sortOrder, setSortOrder] = useState<SortOrder>("default");

  const sortedStocks = useMemo(() => {
    if (sortOrder === "default") return stocks;
    return [...stocks].sort((a, b) =>
      sortOrder === "desc"
        ? b.changePercent - a.changePercent
        : a.changePercent - b.changePercent,
    );
  }, [stocks, sortOrder]);

  const { handleCtrlC } = useDoubleCtrlC(onExit);

  // 时钟
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 目标价查找表（code -> 配置），行情返回后按 code 合并
  const symbolMap = useMemo(
    () => new Map((symbols ?? []).map((s) => [s.code, s])),
    [symbols],
  );

  // 数据加载
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchStocks([...symbolMap.keys()]);
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

  // 列表自动刷新
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          void loadData();
          return 5;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [loadData]);

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

  // 键盘
  useInput(
    useCallback(
      (input, key) => {
        if (input === "c" && key.ctrl) {
          handleCtrlC();
          return;
        }
        if (detailView) {
          if (key.escape || input === "q" || input === " ") {
            setDetailView(null);
          }
          return;
        }
        if (stocks.length === 0) return;
        if (key.upArrow || input === "k") {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : stocks.length - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((prev) => (prev < stocks.length - 1 ? prev + 1 : 0));
        } else if (key.return) {
          const stock = stocks[selectedIndex];
          if (stock) setDetailView(stock);
        } else if (key.escape || input === "q") {
          onExit();
        } else if (input === "r") {
          setCountdown(5);
          void loadData();
        } else if (input === "o") {
          setSortOrder((prev) =>
            prev === "default" ? "desc" : prev === "desc" ? "asc" : "default",
          );
        } else if (input === "h") {
          setDimMode((v) => !v);
        }
      },
      [stocks, selectedIndex, detailView, onExit, loadData, handleCtrlC],
    ),
  );

  // 详情
  if (detailView) {
    return renderDetail(
      detailView,
      () => setDetailView(null),
      detailPrices ?? undefined,
      detailCountdown,
      currentTime,
    );
  }

  // 列表
  const cp = (c: string) => (dimMode ? { dimColor: true } : { color: c });
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold {...cp("#00ffff")}>
          {"  📈 自选股监控"}
        </Text>
        <Text dimColor>{"  🕐 "}{currentTime}</Text>
        <Text dimColor>
          {loading ? "  ⟳ 刷新中..." : `  ${countdown}s 后自动刷新`}
        </Text>
      </Box>

      {/* 表头 */}
      <Box>
        <Box width={3} />
        <Box width={9}>
          <Text dimColor>代码</Text>
        </Box>
        <Box width={9}>
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
        <Text dimColor>{"  " + "─".repeat(84)}</Text>
      </Box>

      <Box flexDirection="column">
        {sortedStocks.map((stock, index) => {
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
              <Box width={9}>
                <Text {...cp(isSelected ? "#ffffff" : "#cccccc")}>
                  {truncateName(stock.name)}
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
          {"  ↑/↓ 选择  Enter 详情  r 手动刷新  o 排序  h 置灰/恢复  q 退出"}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{"  最后更新: "}{lastUpdate}{"  编辑自选股: "}</Text>
        <Text {...cp("#c792ea")}>
          {osc8Link(toFileUrl(SETTINGS_PATH), SETTINGS_PATH)}
        </Text>
      </Box>
    </Box>
  );
}

function renderDetail(
  stock: StockRow,
  _onBack: () => void,
  prices?: number[],
  countdown = 10,
  currentTime?: string,
) {
  const isUp = stock.changePercent >= 0;
  const colorCode = isUp ? "#ff1493" : "#00ff41";
  const arrow = isUp ? "▲" : "▼";

  let chartLines: string[] = [];
  if (prices && prices.length > 0) {
    const chartColor = isUp ? asciichart.red : asciichart.green;
    const latest = latestPoints(prices, 60);
    let raw = asciichart.plot(latest, { height: 10, colors: [chartColor] });
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
        <Text dimColor>{"  Space/q 返回列表"}</Text>
      </Box>
    </Box>
  );
}
