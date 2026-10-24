/**
 * AIMana++ 核心：stub-swap 安装机制。
 *
 * Electron 的应用查找顺序（shell/common/node_bindings.cc，v41.7.2）：
 *   const search_paths = { "app.asar", "app", "default_app.asar" };
 * 即 app.asar 优先。因此我们：
 *
 *   1. 把原版 resources/app.asar 原样改名为 resources/app.orig.asar
 *      （app.asar.unpacked 同步改名为 app.orig.asar.unpacked，保持 unpacked 映射）。
 *      原文件一个字节都不改，随时可回滚。
 *   2. 在 resources/app.asar 原位写一个极小的 stub asar：只含
 *      package.json（拷贝原版并改写 main / 注入 __aimanapp 元数据）和 loader.cjs。
 *   3. Electron 启动 → 加载 stub → loader 先 require 用户目录的 AIMana++ runtime
 *      （runtime 注册追加式 preload、加载 main 进程 tweak）→ 再 require
 *      app.orig.asar 里的原始入口，AIMana 照常启动。
 *
 * 安装/卸载都是秒级文件操作，没有 500MB+ 的重打包。
 */
import { createPackageWithOptions, extractFile } from "@electron/asar";
import {
  existsSync,
  renameSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, writeJson, sha256File } from "./util.mjs";
import {
  userRoot,
  runtimeDir,
  tweaksDir,
  logDir,
  backupDir,
  stateFile,
  stagedAppDir,
} from "./paths.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AIANAPP_VERSION = readJson(join(PKG_ROOT, "package.json"), {}).version ?? "0.0.0";

export const ORIG_ASAR = "app.orig.asar";
export const STUB_META_KEY = "__aimanapp";

