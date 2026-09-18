<p align="center">
  <img src="./assets/readme/hero.png" width="100%" alt="stocking — A 股自选股实时行情终端 CLI">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/stocking"><img src="https://img.shields.io/npm/v/stocking?style=flat-square&color=00ff41&labelColor=050607" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-22%2B-00ffff?style=flat-square&labelColor=050607" alt="node 22+">
  <img src="https://img.shields.io/badge/license-MIT-ff1493?style=flat-square&labelColor=050607" alt="MIT">
  <img src="https://img.shields.io/badge/ink-7-00ff41?style=flat-square&labelColor=050607" alt="ink 7">
</p>

> 终端里的 A 股自选股实时行情监控：分组切换、asciichart 分时折线、买卖目标价提示。
> 按 `a` 还能切进投资账本账户视图，看余额、持仓盈亏与交易流水。键盘就能看盘。

## 快速开始

```bash
npx stocking
```

首次启动会在 `~/.stocking/settings.json` 写入默认配置（两个分组），按提示编辑即可。Node.js 需要 **>= 22**。

想用账户视图（投资账本），再补一份凭证：

```bash
stocking login --cookie "userid=..; ticket=..; user=.."
```

## 它能做什么

- **多分组管理** — 把不同板块（指数 / 持仓 / 关注）分到不同分组，←/→ 一秒切换
- **实时行情** — 5 秒自动刷新，从腾讯财经接口拉快照（带本地兜底数据）
- **分时折线** — 进详情页看 asciichart 风格的全天分时图，10 秒更新
- **买卖目标价** — 在 `settings.json` 给每只股票设 `buyPrice` / `sellPrice`，触发条件时高亮提示
- **排序 / 折叠** — `o` 切换按涨跌幅升降序，`h` 切换暗色模式
- **账户视图** — 按 `a` 切到投资账本：总资产 / 当日与累计盈亏 / 可用余额 / 仓位 / 持仓明细 / 当日成交与历史流水 / 账户状态，多账户自动汇总

## 键盘速查

| 按键         | 列表视图             | 详情视图              |
| ------------ | -------------------- | --------------------- |
| `←` `→` `[/]` | 切换分组             | —                     |
| `↑` `↓` `jk` | 上下选中             | —                     |
| `Enter`      | 进入详情             | —                     |
| `a`          | 进入账户视图         | 进入账户视图          |
| `b` / `s`    | —                    | 编辑买入 / 卖出目标价 |
| `Esc` `q`    | 退出                 | 返回列表              |
| `r`          | 立即刷新             | —                     |
| `o`          | 切换排序             | —                     |
| `h`          | 切换暗色模式         | —                     |
| `Ctrl+C`     | 退出（双击强制退出） | —                     |

## 账户视图（投资账本）

按 `a` 从自选股列表切进去，再按 `a` / `q` / `Esc` 返回。四个页签：

| 页签 | 内容 |
| --- | --- |
| 总览 | 总资产 / 当日盈亏 / 累计盈亏 / 可用余额 / 总市值 / 仓位 / 总负债（含基金侧当日预估标注） |
| 持仓 | 资产概览 + 持仓明细（现价 / 当日涨跌 / 持仓盈亏 / 收益率 / 市值 / 持有天数 / 券商），`Enter` 展开单只详情 |
| 交易 | 当日成交流水；`t` 切到历史资金流水，`n` / `b` 翻页 |
| 账户 | 账户名称与类型 / 标识 / 接口环境 / 数据时间 / 交易日历 / 资产指标 |

账户数 ≥ 2 时自动多出一个「汇总」账户，把全部账户合计（基金侧含当日预估收益，并标注「预估 / 已确认」）。

### 账户视图键盘

| 按键 | 作用 |
| --- | --- |
| `←` `→` `[` `]` | 切换账户 |
| `Tab` / `Shift+Tab` | 切换页签 |
| `1` `2` `3` `4` | 直接跳到某页签 |
| `↑` `↓` `jk` | 选择持仓 / 流水行 |
| `Enter` | 展开 / 收起持仓详情（持仓页） |
| `t` | 交易页切换「当日成交 / 历史流水」 |
| `n` / `b` | 历史流水下一页 / 上一页 |
| `r` | 立即刷新 |
| `p` | 暂停 / 继续自动刷新 |
| `a` `q` `Esc` | 返回自选股列表 |

界面会跟随终端尺寸自适应：窄终端自动隐藏市值、持有天数、券商等次要列，长列表按可视高度窗口化滚动。

> 顶部/页脚各行都按终端宽度做了显式预算与截断，持仓详情面板的高度也与容量预留严格对齐。
> 这两点是为了保证**帧高恒定** —— 一旦某行折行，帧高就会随数值长度逐次变化，终端会反复滚动重绘（表现为闪烁）。

### 配置账户凭证

CLI 读不到浏览器的 Cookie，需要显式提供一份（优先级从高到低）：

1. 命令行参数 `--cookie`
2. 环境变量 `TZZB_COOKIE`
3. 配置文件 `~/.stocking/account.json`（推荐用 `stocking login` 写入）

```bash
# 浏览器登录投资账本后，在开发者工具 Console 执行 document.cookie，复制结果
stocking login --cookie "userid=123456; ticket=xxxx; user=me"

# 也可以从剪贴板管道进去
pbpaste | stocking login
```

