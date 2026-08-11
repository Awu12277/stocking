#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stocking — A 股自选股实时行情 CLI
// ---------------------------------------------------------------------------
//
// 用法：
//   stocking          # 启动交互式列表（自选股分组取自 ~/.stocking/settings.json，←/→ 切换分组）
// ---------------------------------------------------------------------------

import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { StockList } from "./StockList.js";
import { loadStockConfig, SETTINGS_PATH } from "./settings.js";
import chalk from "chalk";

const program = new Command();
program
  .name("stocking")
  .description(
    "A 股自选股实时行情 CLI（自选股分组存于 ~/.stocking/settings.json，←/→ 切换分组）",
  )
  .version("0.2.0");

program.action(async () => {
  // 1) 读配置（首次启动、v1 迁移、单分组补全、解析失败都会走不同的回调）
  const groups = loadStockConfig({
    notify: (kind) => {
      if (kind === "created") {
        console.log(`${chalk.green("✔")} 已生成默认分组配置: ${chalk.dim(SETTINGS_PATH)}`);
        console.log(
          `${chalk.dim("  提示: 可编辑上述文件自定义分组名、组成员与目标价")}\n`,
        );
      } else if (kind === "migrated") {
        console.log(
          `${chalk.green("✔")} 已将旧版配置迁移为分组结构: ${chalk.dim(SETTINGS_PATH)}`,
        );
        console.log(`${chalk.dim("  原股票已并入「分组1」")}\n`);
      } else if (kind === "augmented") {
        console.log(
          `${chalk.green("✔")} 已自动添加「分组2」（sh601318）: ${chalk.dim(SETTINGS_PATH)}`,
        );
      }
      // "fallback" 静默：文件坏了又不致命，不打扰用户
    },
  });

  // 2) 启动 ink 渲染
  const app = render(<StockList groups={groups} onExit={() => process.exit(0)} />);
  await app.waitUntilExit;
});

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});