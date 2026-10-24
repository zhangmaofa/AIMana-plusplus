import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tweaksDir } from "../paths.mjs";
import { ensureDir, writeJson, ok, fail, info } from "../util.mjs";
import { validateTweakManifest } from "../manifest.mjs";

/** 解析 --id / --name 之类的内联参数。 */
function flagValue(rest, flag, fallback) {
  const i = rest.indexOf(flag);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

export async function run({ dir, rest }) {
  if (!dir) {
    fail("用法: aimanapp new-tweak <目录> [--id com.you.my-tweak --name \"我的插件\"]");
    process.exitCode = 1;
    return;
  }
  const target = resolve(dir);
  if (existsSync(join(target, "manifest.json"))) {
    fail(`目录已存在 tweak: ${target}`);
    process.exitCode = 1;
    return;
  }
  const id = flagValue(rest, "--id", "com.you.my-tweak");
  const name = flagValue(rest, "--name", "My Tweak");
  const description = flagValue(rest, "--description", "AIMana++ 示例插件");

  ensureDir(target);
  const manifest = {
    id,
    name,
    version: "0.1.0",
    githubRepo: "zhangmaofa/AIMana-plusplus",
    description,
    author: "you",
    tags: ["example"],
    scope: "renderer",
    main: "index.js",
    permissions: ["settings", "ipc"],
  };
  const check = validateTweakManifest(manifest);
  if (!check.ok) {
    for (const e of check.errors) fail(`manifest.${e.path}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  writeJson(join(target, "manifest.json"), manifest);

  const entry = `/**
 * ${name} —— AIMana++ tweak
 *
 * start(api) 在 tweak 被启用后调用；stop() 在禁用/重载时调用。
 * api.manifest / api.storage / api.log / api.ipc / api.settings / api.fs
 */
module.exports = {
  start(api) {
    api.log.info("hello from ${id}");

    const handle = api.settings.register({
      id: "main",
      title: api.manifest.name,
      description: "我的第一个 AIMana++ 区块",
      render(root) {
        const btn = document.createElement("button");
        btn.textContent = "点我";
        btn.style.cssText =
          "background:#2a2a33;color:#eee;border:1px solid #444;border-radius:6px;padding:4px 12px;cursor:pointer";
        let n = 0;
        btn.addEventListener("click", () => {
          n++;
          btn.textContent = \`点了 \${n} 次\`;
          api.storage.set("clicks", n);
        });
        root.appendChild(btn);
        return () => {
          // 区块被卸载时的清理（可选）
        };
      },
    });

    return {
      async stop() {
        handle.unregister();
      },
    };
  },
};
`;
  writeFileSync(join(target, "index.js"), entry, "utf8");

  ok(`tweak 已创建: ${target}`);
  info(`  manifest.json / index.js（id=${id}）`);
  info(`下一步:`);
  info(`  1) 编辑 ${join(target, "index.js")}`);
  info(`  2) aimanapp validate-tweak ${dir}`);
  info(`  3) 把整个目录复制/链接到 ${tweaksDir()} 下，然后在 AIMana++ 面板点“重载”`);
}
