import { rmSync } from "node:fs";
import { discoverAIMana, userRoot, AIANA_TASK_NAME } from "../paths.mjs";
import { appPaths, restoreOriginal, unregisterScheduledTask } from "../swap.mjs";
import { isProcessRunning, ok, warn, fail, info } from "../util.mjs";

export async function run({ purge }) {
  const found = discoverAIMana();
  if (!found) {
    fail("未找到 MT AIMana 安装目录");
    process.exitCode = 1;
    return;
  }
  const p = appPaths(found.dir);

  if (isProcessRunning("mt-aimana.exe")) {
    warn("MT AIMana 正在运行 —— 先退出它，否则文件可能被占用导致还原失败。");
  }

  try {
    const restored = await restoreOriginal(found.dir);
    if (restored) ok("已还原原版 app.asar（stub 已删除）");
    else warn("未发现 app.orig.asar —— 可能早已还原");
  } catch (e) {
    fail(`还原失败: ${e.message}（若 AIMana 在运行请先退出后重试）`);
    process.exitCode = 1;
    return;
  }

  if (unregisterScheduledTask(AIANA_TASK_NAME)) ok("已删除登录修复任务");
  else warn("计划任务不存在或删除失败");

  if (purge) {
    try {
      rmSync(userRoot(), { recursive: true, force: true });
      ok("已删除用户目录（tweaks/config/log/备份/自托管 CLI）");
    } catch (e) {
      fail(`删除用户目录失败: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    info("tweaks 与配置已保留。彻底清除请运行: aimanapp uninstall --purge");
  }
  ok("卸载完成");
}
