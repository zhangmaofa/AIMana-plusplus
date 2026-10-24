/* eslint-disable */
/**
 * AIMana++ loader —— 由安装器放进 stub app.asar，package.json#main 指向本文件。
 *
 * 职责（设计参考 Codex++ loader）：
 *   1. 从 package.json#__aimanapp 读取元数据：原版 asar 路径、原入口、用户目录。
 *   2. 先 require 用户目录的 runtime/main.cjs —— runtime 会在 AIMana 创建任何
 *      窗口之前注册好追加式 preload，并启动 main 进程 tweak。
 *   3. 再 require 原版 asar 里的原始入口（app.orig.asar/out/main/index.js）。
 *      Electron 对 *.asar 有透明加载支持，跨 archive require 完全合法。
 *
 * 原则：插件系统全坏也不能影响 AIMana 启动 —— 任何异常只写日志，
 * 最后无条件加载原始入口。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const pkg = require("./package.json");
const meta = pkg.__aimanapp || {};
const originalAsar = meta.originalAsar;
const originalMain = meta.originalMain;
const userRoot = meta.userRoot;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function appendCappedLog(file, line) {
  try {
    const incoming = Buffer.from(line);
    if (incoming.byteLength >= MAX_LOG_BYTES) {
      fs.writeFileSync(file, incoming.subarray(incoming.byteLength - MAX_LOG_BYTES));
      return;
    }
    let existing = Buffer.alloc(0);
    if (fs.existsSync(file)) existing = fs.readFileSync(file);
    const allowed = MAX_LOG_BYTES - incoming.byteLength;
    if (existing.byteLength > allowed) existing = existing.subarray(existing.byteLength - allowed);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([existing, incoming]));
  } catch (_) {
    try {
      process.stderr.write("[aimanapp loader] log write failed\n");
    } catch (_) {}
  }
}

function safe(label, fn) {
  try {
    fn();
  } catch (e) {
    const line = `[${new Date().toISOString()}] ${label}: ${(e && e.stack) || e}\n`;
    if (userRoot) {
      appendCappedLog(path.join(userRoot, "log", "loader.log"), line);
    } else {
      try {
        process.stderr.write(`[aimanapp loader] ${line}`);
      } catch (_) {}
    }
  }
}

safe("init", () => {
  if (!originalAsar || !originalMain) {
    throw new Error("package.json 缺少 __aimanapp.originalAsar / __aimanapp.originalMain");
  }
  if (!userRoot) {
    throw new Error("package.json 缺少 __aimanapp.userRoot");
  }

  const runtimeDir = path.join(userRoot, "runtime");
  if (fs.existsSync(runtimeDir)) {
    // 允许 runtime/tweak require 用户目录里的 node_modules
    Module.globalPaths.push(path.join(runtimeDir, "node_modules"));
    process.env.AIMANAPP_USER_ROOT = userRoot;
    process.env.AIMANAPP_RUNTIME = runtimeDir;
    process.env.AIMANAPP_ORIGINAL_ASAR = originalAsar;
    process.stderr.write("[aimanapp loader] require runtime main.cjs ...\n");
    safe("runtime", () => require(path.join(runtimeDir, "main.cjs")));
    process.stderr.write("[aimanapp loader] runtime main.cjs 完成\n");
  } else {
    process.stderr.write(`[aimanapp] runtime 缺失于 ${runtimeDir}；将以未增强模式启动 AIMana。\n`);
  }
});

// 无论如何，把控制权交还给 AIMana 原始入口。
require(path.join(originalAsar, originalMain));