需要 `userid` / `ticket` / `user` 三个字段，缺 `userid` 无法取数（`ticket` / `user` 缺失时仍会尝试请求，由服务端裁决）。

```json
{
  "env": "pro",
  "cookie": "userid=123456; ticket=xxxx; user=me",
  "refreshSeconds": 10
}
```

- `env` 支持 `pro`（正式）/ `pretest`（预发），也可用 `--env` / `TZZB_ENV` 临时覆盖
- 文件按 `0600` 落盘（含 ticket），损坏或字段非法时会被就地修正并给出提示
- **未配置凭证时按 `a` 会直接显示配置指引，不影响自选股功能**

### 账户视图相关参数

| 参数 / 子命令 | 说明 |
| --- | --- |
| `-a, --account <id>` | 启动时定位到指定账户（id 或名称，默认恢复上次查看的账户） |
| `--env <env>` | 接口环境 `pro` / `pretest`（非法值直接报错） |
| `--cookie <cookie>` | 鉴权 Cookie，形如 `"userid=..; ticket=..; user=.."` |
| `--account-refresh <seconds>` | 自动刷新间隔（5-3600，默认 10） |
| `--account-config <path>` | 账户配置文件路径 |
| `stocking login` | 保存凭证，支持 `--cookie` 或从标准输入读取 |

其它环境变量：`TZZB_ENV`、`TZZB_ACCOUNT_CONFIG`、`STOCKING_DEBUG`（输出可选项失败等排查日志）。

## 配置示例

编辑 `~/.stocking/settings.json`：

```json
{
  "groups": [
    {
      "name": "指数",
      "symbols": [
        { "code": "sh000001" },
        { "code": "sz399006" },
        { "code": "sh000300" }
      ]
    },
    {
      "name": "持仓",
      "symbols": [
        { "code": "sh601318", "buyPrice": 38.5, "sellPrice": 45.0 },
        { "code": "sz000858", "buyPrice": 145, "sellPrice": 180 }
      ]
    }
  ]
}
```

- 旧版（`{ symbols: [...] }`）会自动迁移到分组结构，原股票归入「分组 1」
- 单分组会自动补一个空的「分组 2」便于切换
- `buyPrice` / `sellPrice` 缺省或非法值不参与触发判断

## 常用代码

| 标的类型 | 代码示例  | 前缀  |
| -------- | --------- | ----- |
| 上证     | 601318    | sh    |
| 深证     | 000858    | sz    |
| 创业板   | 300750    | sz    |
| 科创板   | 688981    | sh    |
| 指数     | 000001    | sh    |

可只填数字（`601318`），CLI 会自动补前缀。

## 工作原理

```
src/index.tsx            Commander 入口 + Ink 启动 + 凭证提示
src/StockList.tsx        自选股列表 / 详情 UI、键盘事件、目标价编辑
src/AccountView.tsx      账户视图：页签、自适应表格、详情面板、键盘交互
src/market.ts            行情数据获取与本地分时缓存
src/settings.ts          ~/.stocking/settings.json 读写、v1→v2 迁移、容错清洗
src/groups.ts            分组切换、目标价写入的纯函数
src/account/
  constants.ts           环境、接口路径、错误码、账户类型、配色
  types.ts               领域类型（含「服务端无此字段 = null」的约定）
  format.ts              金额 / 比率 / 日期 + 终端显示宽度与截断
  config.ts              ~/.stocking/account.json 读写、Cookie 解析与脱敏
  request.ts             统一请求层：Cookie 鉴权、信封解析、错误分层、取消与重试
  services.ts            账户 / 卡片 / 持仓 / 走势 / 成交 / 流水 / 交易日 / 基金聚合
  aggregate.ts           汇总账户的卡片与持仓聚合（收益率按成本法反推）
  loaders.ts             视图级组合取数（按账户类型选口径 + 可选项降级）
  layout.ts             终端尺寸 → 断点与列宽（纯函数）
  scroll.ts             下标计算与列表窗口化（纯函数）
  useTerminalSize.ts    监听 stdout resize，非 TTY 回落 80x24
  useAccountData.ts     取数 / 缓存 / 自动刷新 / 取消 / 错误保留
```

数据源在 `src/market.ts` 内部维护，公开行情接口不在此展开。如接口迁移，修改 `src/market.ts` 即可；
账户侧接口路径统一收敛在 `src/account/constants.ts`。


## 局限

- 行情数据来自第三方公开接口，**不保证实时性和准确性**，请勿用于实盘决策
- 账户数据要求自备登录 Cookie，且**只读**：不做任何下单、记账等写操作
- 列表页 5 秒自动刷新一次，详情页 10 秒一次；账户视图默认 10 秒一次（`--account-refresh` 可调）
- 网络失败时自选股回退到本地示例数据、账户视图保留上一份数据并挂错误条，界面仍能渲染
- 账户视图是交互式 TUI，需要 TTY；非交互场景（管道 / CI）会明确报错并退出

## 开发

```bash
git clone https://github.com/Awu12277/stocking.git
cd stocking
npm install
npm run dev        # tsup watch 模式
npm run build      # 生产构建
npm run type-check # tsc --noEmit
npm test           # vitest：格式化 / 布局 / 窗口化 / 归一化 / 错误映射 / 界面冒烟
```

## License

[MIT](./LICENSE)
