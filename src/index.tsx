#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stocking — A 股自选股实时行情 CLI（附带投资账本账户视图）
// ---------------------------------------------------------------------------
//
// 用法：
//   stocking                      # 交互式自选股列表；按 a 进入账户视图
//   stocking --account __all__     # 启动后直接定位到汇总账户
//   stocking --env pretest         # 使用预发环境接口
//   stocking login --cookie "..."  # 保存账户鉴权 Cookie
// ---------------------------------------------------------------------------

import { Command, InvalidArgumentError, Option } from "commander";
import React from "react";
import { render } from "ink";
import chalk from "chalk";
import { StockList } from "./StockList.js";
import { loadStockConfig, SETTINGS_PATH } from "./settings.js";
import {
  ACCOUNT_CONFIG_PATH,
  hasCredentials,
  loadAccountConfig,
  maskCookie,
  missingAuthCookies,
  normalizeCookie,
  saveAccountCookie,
} from "./account/config.js";
import {
  DEFAULT_ENV,
  DEFAULT_REFRESH_SECONDS,
  ENV_KEYS,
  isEnvKey,
  type EnvKey,
} from "./account/constants.js";
import { setRequestContext } from "./account/request.js";
import type { AccountConfig } from "./account/types.js";

/** 命令行参数（与 program 上注册的 option 一一对应） */
interface CliOptions {
  account?: string;
  env?: string;
  cookie?: string;
  accountRefresh?: number;
  accountConfig?: string;
}

/** 解析正整数参数（用于刷新间隔） */
function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError("必须为正整数");
  }
  return n;
}

/** 解析环境参数：非法值直接报错，而不是静默回落到正式环境 */
function parseEnv(value: string): EnvKey {
  if (!isEnvKey(value)) {
    throw new InvalidArgumentError(`不支持的环境：${value}（可选 ${ENV_KEYS.join(" / ")}）`);
  }
  return value;
}

/** 从标准输入读取内容（供 `stocking login` 管道用法） */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

const program = new Command();

// 父命令与 login 子命令都声明了 --cookie / --account-config。默认解析模式下，
// 父命令会先把 `stocking login --cookie ...` 里的这两个选项消费掉，导致子命令
// 只能拿到空 opts（静默失效）。开启位置化解析后，第一个位置参数（子命令名）之后
// 的选项全部交由子命令处理。
program.enablePositionalOptions();

program
  .name("stocking")
  .description(
    "A 股自选股实时行情 CLI；按 a 可切换到投资账本账户视图（余额 / 持仓盈亏 / 交易流水 / 账户状态）",
  )
  .version("0.2.0")
  .option("-a, --account <id>", "账户视图启动时定位到的账户（id 或名称，默认恢复上次查看）")
  // --env 仅供团队内部联调（切到预发域名）。这是面向客户的成品，
  // 帮助信息里刻意不出现任何「环境」字样，因此用 hideHelp() 从 --help 隐藏；
  // 功能完全保留，也可用 TZZB_ENV 或配置文件覆盖。
  .addOption(
    new Option("--env <env>", "接口环境（内部联调用，不在帮助中展示）")
      .argParser(parseEnv)
      .hideHelp(),
  )
  .option("--cookie <cookie>", '账户鉴权 Cookie，形如 "userid=..; ticket=..; user=.."')
  .option("--account-refresh <seconds>", "账户视图自动刷新间隔（秒，5-3600，默认 10）", parsePositiveInt)
  .option("--account-config <path>", "账户配置文件路径（默认 ~/.stocking/account.json）")
  .showHelpAfterError("（可用 --help 查看完整用法）")
  .addHelpText(
    "after",
    `
${chalk.bold("账户视图")}
  启动后按 ${chalk.cyan("a")} 进入，再按 ${chalk.cyan("a")} / ${chalk.cyan("q")} / ${chalk.cyan("Esc")} 返回自选股列表。

  ${chalk.cyan("←/→")} 或 ${chalk.cyan("[ ]")}   切换账户（账户数 > 1 时自动出现「汇总」）
  ${chalk.cyan("Tab")} / ${chalk.cyan("1-4")}      切换页签：总览 / 持仓 / 交易 / 账户
  ${chalk.cyan("↑/↓")} 或 ${chalk.cyan("j k")}    选择持仓或流水行
  ${chalk.cyan("Enter")}           展开 / 收起持仓详情
  ${chalk.cyan("t")}               交易页切换「当日成交 / 历史流水」
  ${chalk.cyan("n / b")}           历史流水翻页
  ${chalk.cyan("r")}               立即刷新     ${chalk.cyan("p")} 暂停 / 继续自动刷新

${chalk.bold("凭证")}
  CLI 读不到浏览器 Cookie，需要显式提供（三选一，优先级从高到低）：
    1. ${chalk.cyan("stocking --cookie \"userid=..; ticket=..; user=..\"")}
    2. 环境变量 ${chalk.cyan("TZZB_COOKIE")}
    3. 配置文件 ${chalk.dim("~/.stocking/account.json")}，或 ${chalk.cyan("stocking login --cookie \"...\"")}

  获取方式：浏览器登录投资账本后，在开发者工具 Console 执行 ${chalk.dim("document.cookie")}。
  需要 ${chalk.cyan("userid")} / ${chalk.cyan("ticket")} / ${chalk.cyan("user")} 三个字段，缺 userid 无法取数。

${chalk.bold("其它配置项")}
  ${chalk.cyan("TZZB_ACCOUNT_CONFIG")}  覆盖账户配置文件路径
  ${chalk.cyan("STOCKING_DEBUG")}       输出可选项失败等排查日志

${chalk.bold("示例")}
  ${chalk.dim("$ stocking login --cookie \"userid=123; ticket=abc; user=me\"")}
  ${chalk.dim("$ stocking --account-refresh 60")}
  ${chalk.dim("$ stocking -a __all__")}
`,
  );

