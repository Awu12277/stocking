import { defineConfig } from "tsup";

/**
 * 构建配置：
 * - npm run dev       -> watch 模式
 * - npm run build     -> 生产构建：压缩 + 类型
 */
export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: true,
  sourcemap: false,
  minify: true,
  shims: true,
});
