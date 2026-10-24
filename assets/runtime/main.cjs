/* eslint-disable */
/**
 * AIMana++ runtime —— 主进程部分。
 *
 * 由 loader.cjs 在 AIMana 原始入口之前 require。职责：
 *   1. 注册追加式 preload（session.registerPreloadScript + session-created 钩子），
 *      不触碰 AIMana 自己的 webPreferences.preload。
 *   2. 发现并启动 main 进程 tweak。
 *   3. 提供 tweak 与面板用的 IPC（list-tweaks / user-paths / set-enabled / reload /
 *      read-tweak-source / tweak-log / storage-op）。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, session, ipcMain, BrowserWindow } = require("electron");

const USER_ROOT = process.env.AIMANAPP_USER_ROOT || path.join(__dirname, "..");
const RUNTIME_DIR = process.env.AIMANAPP_RUNTIME || __dirname;
const TWEAKS_DIR = path.join(USER_ROOT, "tweaks");
const LOG_DIR = path.join(USER_ROOT, "log");
const TWEAK_DATA_DIR = path.join(USER_ROOT, "tweak-data");
const CONFIG_FILE = path.join(USER_ROOT, "config.json");
const STATE_FILE = path.join(USER_ROOT, "state.json");
const PRELOAD_PATH = path.join(RUNTIME_DIR, "preload.cjs");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const loadedMainTweaks = new Map(); // id -> { stop?(), manifest }

function logLine(level, scope, args) {
  try {
    const list = Array.isArray(args) ? args : [args];
    let line = `[${new Date().toISOString()}] [${level}]${scope ? ` [${scope}]` : ""} ${list
      .map((a) => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ")}\n`;
    let existing = Buffer.alloc(0);
    const file = path.join(LOG_DIR, "main.log");
    if (fs.existsSync(file)) existing = fs.readFileSync(file);
    const incoming = Buffer.from(line);
    if (incoming.byteLength >= MAX_LOG_BYTES) {
      fs.writeFileSync(file, incoming.subarray(incoming.byteLength - MAX_LOG_BYTES));
      return;
    }
    const allowed = MAX_LOG_BYTES - incoming.byteLength;
    if (existing.byteLength > allowed) existing = existing.subarray(existing.byteLength - allowed);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.concat([existing, incoming]));
  } catch (_) {}
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  } catch (e) {
    logLine("error", "config", ["write failed", file, String(e)]);
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {});
  return {
    safeMode: !!cfg.safeMode,
    enabled: cfg.enabled && typeof cfg.enabled === "object" ? cfg.enabled : {},
    hotkey: typeof cfg.hotkey === "string" ? cfg.hotkey : "Ctrl+Alt+U",
  };
}

function saveConfig(cfg) {
  writeJsonSafe(CONFIG_FILE, cfg);
}

function isEnabled(cfg, id) {
  return cfg.enabled[id] !== undefined ? !!cfg.enabled[id] : true;
}

/** ------------------------------------------------ discovery ---- */