program.action(async (opts: CliOptions) => {
  // 0) Ink 是交互式 TUI：stdin 不是终端时无法开启 raw mode，
  //    Ink 会把一屏 raw-mode 报错当成界面渲染出来。与其如此，不如提前给出
  //    可操作的提示，并保证在 CI / 管道场景下以非 0 退出码明确失败。
  if (!process.stdin.isTTY) {
    console.error(`${chalk.red("✘")} 需要交互式终端：当前 stdin 不是 TTY，无法接收按键`);
    console.error(`${chalk.dim("  可能原因：输出被管道或重定向，或在非交互环境（CI / 后台任务）中运行")}`);
    console.error(`${chalk.dim("  请在终端里直接运行；非交互场景请改用子命令，例如：")}`);
    console.error(`${chalk.dim('    stocking login --cookie "userid=..; ticket=..; user=.."')}`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdout.isTTY) {
    console.log(`${chalk.yellow("!")} 当前 stdout 不是终端，界面宽度将按 80 列渲染`);
  }

  // 1) 自选股分组配置（首次启动、v1 迁移、单分组补全、解析失败各走不同回调）
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

  // 2) 账户配置。任何异常都不能影响自选股主功能，因此整体包一层兜底
  let accountConfig: AccountConfig;
  try {
    accountConfig = loadAccountConfig({
      path: opts.accountConfig,
      env: opts.env,
      cookie: opts.cookie,
      refreshSeconds: opts.accountRefresh,
      notify: (notice) => {
        if (notice.kind === "created") {
          console.log(`${chalk.green("✔")} 已生成账户配置模板: ${chalk.dim(notice.path)}`);
          console.log(
            `${chalk.dim("  提示: 填入 Cookie 后，在界面里按 a 即可查看账户（详见 --help）")}\n`,
          );
        } else if (notice.kind === "fallback") {
          console.log(`${chalk.yellow("!")} 账户配置解析失败（${notice.reason}），本次使用默认值`);
          console.log(`${chalk.dim(`  原文件未改动，可修复后重试: ${notice.path}`)}\n`);
        } else if (notice.kind === "patched") {
          console.log(
            `${chalk.yellow("!")} 已修正账户配置中的非法字段（${notice.fields.join(" / ")}）: ${chalk.dim(notice.path)}`,
          );
        } else if (notice.kind === "migrated") {
          console.log(
            `${chalk.green("✔")} 已同步旧版配置到当前默认值（${notice.fields.join(" / ")}）: ${chalk.dim(notice.path)}`,
          );
        }
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`${chalk.yellow("!")} 账户配置不可用（${message}），本次仅提供自选股功能`);
    accountConfig = {
      env: isEnvKey(opts.env) ? opts.env : DEFAULT_ENV,
      cookie: normalizeCookie(opts.cookie ?? process.env["TZZB_COOKIE"] ?? ""),
      // 与正常路径同一套默认值，不要在这里再写死一个数字
      refreshSeconds: opts.accountRefresh ?? DEFAULT_REFRESH_SECONDS,
      path: opts.accountConfig ?? ACCOUNT_CONFIG_PATH,
      source: opts.cookie ? "flag" : "file",
    };
  }

  // 3) 注入请求上下文（服务层通过它拿环境与凭证）
  setRequestContext({ env: accountConfig.env, cookie: accountConfig.cookie });

  // 4) 启动提示：账户能力是否可用
  const missing = missingAuthCookies(accountConfig.cookie);
  if (hasCredentials(accountConfig.cookie)) {
    const from =
      accountConfig.source === "flag"
        ? "命令行参数"
        : accountConfig.source === "env"
          ? "环境变量 TZZB_COOKIE"
          : "配置文件";
    const warnPart = missing.length ? chalk.yellow(`  缺少 ${missing.join(" / ")}`) : "";
    console.log(`${chalk.green("✔")} 账户凭证已就绪（来源: ${from}）${warnPart}`);
    console.log(`${chalk.dim(`  ${maskCookie(accountConfig.cookie)}`)}\n`);
  } else if (opts.env || opts.cookie || opts.accountConfig) {
    // 用户显式传了账户相关参数却没给出有效凭证 → 直接说明原因
    console.log(`${chalk.yellow("!")} 账户凭证无效：未找到 userid，账户视图将不可用`);
    console.log(`${chalk.dim("  用法: stocking login --cookie \"userid=..; ticket=..; user=..\"")}\n`);
  } else {
    console.log(`${chalk.dim("  提示: 按 a 可查看投资账本账户；未配置凭证时会显示配置指引")}\n`);
  }

  // 5) 启动 ink 渲染
  //
  // incrementalRendering 必须开 —— 这是本界面不闪烁的前提：
  //   Ink 默认走 log-update 的 createStandard：每次渲染先 eraseLines(整屏行数)
  //   擦掉整块，再把全部内容重画一遍。本界面有时钟与刷新倒计时每秒跳动，
  //   于是整屏每秒被擦除重画一次，在终端上就是持续闪烁。
  //   打开后走 createIncremental：逐行比对，内容相同的行直接跳过
  //   （源码注释原话：「This prevents flickering during renders」），
  //   每秒只重写真正变化的 1~2 行。
  const app = render(
    <StockList
      groups={groups}
      accountConfig={accountConfig}
      initialAccountId={opts.account}
      onExit={() => process.exit(0)}
    />,
    { incrementalRendering: true },
  );
  await app.waitUntilExit;
});

/* ------------------------------------------------------------------ *
 * stocking login —— 保存账户凭证
 * ------------------------------------------------------------------ */

program
  .command("login")
  .description("保存账户鉴权 Cookie（也可用 --cookie 或环境变量 TZZB_COOKIE 临时覆盖）")
  .option("--cookie <cookie>", '完整 Cookie 串，形如 "userid=..; ticket=..; user=.."；省略时从标准输入读取')
  .option("--account-config <path>", "账户配置文件路径（默认 ~/.stocking/account.json）")
  .action(async (opts: { cookie?: string; accountConfig?: string }) => {
    const path = opts.accountConfig ?? process.env["TZZB_ACCOUNT_CONFIG"] ?? ACCOUNT_CONFIG_PATH;

    let raw = opts.cookie ?? "";
    if (!raw) {
      raw = await readStdin();
      if (!raw && process.stdin.isTTY) {
        console.error(`${chalk.red("✘")} 未提供 Cookie`);
        console.error(`${chalk.dim('  用法: stocking login --cookie "userid=..; ticket=..; user=.."')}`);
        console.error(`${chalk.dim("  或:   pbpaste | stocking login")}`);
        process.exitCode = 1;
        return;
      }
    }

    const cookie = normalizeCookie(raw);
    if (!hasCredentials(cookie)) {
      console.error(`${chalk.red("✘")} Cookie 无效：缺少 userid 字段`);
      console.error(`${chalk.dim("  需要 userid / ticket / user，可用 document.cookie 从站点页面获取")}`);
      console.error(`${chalk.dim("  本次解析结果: ")}${cookie || "(空)"}`);
      process.exitCode = 1;
      return;
    }

    try {
      const saved = saveAccountCookie(cookie, path);
      const stillMissing = missingAuthCookies(saved.cookie);
      console.log(`${chalk.green("✔")} 已保存账户凭证: ${chalk.dim(path)}`);
      console.log(`${chalk.dim(`  ${maskCookie(saved.cookie)}`)}`);
      if (stillMissing.length) {
        console.log(
          `${chalk.yellow("!")} 仍缺少 ${stillMissing.join(" / ")}，服务端可能判定为未登录`,
        );
      }
      console.log(`${chalk.dim("  运行 stocking 后按 a 即可查看账户")}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${chalk.red("✘")} 写入配置失败: ${message}`);
      console.error(`${chalk.dim(`  请检查目录是否可写: ${path}`)}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${chalk.red("✘")} ${message}`);
  if (process.env["STOCKING_DEBUG"] && err instanceof Error && err.stack) {
    console.error(chalk.dim(err.stack));
  }
  process.exit(1);
});
