/** 单只股票快照的显示行（终端表格渲染用） */
export interface StockRow {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  changeAmount: number;
  high: number;
  low: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 买入目标价（来自 settings.json，未配置则 undefined） */
  buyPrice?: number;
  /** 卖出目标价（来自 settings.json，未配置则 undefined） */
  sellPrice?: number;
}

/** 单条自选股配置 */
export interface StockSymbol {
  code: string;
  name?: string;
  /** 买入目标价：最新价 ≤ 此价时，操作列提示「买入」 */
  buyPrice?: number;
  /** 卖出目标价：最新价 ≥ 此价时，操作列提示「卖出」 */
  sellPrice?: number;
}

/**
 * 一个自选股分组。同一分组内代码不应重复（写入时做去重校验）。
 */
export interface Group {
  name: string;
  symbols: StockSymbol[];
}

/**
 * v2 配置：多分组。自 v1（扁平 symbols）迁移后等价于一个分组。
 */
export interface StockConfig {
  groups: Group[];
}