function discoverTweaks() {
  if (!fs.existsSync(TWEAKS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(TWEAKS_DIR)) {
    const dir = path.join(TWEAKS_DIR, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest.id !== "string") continue;
    const entry = resolveEntry(dir, manifest);
    out.push({
      dir,
      entry,
      manifest,
      entryExists: !!entry,
    });
  }
  return out;
}

function resolveEntry(dir, manifest) {
  const candidates = manifest.main
    ? [manifest.main]
    : ["index.js", "index.cjs", "index.mjs"];
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** ------------------------------------------------ tweak API ---- */

function withinDir(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function createStorage(id) {
  const file = path.join(TWEAK_DATA_DIR, id, "storage.json");
  let cache = readJson(file, {});
  const flush = () => writeJsonSafe(file, cache);
  return {
    get(key, fallback) {
      return key in cache ? cache[key] : fallback;
    },
    set(key, value) {
      cache[key] = value;
      flush();
    },
    delete(key) {
      delete cache[key];
      flush();
    },
    all() {
      return { ...cache };
    },
    _file: file,
  };
}

function createLogger(id) {
  return {
    debug: (...args) => logLine("debug", id, args),
    info: (...args) => logLine("info", id, args),
    warn: (...args) => logLine("warn", id, args),
    error: (...args) => logLine("error", id, args),
  };
}

function createTweakFs(id) {
  const dataDir = path.join(TWEAK_DATA_DIR, id);
  return {
    dataDir,
    read(relPath) {
      const p = path.join(dataDir, relPath);
      if (!withinDir(dataDir, p)) return Promise.reject(new Error("路径越界"));
      return fs.promises.readFile(p, "utf8");
    },
    write(relPath, contents) {
      const p = path.join(dataDir, relPath);
      if (!withinDir(dataDir, p)) return Promise.reject(new Error("路径越界"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return fs.promises.writeFile(p, contents, "utf8");
    },
    exists(relPath) {
      const p = path.join(dataDir, relPath);
      if (!withinDir(dataDir, p)) return Promise.reject(new Error("路径越界"));
      return Promise.resolve(fs.existsSync(p));
    },
  };
}

function readState() {
  return readJson(STATE_FILE, {});
}

function buildMainApi(tweak) {
  const id = tweak.manifest.id;
  const channel = `aimanapp:t:${id}`;
  return {
    manifest: Object.freeze({ ...tweak.manifest }),
    storage: createStorage(id),
    log: createLogger(id),
    process: "main",
    ipc: {
      on(ch, handler) {
        const wrapped = (_event, ...args) => handler(...args);
        ipcMain.on(`${channel}:${ch}`, wrapped);
        return () => ipcMain.removeListener(`${channel}:${ch}`, wrapped);
      },
      handle(ch, handler) {
        ipcMain.handle(`${channel}:${ch}`, (_event, ...args) => handler(...args));
      },
      send(ch, ...args) {
        for (const win of BrowserWindow.getAllWindows()) {
          try {
            win.webContents.send(`${channel}:${ch}`, ...args);
          } catch (_) {}
        }
      },
    },
    fs: createTweakFs(id),
    app: {
      getVersion: () => app.getVersion(),
      getPath: (name) => {
        try {
          return app.getPath(name);
        } catch {
          return null;
        }
      },
      quit: () => app.quit(),
    },
    windows: {
      list() {
        return BrowserWindow.getAllWindows().map((w) => ({
          id: w.id,
          title: w.getTitle(),
          url: safeUrl(w),
          focused: w.isFocused(),
        }));
      },
      focus(windowId) {
        const w = BrowserWindow.getAllWindows().find((x) => x.id === windowId);
        if (w) w.focus();
        return !!w;
      },
      reloadAll() {
        for (const w of BrowserWindow.getAllWindows()) {
          try {
            w.webContents.reload();
          } catch (_) {}
        }
      },
    },
    aiMana: {
      version: readState().aiManaVersion ?? null,
      userRoot: USER_ROOT,
    },
  };
}

function safeUrl(win) {
  try {
    return win.webContents.getURL();
  } catch {
    return null;
  }
}

/** ------------------------------------------------ main tweaks ---- */

function startMainTweaks() {
  const cfg = loadConfig();
  if (cfg.safeMode) {
    logLine("info", "", "safe-mode 开启，跳过所有 tweak");
    return;
  }
  const tweaks = discoverTweaks();
  for (const t of tweaks) {
    const scope = t.manifest.scope || "both";
    if (scope === "renderer") continue; // main 进程不加载纯渲染 tweak
    if (!t.entryExists) continue;
    if (!isEnabled(cfg, t.manifest.id)) continue;
    if (loadedMainTweaks.has(t.manifest.id)) continue;
    try {
      delete require.cache[t.entry];
      const mod = require(t.entry);
      const api = buildMainApi(t);
      const maybe = typeof mod?.start === "function" ? mod.start(api) : undefined;
      loadedMainTweaks.set(t.manifest.id, {
        manifest: t.manifest,
        stop: typeof mod?.stop === "function" ? mod.stop : undefined,
        maybePromise: maybe,
      });
      logLine("info", "", `main tweak 已加载: ${t.manifest.id}`);
    } catch (e) {
      logLine("error", "", `main tweak 加载失败 ${t.manifest.id}: ${(e && e.stack) || e}`);
    }
  }
  logLine("info", "", `main 进程共加载 ${loadedMainTweaks.size} 个 tweak`);
}

async function stopMainTweaks() {
  for (const [id, rec] of loadedMainTweaks) {
    try {
      if (typeof rec.stop === "function") await rec.stop();
    } catch (e) {
      logLine("error", "", `main tweak stop 失败 ${id}: ${(e && e.stack) || e}`);
    }
  }
  loadedMainTweaks.clear();
}

async function reloadAll(reason) {
  logLine("info", "", `重新加载 tweaks (${reason})`);
  await stopMainTweaks();
  startMainTweaks();
  // 通知各渲染进程重载 renderer tweak
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("aimanapp:reload-renderer");
    } catch (_) {}
  }
}

/** ------------------------------------------------ preload 注册 ---- */

function registerPreload(ses) {
  try {
    const existing = ses.getPreloadScripts?.() ?? [];
    if (existing.some((p) => p.id === "aimanapp-preload")) return;
    ses.registerPreloadScript({
      id: "aimanapp-preload",
      type: "frame",
      filePath: PRELOAD_PATH,
    });
    logLine("info", "", `preload 已注册到 session: ${ses.userAgent?.slice(0, 40) ?? "unknown"}`);
  } catch (e) {
    logLine("error", "", `preload 注册失败: ${(e && e.stack) || e}`);
  }
}

/** ------------------------------------------------ IPC ---- */

function setupIpc() {
  const wrap = (name, fn) => {
    ipcMain.handle(name, async (event, ...args) => {
      try {
        return await fn(event, ...args);
      } catch (e) {
        logLine("error", "", `IPC ${name} 失败: ${(e && e.stack) || e}`);
        throw e;
      }
    });
  };

  wrap("aimanapp:list-tweaks", () => {
    const cfg = loadConfig();
    return discoverTweaks().map((t) => ({
      manifest: t.manifest,
      dir: t.dir,
      entry: t.entry,
      entryExists: t.entryExists,
      enabled: isEnabled(cfg, t.manifest.id),
      safeMode: cfg.safeMode,
    }));
  });

  wrap("aimanapp:user-paths", () => ({
    userRoot: USER_ROOT,
    runtimeDir: RUNTIME_DIR,
    tweaksDir: TWEAKS_DIR,
    logDir: LOG_DIR,
    version: readState().version ?? null,
  }));

  wrap("aimanapp:set-enabled", async (_e, id, enabled) => {
    const cfg = loadConfig();
    cfg.enabled[id] = !!enabled;
    saveConfig(cfg);
    await reloadAll("set-enabled");
    return true;
  });

  wrap("aimanapp:reload", async () => {
    await reloadAll("manual");
    return true;
  });

  wrap("aimanapp:safe-mode", async (_e, on) => {
    const cfg = loadConfig();
    cfg.safeMode = !!on;
    saveConfig(cfg);
    await reloadAll("safe-mode");
    return cfg.safeMode;
  });

  wrap("aimanapp:read-tweak-source", (_e, entryPath) => {
    // 只允许读用户 tweaks 目录里的文件（防越界）
    if (typeof entryPath !== "string" || !withinDir(TWEAKS_DIR, entryPath)) {
      throw new Error("非法路径");
    }
    return fs.readFileSync(entryPath, "utf8");
  });

  wrap("aimanapp:tweak-config", () => {
    const cfg = loadConfig();
    return { hotkey: cfg.hotkey, safeMode: cfg.safeMode };
  });

  ipcMain.on("aimanapp:preload-log", (_e, level, message) => {
    logLine(String(level ?? "info"), "renderer", [String(message ?? "")]);
  });

  wrap("aimanapp:open-tweaks-dir", async (_e, dir) => {
    if (typeof dir !== "string" || !withinDir(TWEAKS_DIR, dir)) throw new Error("非法路径");
    const { shell } = require("electron");
    await shell.openPath(dir);
    return true;
  });

  // tweak 的渲染侧 storage / log 走通用通道，id 必须是已知 tweak。
  // 渲染侧 storage.get 是同步 API，用 sendSync + event.returnValue 实现；
  // 同时保留 handle 版本供 invoke 使用。
  const storageOp = (_e, id, op, key, value) => {
    if (!knownTweakId(id)) throw new Error(`未知 tweak: ${id}`);
    const storage = createStorage(id);
    switch (op) {
      case "get":
        return storage.get(key, value);
      case "set":
        storage.set(key, value);
        return true;
      case "delete":
        storage.delete(key);
        return true;
      case "all":
        return storage.all();
      default:
        throw new Error(`未知 storage 操作: ${op}`);
    }
  };
  wrap("aimanapp:storage-op", storageOp);
  ipcMain.on("aimanapp:storage-op", (event, id, op, key, value) => {
    try {
      event.returnValue = storageOp(event, id, op, key, value);
    } catch (e) {
      logLine("error", "", `storage-op 失败: ${(e && e.stack) || e}`);
      event.returnValue = undefined;
    }
  });
}

function knownTweakId(id) {
  return discoverTweaks().some((t) => t.manifest.id === id);
}

/** ------------------------------------------------ bootstrap ---- */

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logLine("info", "", `AIMana++ runtime 启动 (userRoot=${USER_ROOT})`);

  // session-created：任何时刻创建的 session（含 AIMana 自建分区）都追加 preload。
  // 注意：defaultSession 必须等 app ready 才能访问（Electron 41 会抛
  // "Session can only be received when app is ready"），所以统一推迟到 whenReady。
  app.on("session-created", (ses) => {
    try {
      registerPreload(ses);
    } catch (_) {}
  });

  // IPC handler 注册不依赖 app ready
  setupIpc();

  app
    .whenReady()
    .then(() => {
      try {
        registerPreload(session.defaultSession);
        logLine("info", "", "defaultSession preload 已注册");
      } catch (e) {
        logLine("error", "", `defaultSession preload 注册失败: ${(e && e.stack) || e}`);
      }
      startMainTweaks();
      logLine("info", "", "runtime 引导完成，等待 AIMana 原始入口");
    })
    .catch((e) => {
      logLine("error", "", `whenReady 失败: ${(e && e.stack) || e}`);
    });
} catch (e) {
  process.stderr.write(`[aimanapp main] bootstrap FAILED: ${(e && e.stack) || e}\n`);
  logLine("error", "", `runtime 引导失败: ${(e && e.stack) || e}`);
}
