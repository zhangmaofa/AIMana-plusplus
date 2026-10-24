import { discoverAIMana, userRoot, tweaksDir, AIANA_TASK_NAME } from "../paths.mjs";
import {
  appPaths,
  isStubAsar,
  readAIManaVersion,
  scheduledTaskExists,
  discoverTweaks,
} from "../swap.mjs";
import { existsSync } from "node:fs";
import { info, ok, warn, fail } from "../util.mjs";

export async function run() {
  info("== AIMana++ doctor ==\n");

  const found = discoverAIMana();
  if (!found) {
    fail("AIMana 安装目录: 未找到（可设置 AIMANA_HOME）");
    return;
  }
  const p = appPaths(found.dir);
  ok(`AIMana 安装目录: ${p.appDir}（${found.source}）`);
  info(`  AIMana 版本: ${readAIManaVersion(p) ?? "未知"}`);

  if (existsSync(p.asarPath) && isStubAsar(p.asarPath)) {
    ok("app.asar: AIMana++ stub 有效");
  } else if (existsSync(p.asarPath)) {
    warn("app.asar: 原版（未安装或已被更新覆盖）→ 运行 aimanapp install / repair");
  } else if (existsSync(p.origAsarPath)) {
    warn("app.asar 缺失但 app.orig.asar 存在 → 运行 aimanapp repair");
  } else {
    fail("app.asar 与 app.orig.asar 均缺失 → 安装已损坏，需要重装 AIMana");
    return;
  }

  info(`  app.orig.asar: ${existsSync(p.origAsarPath) ? "存在（原版备份就位）" : "不存在"}`);
  info(
    `  unpacked 目录: ${
      existsSync(p.origUnpackedPath)
        ? "已迁移为 app.orig.asar.unpacked"
        : existsSync(p.asarUnpackedPath)
          ? "仍在原名 app.asar.unpacked（未 swap）"
          : "无 unpacked 目录"
    }`,
  );

  ok(`计划任务: ${scheduledTaskExists(AIANA_TASK_NAME) ? "已注册" : "未注册（install 会尝试注册）"}`);
  info(`  用户目录: ${userRoot()}`);
  info(`  tweaks 目录: ${tweaksDir()}`);

  const tweaks = discoverTweaks(tweaksDir());
  ok(`tweak 数量: ${tweaks.length}`);
  for (const t of tweaks) {
    if (!t.entryExists) warn(`  ${t.manifest.id}: 入口缺失`);
  }

  info("\n提示: 启动 AIMana 后按 Ctrl+Alt+U 打开 AIMana++ 面板；日志在 <用户目录>\\log\\。");
}
