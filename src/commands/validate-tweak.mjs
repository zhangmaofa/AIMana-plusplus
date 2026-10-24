import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateTweakManifest, resolveEntry } from "../manifest.mjs";
import { ok, fail, info } from "../util.mjs";

export async function run({ dir }) {
  if (!dir) {
    fail("用法: aimanapp validate-tweak <tweak目录>");
    process.exitCode = 1;
    return;
  }
  const target = resolve(dir);
  const manifestPath = join(target, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`manifest.json 不存在: ${manifestPath}`);
    process.exitCode = 1;
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`manifest.json 解析失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const result = validateTweakManifest(manifest);
  for (const e of result.errors) fail(`错误 manifest.${e.path}: ${e.message}`);
  for (const w of result.warnings) info(`警告 manifest.${w.path}: ${w.message}`);

  const entry = resolveEntry(target, manifest);
  if (!entry) {
    fail("入口文件缺失（manifest.main 或 index.js[index.cjs/.mjs]）");
    result.ok = false;
  } else {
    ok(`入口: ${entry}`);
  }

  if (result.ok) {
    ok(`tweak 校验通过: ${manifest.id} v${manifest.version}`);
  } else {
    process.exitCode = 1;
  }
}
