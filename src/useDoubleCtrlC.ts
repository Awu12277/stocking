// ---------------------------------------------------------------------------
// 双击 Ctrl+C 退出 hook（双击间隔 800ms）
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from "react";

/** 双击 Ctrl+C 触发 onDouble */
export function useDoubleCtrlC(onDouble: () => void): {
  doubleCtrlC: boolean;
  handleCtrlC: () => void;
} {
  const [doubleCtrlC, setDoubleCtrlC] = useState(false);
  const lastPressRef = useRef<number>(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCtrlC = useCallback(() => {
    const now = Date.now();
    if (now - lastPressRef.current < 800) {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      setDoubleCtrlC(false);
      onDouble();
      return;
    }
    lastPressRef.current = now;
    setDoubleCtrlC(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setDoubleCtrlC(false), 800);
  }, [onDouble]);

  return { doubleCtrlC, handleCtrlC };
}