/** 判断一个 asar 是否是我们的 stub（读 header 里的 package.json）。 */
export function readAsarPackageJson(asarPath) {
  try {
    const buf = extractFile(asarPath, "package.json");
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

export function isStubAsar(asarPath) {
  const pkg = readAsarPackageJson(asarPath);
  return !!(pkg && pkg[STUB_META_KEY]);
}

/** AIMana 安装目录信息。 */
export function appPaths(appDir) {
  return {
    appDir,
    exePath: join(appDir, "mt-aimana.exe"),
    resourcesDir: join(appDir, "resources"),
    asarPath: join(appDir, "resources", "app.asar"),
    origAsarPath: join(appDir, "resources", ORIG_ASAR),
    origUnpackedPath: join(appDir, "resources", `${ORIG_ASAR}.unpacked`),
    asarUnpackedPath: join(appDir, "resources", "app.asar.unpacked"),
  };
}

/** 读取 AIMana 自身版本（从原版 asar 的 package.json）。 */
export function readAIManaVersion(p) {
  const pkg =
    (existsSync(p.origAsarPath) ? readAsarPackageJson(p.origAsarPath) : null) ??
    (existsSync(p.asarPath) && !isStubAsar(p.asarPath) ? readAsarPackageJson(p.asarPath) : null);
  return pkg?.version ?? null;
}

/**
 * 构建并写入 stub asar。
 * stub 的 package.json = 原版 package.json + main: loader.cjs + __aimanapp 元数据，
 * 保留原版 name/version 等字段，避免任何读自身元数据的代码行为异常。
 */
export async function buildStubAsar(p, opts) {
  const { originalAsar, userRootDir, aiManaVersion } = opts;
  const originalPkg = readAsarPackageJson(originalAsar);
  if (!originalPkg) {
    throw new Error(`无法读取原版 asar 的 package.json: ${originalAsar}`);
  }
  if (originalPkg[STUB_META_KEY]) {
    throw new Error("原版 asar 竟然包含 AIMana++ 元数据，拒绝继续（数据异常）");
  }

  const originalMain = typeof originalPkg.main === "string" ? originalPkg.main : "./out/main/index.js";
  const stubPkg = {
    ...originalPkg,
    main: "aimanapp-loader.cjs",
    [STUB_META_KEY]: {
      version: AIANAPP_VERSION,
      originalAsar, // 绝对路径，指向改名后的 app.orig.asar
      originalMain, // 原始入口，例如 "./out/main/index.js"
      userRoot: userRootDir,
      aiManaVersion,
    },
  };

  const work = join(userRootDir, "backup", `stub-build-${Date.now()}`);
  ensureDir(work);
  writeJson(join(work, "package.json"), stubPkg);
  cpSync(join(PKG_ROOT, "assets", "loader.cjs"), join(work, "aimanapp-loader.cjs"));

  const staging = `${p.asarPath}.aimanapp-new`;
  try {
    await createPackageWithOptions(work, staging, {
      globOptions: { dot: true },
    });
    // 原子替换：先写 staging 再 rename
    if (existsSync(p.asarPath)) rmSync(p.asarPath, { force: true });
    renameSync(staging, p.asarPath);
  } catch (e) {
    try {
      rmSync(staging, { force: true });
    } catch {}
    throw e;
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {}
  }
  return stubPkg;
}

/**
 * 安装 / 重装。幂等：
 *  - 未安装 → 完整执行 swap
 *  - 已安装且完好 → 仅刷新 runtime 与 state
 *  - 已安装但 AIMana 更新过（app.asar 变成新的原版）→ 重新 swap
 */
export async function ensureInstalled(appDir, options = {}) {
  const p = appPaths(appDir);
  if (!existsSync(p.exePath)) throw new Error(`找不到 ${p.exePath}`);

  const root = userRoot();
  for (const d of [root, runtimeDir(), tweaksDir(), logDir(), backupDir()]) ensureDir(d);

  const ur = userRoot();

  // ---- swap asar ----
  let swapped = false;
  if (!existsSync(p.asarPath) && !existsSync(p.origAsarPath)) {
    throw new Error(`原版 app.asar 不存在: ${p.asarPath}`);
  }

  if (existsSync(p.origAsarPath)) {
    // 之前装过。检查当前 app.asar：
    if (!existsSync(p.asarPath)) {
      // stub 丢了（比如更新器删了）→ 重建
      await buildStubAsar(p, {
        originalAsar: p.origAsarPath,
        userRootDir: ur,
        aiManaVersion: readAIManaVersion(p),
      });
      swapped = true;
    } else if (isStubAsar(p.asarPath)) {
      // 完好，无需动
    } else {
      // app.asar 是新的原版（AIMana 更新过）→ 换掉旧的 orig，重新 swap
      rmSync(p.origAsarPath, { force: true });
      if (existsSync(p.origUnpackedPath)) rmSync(p.origUnpackedPath, { recursive: true, force: true });
      renameSync(p.asarPath, p.origAsarPath);
      if (existsSync(p.asarUnpackedPath)) renameSync(p.asarUnpackedPath, p.origUnpackedPath);
      await buildStubAsar(p, {
        originalAsar: p.origAsarPath,
        userRootDir: ur,
        aiManaVersion: readAIManaVersion(p),
      });
      swapped = true;
    }
  } else {
    // 全新安装：原样改名原版（含 unpacked 目录）
    if (options.requireClosedApp && options.isRunningFn?.()) {
      throw new Error(
        "MT AIMana 正在运行，无法改名 app.asar。请先退出 AIMana 再运行安装（taskkill /IM mt-aimana.exe）。",
      );
    }
    renameSync(p.asarPath, p.origAsarPath);
    if (existsSync(p.asarUnpackedPath)) renameSync(p.asarUnpackedPath, p.origUnpackedPath);
    await buildStubAsar(p, {
      originalAsar: p.origAsarPath,
      userRootDir: ur,
      aiManaVersion: readAIManaVersion(p),
    });
    swapped = true;
  }

  // ---- 播种 runtime / tweaks / 自托管 CLI ----
  stageRuntime();
  seedTweaks();
  stageSelf();
  writeWatcherScript();

  // ---- state ----
  writeJson(stateFile(), {
    version: AIANAPP_VERSION,
    installedAt: new Date().toISOString(),
    appDir,
    origAsar: p.origAsarPath,
    stubSwappedNow: swapped,
    stubHash: sha256File(p.asarPath),
    aiManaVersion: readAIManaVersion(p),
  });

  return { swapped };
}

/** 把 assets/runtime 复制到用户目录（每次 install/repair 都刷新）。 */
export function stageRuntime() {
  const src = join(PKG_ROOT, "assets", "runtime");
  const dst = runtimeDir();
  ensureDir(dst);
  for (const f of ["main.cjs", "preload.cjs"]) {
    cpSync(join(src, f), join(dst, f));
  }
}

/** 首次安装时把仓库自带的示例 tweak 复制到用户 tweaks 目录（不覆盖已有）。 */
export function seedTweaks() {
  const dst = tweaksDir();
  ensureDir(dst);
  const src = join(PKG_ROOT, "tweaks");
  let seeded = false;
  for (const name of listTweakSources()) {
    const target = join(dst, name);
    if (existsSync(target)) continue;
    cpSync(join(src, name), target, { recursive: true });
    seeded = true;
  }
  return seeded;
}

function listTweakSources() {
  try {
    return readdirSync(join(PKG_ROOT, "tweaks")).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * 把 CLI 自身完整复制到 <userRoot>/app，让 watcher/repair 不依赖仓库位置。
 * （Codex++ 同款做法：安装器只负责"开洞"，其余全部自托管在用户目录。）
 */
export function stageSelf() {
  const dst = stagedAppDir();
  ensureDir(dst);
  for (const entry of ["bin", "src", "assets", "tweaks", "docs"]) {
    const from = join(PKG_ROOT, entry);
    if (existsSync(from)) cpSync(from, join(dst, entry), { recursive: true });
  }
  cpSync(join(PKG_ROOT, "package.json"), join(dst, "package.json"));
  const nmSrc = join(PKG_ROOT, "node_modules");
  const nmDst = join(dst, "node_modules");
  if (existsSync(nmSrc)) {
    ensureDir(nmDst);
    cpSync(join(nmSrc, "@electron"), join(nmDst, "@electron"), { recursive: true });
  }
}

/** 写出 watcher 脚本（cmd + 隐藏窗口的 vbs 启动器）。 */
export function writeWatcherScript() {
  const binDir = join(userRoot(), "bin");
  ensureDir(binDir);
  const nodeExe = process.execPath;
  const cli = join(stagedAppDir(), "bin", "aimanapp.mjs");
  const cmd = [
    "@echo off",
    `chcp 65001 >nul`,
    `"${nodeExe}" "${cli}" repair --quiet >> "${join(logDir(), "watcher.log")}" 2>&1`,
    "",
  ].join("\r\n");
  writeFileSync(join(binDir, "aimanapp-repair.cmd"), cmd, "utf8");

  // vbs 以隐藏窗口运行 cmd（避免每次登录弹出黑框）
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${join(binDir, "aimanapp-repair.cmd")}""", 0, False`,
    "",
  ].join("\r\n");
  writeFileSync(join(binDir, "aimanapp-repair.vbs"), vbs, "utf8");
}

/** 当前用户"启动"文件夹里的开机入口（无需管理员权限）。 */
export function startupEntryPath() {
  const appData = process.env.APPDATA ?? "";
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "AIManaPlusPlus-Repair.vbs");
}

export function installStartupEntry() {
  writeWatcherScript();
  const entry = startupEntryPath();
  try {
    ensureDir(dirname(entry));
    cpSync(join(userRoot(), "bin", "aimanapp-repair.vbs"), entry);
    return true;
  } catch {
    return false;
  }
}

export function uninstallStartupEntry() {
  try {
    rmSync(startupEntryPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function startupEntryExists() {
  return existsSync(startupEntryPath());
}

export function registerScheduledTask() {
  return installStartupEntry();
}

export function unregisterScheduledTask() {
  return uninstallStartupEntry();
}

export function scheduledTaskExists() {
  return startupEntryExists();
}

/**
 * 卸载：还原 asar（stub 删除、原版改回），删除计划任务。
 * --purge 额外删除整个用户目录（tweaks/config/log）。
 */
export async function restoreOriginal(appDir) {
  const p = appPaths(appDir);
  let restored = false;
  if (existsSync(p.origAsarPath)) {
    if (existsSync(p.asarPath)) rmSync(p.asarPath, { force: true });
    renameSync(p.origAsarPath, p.asarPath);
    if (existsSync(p.origUnpackedPath)) {
      if (existsSync(p.asarUnpackedPath)) rmSync(p.asarUnpackedPath, { recursive: true, force: true });
      renameSync(p.origUnpackedPath, p.asarUnpackedPath);
    }
    restored = true;
  }
  return restored;
}

/** 收集 tweaks 目录下合法的 tweak（供 CLI 与 runtime 共用）。 */
export function discoverTweaks(tweaksDirectory) {
  if (!existsSync(tweaksDirectory)) return [];
  const out = [];
  for (const name of readdirSafe2(tweaksDirectory)) {
    const dir = join(tweaksDirectory, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const entry = resolveEntryPath(dir, manifest);
    out.push({
      dir,
      entry,
      manifest,
      entryExists: !!entry,
      valid: isValidManifest(manifest),
    });
  }
  return out;
}

function isValidManifest(m) {
  return (
    !!m &&
    typeof m.id === "string" &&
    typeof m.name === "string" &&
    typeof m.version === "string" &&
    typeof m.githubRepo === "string" &&
    /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(m.githubRepo) &&
    (!m.scope || ["renderer", "main", "both"].includes(m.scope))
  );
}

function resolveEntryPath(dir, manifest) {
  const candidates = manifest.main ? [manifest.main] : ["index.js", "index.cjs", "index.mjs"];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function readdirSafe2(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 目录穿越防护：确保 target 在 root 内。 */
export function withinDir(root, target) {
  const r = resolve(root) + sep;
  const t = resolve(target);
  return t === resolve(root) || t.startsWith(r);
}
