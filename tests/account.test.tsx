// ---------------------------------------------------------------------------
// 账户视图单测
//
// 覆盖三类最容易出错、又完全可离线验证的逻辑：
//   1. 格式化与显示宽度（单位口径 + 窄终端截断）
//   2. 列表窗口化与下标计算（长列表不溢出终端高度）
//   3. 服务端字段归一化 / 参数构造 / Cookie 解析 / 错误提示映射
//
// 界面层用 ink 的 renderToString 做冒烟：它不注册终端事件、不需要 TTY，
// 因此可以在 CI 里跑。带凭证的取数路径不在此覆盖（会打真实接口）。
// ---------------------------------------------------------------------------

import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import { AccountView, moneyWithRate } from "../src/AccountView";
import {
  LIST_CHROME_ROWS,
  LIST_FIXED_ROWS,
  LIST_SAFETY_ROWS,
  StockList,
  computeListCapacity,
} from "../src/StockList";
import {
  clampRefreshSeconds,
  hasCredentials,
  loadAccountConfig,
  maskCookie,
  missingAuthCookies,
  normalizeCookie,
  parseCookie,
} from "../src/account/config";
import { CONFIG_VERSION, DEFAULT_REFRESH_SECONDS } from "../src/account/constants";
import type { ConfigNotice } from "../src/account/types";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alignRight,
  displayWidth,
  formatMoney,
  formatPercent,
  formatRatio,
  formatSignedMoney,
  trendColor,
  truncateDisplay,
  withHkPrefix,
} from "../src/account/format";
import {
  canShowPositionDetail,
  computeAccountLayout,
  computeHeaderLayout,
  positionRowCapacity,
  tradeRowCapacity,
} from "../src/account/layout";
import { clampIndex, computeWindow, sliceWindow, wrapIndex } from "../src/account/scroll";
import { ApiError, toUiError } from "../src/account/request";
import {
  buildAccountParams,
  buildAggregateAccount,
  buildStockParams,
  isEstimateWindow,
  normalizeAccountList,
  positionRateOf,
  rateFromProfit,
  toPosition,
  type FundAggregate,
} from "../src/account/services";
import type { Account, AccountConfig } from "../src/account/types";

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

describe("format：金额 / 比率 / 显示宽度", () => {
  it("金额统一为「元 + 千分位 + 两位小数」，带符号版本只给正数补 +", () => {
    expect(formatMoney(1234.5)).toBe("1,234.50");
    expect(formatMoney(0)).toBe("0.00");
    expect(formatSignedMoney(1234.5)).toBe("+1,234.50");
    expect(formatSignedMoney(-1234.5)).toBe("-1,234.50");
  });

  it("入参已是百分数，不再做任何除法（0.68 表示 0.68%）", () => {
    expect(formatPercent(0.68)).toBe("+0.68%");
    expect(formatPercent(-1.2)).toBe("-1.20%");
    expect(formatPercent(0)).toBe("0.00%");
    expect(formatRatio(96.653)).toBe("96.65%");
  });

  it("非数字输入一律安全回落，不抛异常", () => {
    expect(formatMoney("abc")).toBe("0.00");
    expect(formatPercent(null)).toBe("0.00%");
    expect(formatRatio(undefined)).toBe("0.00%");
  });

  it("港股金额按市场/代码判定加 HK$ 前缀", () => {
    expect(withHkPrefix("600519", "1", "1680.50")).toBe("1680.50");
    expect(withHkPrefix("00700", "15", "380.20")).toBe("HK$380.20");
    expect(withHkPrefix("HK00700", "1", "380.20")).toBe("HK$380.20");
    expect(withHkPrefix("00700", "15", "")).toBe("");
  });

  it("中文与 emoji 按两列计算显示宽度", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("\u001b[31mred\u001b[39m")).toBe(3); // ANSI 不计宽
  });

  it("超宽文本被截断且不超预算，预算内原样返回", () => {
    expect(truncateDisplay("abc", 5)).toBe("abc");
    expect(truncateDisplay("abc", 0)).toBe("");
    const cut = truncateDisplay("贵州茅台股份", 6);
    expect(displayWidth(cut)).toBeLessThanOrEqual(6);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("alignRight 补齐到指定显示宽度（金额列右对齐用）", () => {
    expect(alignRight("12", 5)).toBe("   12");
    expect(displayWidth(alignRight("1.23", 8))).toBe(8);
  });

  it("涨跌配色遵循 A 股习惯：红涨绿跌、零值中性", () => {
    expect(trendColor(1)).toBe("#ff1493");
    expect(trendColor(-1)).toBe("#00ff41");
    expect(trendColor(0)).toBe("#888888");
  });
});

