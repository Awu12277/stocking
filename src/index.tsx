#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stocking — A 股自选股实时行情 CLI
// ---------------------------------------------------------------------------
//
// 用法：
//   stocking                # 启动交互式列表（自选股取自 ~/.stocking/settings.json）
//   stocking sh000001 sz399006 513090  # 临时查看指定代码列表
// ---------------------------------------------------------------------------

import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { StockList } from "./StockList.js";
import { loadStockConfig, SETTINGS_PATH, saveStockConfig, DEFAULT_SYMBOLS } from "./settings.js";
import type { StockSymbol } from "./types.js";
import { existsSync } from "node:fs";
import chalk from "chalk";

const program = new Command();
program
  .name("stocking")
  .description("A 股自选股实时行情 CLI（自选股存于 ~/.stocking/settings.json）")
  .version("0.1.0")
  .argument("[codes...]", "股票代码（空格分隔），如 sh513090 sh600519");

program.action(async (codes: string[]) => {
  // 1) 解析自选股列表
  let symbols: StockSymbol[];
  if (codes.length > 0) {
    // 命令行临时查看：无目标价配置，操作列显示 "-"
    symbols = codes.map((code) => ({ code }));
  } else {
    // 从 ~/.stocking/settings.json 读取
    const cfg = loadStockConfig();
    if (!existsSync(SETTINGS_PATH)) {
      // 首次使用：写入默认自选股
      saveStockConfig(DEFAULT_SYMBOLS);
      console.log(
        `${chalk.green("✔")} 已生成默认自选股配置: ${chalk.dim(SETTINGS_PATH)}`,
      );
      console.log(`${chalk.dim("  提示: 可编辑上述文件自定义自选股及 buyPrice / sellPrice")}\n`);
    }
    symbols = cfg.symbols;
  }

  // 2) 启动 ink 渲染
  const app = render(<StockList symbols={symbols} onExit={() => process.exit(0)} />);
  await app.waitUntilExit;
});

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
