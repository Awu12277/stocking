// ---------------------------------------------------------------------------
// 终端尺寸 hook
//
// 需求「界面布局适配终端窗口尺寸」的数据源。
//
// 为什么不直接用 Ink 的 useWindowSize：该 hook 属于较新版本才提供的能力，
// 而这里只需要 stdout 的 columns / rows，直接监听 stdout 的 'resize' 事件
// 兼容性更好，也能在非 TTY 环境下安全回落到 80x24。
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** 非 TTY / 无法读取尺寸时的兜底值（传统终端默认大小） */
const FALLBACK: TerminalSize = { columns: 80, rows: 24 };

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? FALLBACK.columns,
    rows: stdout?.rows ?? FALLBACK.rows,
  }));

  useEffect(() => {
    if (!stdout) return undefined;

    const sync = () => {
      setSize((prev) => {
        const next = {
          columns: stdout.columns ?? FALLBACK.columns,
          rows: stdout.rows ?? FALLBACK.rows,
        };
        // 尺寸未变时不触发重渲染，避免 resize 抖动导致整屏重绘
        return next.columns === prev.columns && next.rows === prev.rows ? prev : next;
      });
    };

    sync();
    stdout.on("resize", sync);
    return () => {
      stdout.off("resize", sync);
    };
  }, [stdout]);

  return size;
}
