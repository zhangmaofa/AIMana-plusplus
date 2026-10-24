import { discoverAIMana, tweaksDir } from "../paths.mjs";
import { appPaths, ensureInstalled, registerScheduledTask, AIANAPP_VERSION } from "../swap.mjs";
import { isProcessRunning, ok, warn, fail, info } from "../util.mjs";

export async function run({ quiet }) {
  const found = discoverAIMana();
  if (!found) {
    fail("未找到 MT AIMana 安装目录。可设置环境变量 AIMANA_HOME 指向安装目录后重试。");
    process.exitCode = 1;
    return;
  }
  const p = appPaths(found.dir);
  info(`AIMana++ v${AIANAPP_VERSION} → ${p.appDir}（发现方式: ${found.source}）`);

  const running = isProcessRunning("mt-aimana.exe");
  if (running && !quiet) {
    warn("MT AIMana 正在运行 —— 建议先退出再安装（改名 app.asar 需要文件未被占用）。");
  }

  try {
    const { swapped } = await ensureInstalled(found.dir, {
      requireClosedApp: running,
      isRunningFn: () => isProcessRunning("mt-aimana.exe"),
    });
    if (swapped) {
      ok("已写入 stub app.asar（原版原样保存为 app.orig.asar）");
    } else {
      ok("补丁已存在且完好");
    }
    ok("runtime / tweaks / 自托管 CLI 已就绪");
    if (registerScheduledTask("AIManaPlusPlus Repair")) {
      ok("已注册登录时自动修复任务（AIMana 更新后自动重新打补丁）");
    } else {
      warn("计划任务注册失败，AIMana 更新后需手动运行 aimanapp repair");
    }
    if (!quiet) {
      info("");
      info("完成。启动 MT AIMana，按 Ctrl+Alt+U（或点右下角 ++ 按钮）打开 AIMana++ 面板。");
      info(`tweaks 目录: ${tweaksDir()}`);
    }
  } catch (e) {
    fail(e.message);
    process.exitCode = 1;
  }
}
