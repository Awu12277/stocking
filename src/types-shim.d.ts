// 让 asciichart 这种无类型声明的库在 TS 下也能用。
declare module "asciichart" {
  type Color = number | string;
  interface PlotConfig {
    height?: number;
    width?: number;
    colors?: Color[];
  }
  function plot(series: number[], config?: PlotConfig): string;
  const named: { red: Color; green: Color; default: Color };
  export default Object.assign(plot, { plot, ...named });
}
