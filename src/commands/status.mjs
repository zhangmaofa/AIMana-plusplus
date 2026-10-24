import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverAIMana, userRoot, tweaksDir, configFile, stateFile, AIANA_TASK_NAME } from "../paths.mjs";
import {
  appPaths,
  isStubAsar,
  readAIManaVersion,
  discoverTweaks,
  scheduledTaskExists,
  AIANAPP_VERSION,
} from "../swap.mjs";
import { readJson, info, ok, warn, fail } from "../util.mjs";

export async function run() {
  info(`AIMana++ v${AIANAPP_VERSION}`);
  info("");

  const found = discoverAIMana();
  if (!found) {
    fail("未找到 MT AIMana 安装目录");
    process.exitCode = 1;
    return;
  }
  const p = appPaths(found.dir);
  info(`AIMana 安装:  ${p.appDir}`);
  info(`AIMana 版本:  ${readAIManaVersion(p) ?? "未知"}`);

  const state = readJson(stateFile(), null);
  if (state) {
    info(`AIMana++ 安装于: ${state.installedAt}（v${state.version}）`);
  } else {
    warn("尚未安装（无 state.json）");
  }

  if (existsSync(p.origAsarPath)) {
    ok("swap 布局存在: app.orig.asar（原版）+ app.asar（stub）");
    if (existsSync(p.asarPath)) {
      if (isStubAsar(p.asarPath)) ok("app.asar 是 AIMana++ stub，补丁有效");
      else warn("app.asar 存在但不是 stub —— 可能 AIMana 刚更新过，运行 aimanapp repair");
    } else {
      fail("stub app.asar 缺失 —— 运行 aimanapp repair");
    }
  } else if (existsSync(p.asarPath)) {
    if (isStubAsar(p.asarPath)) {
      warn("app.asar 是 stub 但 app.orig.asar 缺失 —— 异常状态，运行 aimanapp doctor");
    } else {
      info("app.asar 为原版（未安装补丁）");
    }
  } else {
    fail("app.asar 与 app.orig.asar 均缺失，安装已损坏");
  }

  const cfg = readJson(configFile(), {});
  if (cfg.safeMode) warn("safe-mode 开启中（所有 tweak 被跳过）");

  const tweaks = discoverTweaks(tweaksDir());
  info("");
  info(`已安装 tweak (${tweaks.length}):`);
  const enabled = cfg.enabled ?? {};
  for (const t of tweaks) {
    const on = enabled[t.manifest.id] !== undefined ? enabled[t.manifest.id] : true;
    info(
      `  ${on ? "✔" : "✖"} ${t.manifest.id}  v${t.manifest.version}  ${t.entryExists ? "" : "(入口缺失)"}`,
    );
  }

  info("");
  info(`计划任务: ${scheduledTaskExists(AIANA_TASK_NAME) ? "已注册" : "未注册"}`);
  info(`用户目录: ${userRoot()}`);
}
