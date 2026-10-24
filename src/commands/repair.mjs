import { discoverAIMana } from "../paths.mjs";
import { appPaths, ensureInstalled, registerScheduledTask } from "../swap.mjs";
import { isProcessRunning, ok, warn, fail } from "../util.mjs";

/** repair 是幂等的：补丁完好时只刷新 runtime；AIMana 更新后自动重新 swap。 */
export async function run({ quiet }) {
  try {
    const found = discoverAIMana();
    if (!found) {
      if (!quiet) fail("未找到 MT AIMana 安装目录");
      return;
    }
    const p = appPaths(found.dir);
    const running = isProcessRunning("mt-aimana.exe");

    const { swapped } = await ensureInstalled(found.dir, {
      requireClosedApp: false,
      isRunningFn: () => running,
    });
    if (swapped && !running) {
      // 改名/重建 stub 都需要文件未被占用；ensureInstalled 内部 rename 若失败会抛错
    }
    await registerScheduledTask("AIManaPlusPlus Repair");
    if (!quiet) {
      ok(swapped ? "补丁已重新应用" : "补丁完好，runtime 已刷新");
    }
  } catch (e) {
    if (!quiet) {
      fail(`修复失败: ${e.message}`);
      process.exitCode = 1;
    } else {
      // 静默模式（watcher）：记录到日志由调用方重定向
    }
  }
}
