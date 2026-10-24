#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error("[AIMana++] 命令执行失败:", err?.stack ?? err);
  process.exitCode = 1;
});
