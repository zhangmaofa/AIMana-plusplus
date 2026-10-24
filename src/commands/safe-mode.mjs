import { configFile, AIANA_TASK_NAME } from "../paths.mjs";
import { scheduledTaskExists, discoverTweaks, tweaksDir, AIANAPP_VERSION } from "../swap.mjs";
import { readJson, writeJson, info, ok } from "../util.mjs";
import { existsSync } from "node:fs";

export async function run({ arg }) {
  const file = configFile();
  const cfg = readJson(file, {});
  const target = arg === "off" ? false : arg === "on" || arg === undefined ? true : null;
  if (target === null) {
    info("用法: aimanapp safe-mode [on|off]");
    return;
  }
  cfg.safeMode = target;
  writeJson(file, cfg);
  ok(target ? "safe-mode 已开启：所有 tweak 被禁用（文件保留）" : "safe-mode 已关闭");
  info("重启 AIMana（或在面板点“重载”）后生效。");
}
