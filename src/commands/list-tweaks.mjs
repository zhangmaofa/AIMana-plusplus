import { tweaksDir } from "../paths.mjs";
import { discoverTweaks } from "../swap.mjs";
import { info } from "../util.mjs";

export async function run() {
  const tweaks = discoverTweaks(tweaksDir());
  if (!tweaks.length) {
    info("（无 tweak）");
    return;
  }
  for (const t of tweaks) {
    info(
      `${t.manifest.id}  v${t.manifest.version}  [${t.manifest.scope ?? "both"}]  ${
        t.entryExists ? "" : "入口缺失!"
      }`,
    );
  }
}