/* ------------------------------------------------------------------ *
 * 列表窗口化
 * ------------------------------------------------------------------ */

describe("scroll：下标与可见窗口", () => {
  it("下标裁剪到合法区间", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });

  it("页签循环位移支持负数", () => {
    expect(wrapIndex(-1, 4)).toBe(3);
    expect(wrapIndex(4, 4)).toBe(0);
    expect(wrapIndex(0, 0)).toBe(0);
  });

  it("总行数不超过容量时全量展示", () => {
    expect(computeWindow(5, 2, 10)).toEqual({ start: 0, end: 5, above: 0, below: 0, size: 5 });
    expect(computeWindow(0, 0, 10)).toEqual({ start: 0, end: 0, above: 0, below: 0, size: 0 });
  });

  it("长列表窗口化后选中行始终可见，且窗口不越界", () => {
    const middle = computeWindow(100, 50, 10);
    expect(middle).toEqual({ start: 45, end: 55, above: 45, below: 45, size: 10 });

    const head = computeWindow(100, 0, 10);
    expect(head).toEqual({ start: 0, end: 10, above: 0, below: 90, size: 10 });

    const tail = computeWindow(100, 99, 10);
    expect(tail.end).toBe(100);
    expect(tail.start).toBeLessThanOrEqual(99);
    expect(tail.below).toBe(0);
    expect(tail.size).toBe(10);
  });

  it("sliceWindow 按窗口切出行数据（越界安全）", () => {
    const rows = Array.from({ length: 20 }, (_, i) => i);
    expect(sliceWindow(rows, computeWindow(20, 0, 3))).toEqual([0, 1, 2]);
    expect(sliceWindow([], computeWindow(0, 0, 3))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 终端尺寸 → 布局
 * ------------------------------------------------------------------ */

describe("layout：按终端尺寸降级列与行", () => {
  it("极窄终端隐藏市值等次要列，主体行数按高度收敛", () => {
    const narrow = computeAccountLayout(60, 20);
    expect(narrow.tiny).toBe(true);
    expect(narrow.metricColumns).toBe(2);
    expect(narrow.position.showValue).toBe(false);
    expect(narrow.position.showHoldDays).toBe(false);
    expect(narrow.bodyRows).toBe(12);
  });

  it("宽终端展示全部列", () => {
    const wide = computeAccountLayout(140, 40);
    expect(wide.tiny).toBe(false);
    expect(wide.compact).toBe(false);
    expect(wide.metricColumns).toBe(4);
    expect(wide.position.showValue).toBe(true);
    expect(wide.position.showHoldDays).toBe(true);
    expect(wide.trade.showFee).toBe(true);
  });

  it("表格可见行数扣除表头，展开详情时再扣除面板高度", () => {
    const layout = computeAccountLayout(140, 40); // bodyRows = 32
    expect(positionRowCapacity(layout, false)).toBe(31);
    // 详情面板预留 POSITION_DETAIL_ROWS(=12)，低估会让帧高溢出终端
    expect(positionRowCapacity(layout, true)).toBe(19);
    expect(tradeRowCapacity(layout)).toBe(31);
  });

  it("终端高度不足时禁止展开持仓详情", () => {
    expect(canShowPositionDetail(computeAccountLayout(140, 40))).toBe(true); // bodyRows 32
    expect(canShowPositionDetail(computeAccountLayout(140, 20))).toBe(false); // bodyRows 12
  });

  it("尺寸异常时回落到安全默认值", () => {
    const layout = computeAccountLayout(0, 0);
    expect(layout.columns).toBe(80);
    expect(layout.rows).toBe(24);
    expect(layout.bodyRows).toBeGreaterThan(0);
  });

  it("顶部行宽预算恒不超过终端宽度（折行会让帧高抖动 → 闪烁）", () => {
    for (const columns of [40, 48, 56, 60, 72, 80, 96, 108, 140, 200]) {
      const header = computeHeaderLayout({
        columns,
        clockText: "🕐 16:56:02",
        statusText: "27s 后自动刷新",
        tabNameWidth: columns < 78 ? 6 : columns < 104 ? 9 : 14,
      });

      expect(header.reservedWidth).toBeLessThanOrEqual(columns);
      expect(header.rightWidth).toBeLessThanOrEqual(Math.max(12, Math.floor(columns * 0.45)));
      expect(header.stripCapacity).toBeGreaterThanOrEqual(1);
      expect(header.stripBudget).toBeGreaterThanOrEqual(10);
    }
  });

  it("窄终端下时钟与状态文案按宽度逐级隐藏", () => {
    const base = { clockText: "🕐 16:56:02", statusText: "27s 后自动刷新", tabNameWidth: 9 };
    // 40 列：既无状态也无时钟，只剩账户名
    expect(computeHeaderLayout({ ...base, columns: 40 }).rightText).toBe("");
    // 56 列：有时钟，无状态
    const compact = computeHeaderLayout({ ...base, columns: 56 });
    expect(compact.rightText).toContain("16:56:02");
    expect(compact.rightText).not.toContain("自动刷新");
    // 72 列以上：两者都有
    expect(computeHeaderLayout({ ...base, columns: 72 }).rightText).toContain("自动刷新");
  });
});

/* ------------------------------------------------------------------ *
 * Cookie 与配置
 * ------------------------------------------------------------------ */

describe("config：Cookie 解析与清洗", () => {
  it("解析 k=v 串，忽略非法片段", () => {
    expect(parseCookie("a=1; b=2")).toEqual({ a: "1", b: "2" });
    expect(parseCookie("bad; a=1")).toEqual({ a: "1" });
    expect(parseCookie("")).toEqual({});
  });

  it("清洗换行与 Cookie: 前缀，容忍 JSON 误粘贴", () => {
    expect(normalizeCookie("userid=1;\n  ticket=2")).toBe("userid=1; ticket=2");
    expect(normalizeCookie("Cookie: userid=1; ticket=2")).toBe("userid=1; ticket=2");
    expect(normalizeCookie('{"cookie":"userid=1; ticket=2"}')).toBe("userid=1; ticket=2");
  });

  it("userid 是发起请求的硬性条件", () => {
    expect(hasCredentials("userid=1")).toBe(true);
    expect(hasCredentials("ticket=1; user=me")).toBe(false);
    expect(hasCredentials("")).toBe(false);
    expect(missingAuthCookies("userid=1")).toEqual(["ticket", "user"]);
  });

  it("Cookie 脱敏只保留前 3 位", () => {
    expect(maskCookie("userid=12345; ticket=abcdef")).toBe("userid=123***; ticket=abc***");
    expect(maskCookie("")).toBe("(空)");
  });

  it("刷新间隔夹到 [5, 3600]，非法值回落默认值", () => {
    expect(clampRefreshSeconds(3)).toBe(5);
    expect(clampRefreshSeconds(99999)).toBe(3600);
    expect(clampRefreshSeconds(30)).toBe(30);
    expect(clampRefreshSeconds("abc")).toBe(DEFAULT_REFRESH_SECONDS);
    expect(DEFAULT_REFRESH_SECONDS).toBe(10);
  });
});

describe("config：旧版配置的一次性迁移", () => {
  const tmpDir = (): string => mkdtempSync(join(tmpdir(), "stocking-cfg-"));

  it("旧默认刷新间隔（30）更新为当前默认值，并写回版本号", () => {
    const file = join(tmpDir(), "account.json");
    writeFileSync(
      file,
      JSON.stringify({ env: "pro", cookie: "userid=1", refreshSeconds: 30 }),
    );

    const notices: ConfigNotice[] = [];
    const first = loadAccountConfig({ path: file, notify: (n) => notices.push(n) });

    expect(first.refreshSeconds).toBe(DEFAULT_REFRESH_SECONDS);
    expect(notices.some((n) => n.kind === "migrated")).toBe(true);

    const written = JSON.parse(readFileSync(file, "utf-8")) as {
      version?: number;
      refreshSeconds?: number;
    };
    expect(written.version).toBe(CONFIG_VERSION);
    expect(written.refreshSeconds).toBe(DEFAULT_REFRESH_SECONDS);

    // 再读一次不应重复迁移
    expect(loadAccountConfig({ path: file }).refreshSeconds).toBe(DEFAULT_REFRESH_SECONDS);
  });

  it("用户自己设过的值不会被迁移覆盖", () => {
    const file = join(tmpDir(), "account.json");
    writeFileSync(
      file,
      JSON.stringify({ env: "pro", cookie: "userid=1", refreshSeconds: 60 }),
    );
    expect(loadAccountConfig({ path: file }).refreshSeconds).toBe(60);
  });
});

/* ------------------------------------------------------------------ *
 * 服务端字段归一化
 * ------------------------------------------------------------------ */

describe("services：账户列表归一化", () => {
  it("把按分组返回的 ex_data 拍平，并补齐 type / 参数名", () => {
    const list = normalizeAccountList({
      common: [{ fund_key: "k1", qsmc: "自动同步A" }],
      rzrq: [],
      manual: [{ manualid: "m1", manualname: "手动A" }],
      fund: [{ type: "ijj", custid: "c1", fundname: "爱基金A" }],
    });

    expect(list.map((a) => a.type)).toEqual(["stockCommon", "manual", "ijj"]);
    expect(list[0]).toMatchObject({ id: "k1", name: "自动同步A", paramKey: "fund_key" });
    expect(list[1]).toMatchObject({ id: "m1", name: "手动A", paramKey: "manual_id" });
    // 基金分组 type 需经别名表归一化：ijj → ijj，ID 字段为 custid
    expect(list[2]).toMatchObject({ id: "c1", name: "爱基金A", paramKey: "custid" });
  });

  it("兼容扁平 list 形状与空响应", () => {
    expect(normalizeAccountList({ list: [{ type: "manual", requestId: "m9" }] })).toHaveLength(1);
    expect(normalizeAccountList({})).toEqual([]);
    expect(normalizeAccountList(null)).toEqual([]);
  });
});

describe("services：持仓与比率量纲", () => {
  it("持仓行统一形状，收益率由盈亏与市值反推为百分数", () => {
    const row = toPosition({
      code: "600519",
      name: "贵州茅台",
      market: "1",
      price: "1680.50",
      count: "100",
      hold_days: "30",
      cost: "1500",
      value: "168050",
      pre_profit: "1000",
      pre_rate: "0.6",
      hold_profit: "18050",
      hold_rate: "12.03",
      stock_account: "中信证券",
    });

    expect(row.dayProfit).toBe(1000);
    expect(row.holdProfit).toBe(18050);
    // 18050 ÷ (168050 − 18050) × 100 = 12.0333%
    expect(row.holdRate).toBeCloseTo(12.03, 2);
    // 1000 ÷ (168050 − 1000) × 100 = 0.5986%
    expect(row.dayRate).toBeCloseTo(0.6, 2);
    expect(row.priceRaw).toBe(1680.5);
    expect(row.stockAccount).toBe("中信证券");
  });

  it("港股持仓价格自动带 HK$ 前缀", () => {
    expect(toPosition({ code: "00700", market: "15", price: "380.20" }).price).toBe("HK$380.20");
  });
});

describe("services：比率量纲（实测回归）", () => {
  it("仓位由 市值 ÷ 总资产 反推（实测 60405.50/60554.81 → 99.75%，服务端原字段是 0.9975）", () => {
    expect(positionRateOf(60405.5, 60554.81)).toBeCloseTo(99.75, 2);
    expect(positionRateOf(0, 1000)).toBe(0);
    expect(positionRateOf(100, 0)).toBeNull();
    expect(positionRateOf(0, 0)).toBeNull();
    expect(positionRateOf(null, null)).toBeNull();
  });

  it("服务端返回小数时也能得到正确百分数（市值 14844 / 持仓盈亏 -902.59 → -5.73%）", () => {
    const row = toPosition({
      code: "000792",
      market: "1",
      value: "14844",
      pre_profit: "-120",
      // 服务端实测给的就是这种小数
      pre_rate: "-0.008",
      hold_profit: "-902.59",
      hold_rate: "-0.0573",
    });

    expect(row.holdRate).toBeCloseTo(-5.73, 2);
    expect(row.dayRate).toBeCloseTo(-0.8, 1);
  });

  it("服务端返回百分数时结果同样正确（不会反向差 100 倍）", () => {
    // docs/API.md 的示例口径：hold_rate "10.56"、pre_rate "0.72"
    const row = toPosition({
      value: "168050",
      pre_profit: "1205",
      pre_rate: "0.72",
      hold_profit: "16050",
      hold_rate: "10.56",
    });

    expect(row.holdRate).toBeCloseTo(10.56, 2);
    expect(row.dayRate).toBeCloseTo(0.72, 2);
  });

  it("零市值 / 零盈亏不会除零或产生 NaN", () => {
    expect(toPosition({ value: "0", hold_profit: "0" }).holdRate).toBe(0);
    expect(toPosition({ value: "1000", hold_profit: "0" }).holdRate).toBe(0);
    expect(toPosition({}).holdRate).toBe(0);
    expect(Number.isNaN(toPosition({ value: "1", hold_profit: "1" }).holdRate)).toBe(false);
  });

  it("rateFromProfit 的基本口径：盈亏 ÷ (市值 − 盈亏) × 100", () => {
    expect(rateFromProfit(100, 1100)).toBeCloseTo(10, 6);
    expect(rateFromProfit(0, 1000)).toBe(0);
    expect(rateFromProfit(100, 0)).toBe(0);
  });
});

describe("services：账户参数构造", () => {
  const stock: Account = {
    id: "k1",
    name: "自动同步",
    type: "stockCommon",
    requestId: "k1",
    paramKey: "fund_key",
  };
  const fund: Account = {
    id: "c1",
    name: "爱基金",
    type: "ijj",
    requestId: "c1",
    paramKey: "custid",
  };

  it("汇总账户把多账户标识拼成逗号串，覆盖五路参数", () => {
    const aggregate = buildAggregateAccount([stock, fund]);
    expect(aggregate.count).toBe(2);
    expect(aggregate.hasStock).toBe(true);
    expect(aggregate.groups).toMatchObject({ common: "k1", ijj: "c1", manual_id: "", rzrq: "" });
    expect(buildAccountParams(aggregate)).toEqual({
      manual_id: "",
      fund_key: "k1",
      rzrq_fund_key: "",
      fundid: "",
      custid: "c1",
    });
  });

  it("单账户走各自的参数名", () => {
    expect(buildAccountParams(stock)).toEqual({ fund_key: "k1" });
    expect(buildAccountParams(fund)).toEqual({ custid: "c1" });
  });

  it("基金账户在股票侧没有合法参数，返回空对象（由调用方提示无此口径）", () => {
    expect(buildStockParams(fund)).toEqual({});
    expect(buildStockParams(stock)).toEqual({ fund_key: "k1" });
  });
});

describe("services：基金预估窗口判定", () => {
  const base: FundAggregate = {
    transDate: "2026-09-18",
    startAsset: 100000,
    asset: 101000,
    dayProfit: 1000,
    sumProfit: 5000,
    funds: [],
    estimateDates: ["2026-09-18"],
    confirmDates: [],
  };

  it("当日有估值、当日未确认、20 点前 → 标注预估", () => {
    expect(isEstimateWindow(base, new Date("2026-09-18T10:00:00"))).toBe(true);
  });

  it("当日净值已确认，或已过 20 点 → 不再自称预估", () => {
    expect(
      isEstimateWindow({ ...base, confirmDates: ["2026-09-18"] }, new Date("2026-09-18T10:00:00")),
    ).toBe(false);
    expect(isEstimateWindow(base, new Date("2026-09-18T21:00:00"))).toBe(false);
    expect(isEstimateWindow(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 错误映射
 * ------------------------------------------------------------------ */

describe("request：错误分层与排查建议", () => {
  it("401 指向 stocking login（提示判定先于分层判定）", () => {
    const networkLayer = toUiError(
      new ApiError("登录信息过期", { status: 401, code: "401", layer: "network" }),
    );
    expect(networkLayer.layer).toBe("network");
    expect(networkLayer.hint).toContain("stocking login");

    // 未显式指定分层（默认 business）时，仍应命中未授权提示
    const defaultLayer = toUiError(new ApiError("登录信息过期", { status: 401, code: "401" }));
    expect(defaultLayer.hint).toContain("stocking login");
  });

  it("超时给出重试/降频建议", () => {
    const ui = toUiError(new ApiError("请求超时：x", { code: "timeout", layer: "network" }));
    expect(ui.hint).toContain("account-refresh");
  });

  it("账户被删除提示切换账户", () => {
    const ui = toUiError(new ApiError("该账户已被删除", { code: "-2" }));
    expect(ui.hint).toContain("切换");
  });

  it("非 ApiError 也能归一化，不抛出", () => {
    const ui = toUiError(new Error("boom"));
    expect(ui.layer).toBe("unknown");
    expect(ui.message).toBe("boom");
  });
});

describe("StockList：帧高预算（Windows 整屏清屏的触发器）", () => {
  it("固定开销 + 数据行 严格小于终端行数", () => {
    for (const rows of [9, 10, 12, 20, 24, 30, 60]) {
      const capacity = computeListCapacity(rows);
      const frameHeight = LIST_FIXED_ROWS + capacity;

      // 硬性不变式：帧高 < 终端行数，否则 Ink 会走整屏清屏分支
      expect(frameHeight).toBeLessThan(rows);

      // 安全余量：高度极小时会被「至少显示 1 行」的下限挤掉，此时只要求上一条
      if (rows - LIST_CHROME_ROWS >= 1) {
        expect(frameHeight).toBeLessThanOrEqual(rows - LIST_SAFETY_ROWS);
      }
    }
  });

  it("行数非法时回落到 24 行的安全默认值", () => {
    expect(computeListCapacity(0)).toBe(24 - LIST_CHROME_ROWS);
    expect(computeListCapacity(Number.NaN)).toBe(24 - LIST_CHROME_ROWS);
    expect(computeListCapacity(24)).toBeGreaterThanOrEqual(1);
  });

  it("实际渲染的固定占用行数与 LIST_FIXED_ROWS 一致", () => {
    // 空分组时不会发起行情请求，而 loading 初值为 true（空分组提示行要等
    // loadData 跑完才出现），因此首帧恰好只含固定开销：
    //   标题 1 + 标题下留白 1 + 表头 1 + 分割线 1 + 页脚留白 1 + 提示 1 + 更新行 1 = 7
    const output = renderToString(
      <StockList
        groups={[{ name: "空分组", symbols: [] }]}
        accountConfig={{
          env: "pro",
          cookie: "",
          refreshSeconds: 10,
          path: "/tmp/stocking-account.json",
          source: "file",
        }}
        onExit={() => {}}
      />,
      { columns: 120 },
    );
    const lines = output.split("\n").filter((line, i, arr) => !(i === arr.length - 1 && line === ""));

    // 整个高度预算都建立在这个数字准确上：多算会白占屏，少算会让帧高顶到终端高度。
    // 空分组提示行（+1）由 LIST_SAFETY_ROWS 的余量吸收。
    expect(lines.length).toBe(LIST_FIXED_ROWS);
  });
});

/* ------------------------------------------------------------------ *
 * 界面冒烟（renderToString：无需 TTY，不注册终端事件）
 * ------------------------------------------------------------------ */

describe("AccountView：盈亏的百分比展示", () => {
  it("单元格放得下时金额后附百分比（108 列终端排 4 项 → 单元格 26 列）", () => {
    // 「当日盈亏」标签占 8 列 → 预算 = 26 - 8 - 1 = 17，实际需要 15 列
    expect(moneyWithRate("当日盈亏", "+408.20", 0.68, 26)).toBe("+408.20  +0.68%");
    expect(moneyWithRate("累计盈亏", "+8847.13", 17.11, 26)).toBe("+8847.13  +17.11%");
  });

  it("宽度差一点点时改用单个空格，尽量保住百分比", () => {
    // 单元格 25 列 → 预算 16；两空格版需 17 列，单空格版正好 16 列
    expect(moneyWithRate("累计盈亏", "+8847.13", 17.11, 25)).toBe("+8847.13 +17.11%");
  });

  it("放不下时退回纯金额，不把数字截断成半截片段", () => {
    const out = moneyWithRate("当日盈亏", "+1234567.89", 100, 12);
    expect(out).toBe("+1234567.89");
    expect(out).not.toContain("…");
  });
});

describe("AccountView：无凭证时的引导界面", () => {
  const config: AccountConfig = {
    env: "pro",
    cookie: "",
    refreshSeconds: 30,
    path: "/tmp/stocking-account.json",
    source: "file",
  };

  it("未配置凭证时渲染配置引导，且不发起任何请求", () => {
    const output = renderToString(
      <AccountView config={config} onBack={() => {}} onExit={() => {}} />,
    );
    expect(output).toContain("尚未配置账户凭证");
    expect(output).toContain("stocking login");
    expect(output).toContain("总览");
    expect(output).toContain("持仓");
  });

  it("顶部不再渲染标题（首行不含 💼）", () => {
    for (const columns of [80, 120]) {
      const output = renderToString(
        <AccountView config={config} onBack={() => {}} onExit={() => {}} />,
        { columns },
      );
      expect(output.split("\n")[0] ?? "").not.toContain("💼");
    }
  });

  it("渲染出的每一行都不超过终端宽度（超出会折行并抖动帧高）", () => {
    for (const columns of [80, 100, 120]) {
      const output = renderToString(
        <AccountView config={config} onBack={() => {}} onExit={() => {}} />,
        { columns },
      );
      for (const line of output.split("\n")) {
        expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("界面不出现接口环境相关字样（这是面向客户的成品）", () => {
    const output = renderToString(
      <AccountView config={config} onBack={() => {}} onExit={() => {}} />,
      { columns: 120 },
    );
    for (const word of ["接口环境", "正式环境", "预发环境", "数据源", "pretest"]) {
      expect(output).not.toContain(word);
    }
  });

  it("引导里列出缺失的鉴权字段", () => {
    const output = renderToString(
      <AccountView
        config={{ ...config, cookie: "userid=12345" }}
        onBack={() => {}}
        onExit={() => {}}
      />,
    );
    // 有 userid 就会进入取数流程，此时不该再显示引导面板
    expect(output).not.toContain("尚未配置账户凭证");
  });
});
