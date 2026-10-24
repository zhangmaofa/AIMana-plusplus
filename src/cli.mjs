import { discoverAIMana } from "./paths.mjs";
import { AIANAPP_VERSION } from "./swap.mjs";
import { info } from "./util.mjs";

const HELP = `
AIMana++ v${AIANAPP_VERSION} —— MT AIMana 桌面应用的本地 tweak（插件）系统

用法: aimanapp <命令> [参数]

常用命令:
  install                 安装/修补 AIMana（幂等，重复执行安全）
  status                  查看安装状态
  repair [--quiet]        修复补丁（AIMana 更新后自动调用；也是手动修复入口）
  uninstall [--purge]     卸载并还原原版 app.asar（--purge 同时删除 tweaks/配置/日志）
  safe-mode [on|off]      临时禁用所有 tweak（不删除）
  doctor                  环境诊断

tweak 开发:
  new-tweak <目录> [--id com.you.my-tweak --name "我的插件"]
  validate-tweak <目录>   校验 tweak manifest
  list-tweaks             列出已安装 tweak

其他:
  help                    显示本帮助
  version                 显示版本
`.trim();

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  const quiet = flags.has("--quiet");

  switch (cmd ?? "help") {
    case "install":
      return (await import("./commands/install.mjs")).run({ quiet });
    case "status":
      return (await import("./commands/status.mjs")).run({ quiet });
    case "repair":
      return (await import("./commands/repair.mjs")).run({ quiet });
    case "uninstall":
      return (await import("./commands/uninstall.mjs")).run({ purge: flags.has("--purge"), quiet });
    case "safe-mode":
      return (await import("./commands/safe-mode.mjs")).run({ arg: args[0] });
    case "doctor":
      return (await import("./commands/doctor.mjs")).run();
    case "new-tweak":
      return (await import("./commands/new-tweak.mjs")).run({ dir: args[0], rest });
    case "validate-tweak":
      return (await import("./commands/validate-tweak.mjs")).run({ dir: args[0] });
    case "list-tweaks":
      return (await import("./commands/list-tweaks.mjs")).run();
    case "help":
    case "--help":
    case "-h":
      info(HELP);
      return;
    case "version":
    case "--version":
    case "-v":
      info(`AIMana++ v${AIANAPP_VERSION}`);
      return;
    default:
      console.error(`未知命令: ${cmd}`);
      info(HELP);
      process.exitCode = 1;
  }
}

export { discoverAIMana };
