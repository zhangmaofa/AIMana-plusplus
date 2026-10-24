/* eslint-disable */
/**
 * AIMana++ runtime —— 渲染进程部分（追加式 preload）。
 *
 * AIMana 自己的 preload 照常运行；本文件在其之上工作：
 *   1. 向主进程要 tweak 列表，加载 renderer scope 的 tweak。
 *   2. 内置一个轻量"AIMana++ 面板"（DOM 注入 + Ctrl+Alt+U / 右下角按钮唤起），
 *      tweak 通过 api.settings.register()/registerPage() 把 UI 注册进面板。
 *      （AIMana 自身设置页的原生集成留待后续版本，面板方案不依赖 AIMana UI 结构。）
 *   3. sandbox:false 时直接 require tweak 文件；sandbox:true 时回退到
 *      IPC 取源码 + new Function 执行（需要 tweak 单文件打包）。
 */

"use strict";

(function () {
  if (window.__aimanappPreloadLoaded) return;
  window.__aimanappPreloadLoaded = true;

  const { ipcRenderer, contextBridge } = require("electron");
  const loaded = new Map(); // id -> { stop?() }
  const sections = new Map(); // key -> section
  let panelHost = null;
  let hotkey = "Ctrl+Alt+U";

  function slog(level, message) {
    try {
      console[level === "error" ? "error" : "info"](`[aimanapp] ${message}`);
      ipcRenderer.send("aimanapp:preload-log", level, String(message));
    } catch (_) {}
  }

  /** ------------------------------------------------ tweak API ---- */

  function makeApi(tweak, paths) {
    const id = tweak.manifest.id;
    const channel = `aimanapp:t:${id}`;
    const storage = {
      get(key, fallback) {
        return ipcRenderer.sendSync("aimanapp:storage-op", id, "get", key, fallback);
      },
      set(key, value) {
        ipcRenderer.send("aimanapp:storage-op", id, "set", key, value);
      },
      delete(key) {
        ipcRenderer.send("aimanapp:storage-op", id, "delete", key);
      },
      all() {
        return ipcRenderer.sendSync("aimanapp:storage-op", id, "all", null, null);
      },
    };
    return {
      manifest: Object.freeze({ ...tweak.manifest }),
      storage,
      log: {
        debug: (...a) => slog("debug", `${id}: ${a.join(" ")}`),
        info: (...a) => slog("info", `${id}: ${a.join(" ")}`),
        warn: (...a) => slog("warn", `${id}: ${a.join(" ")}`),
        error: (...a) => slog("error", `${id}: ${a.join(" ")}`),
      },
      process: "renderer",
      settings: {
        register(section) {
          const key = `${id}:${section.id}`;
          sections.set(key, { tweakId: id, ...section });
          renderSections();
          return {
            unregister() {
              sections.delete(key);
              renderSections();
            },
          };
        },
        registerPage(page) {
          // v0.1 中 page 与 section 同等呈现（面板内一个块）；后续版本接入 AIMana 设置页
          return this.register({ ...page, kind: "page" });
        },
      },
      ipc: {
        on(ch, handler) {
          const wrapped = (_e, ...args) => handler(...args);
          ipcRenderer.on(`${channel}:${ch}`, wrapped);
          return () => ipcRenderer.removeListener(`${channel}:${ch}`, wrapped);
        },
        send(ch, ...args) {
          ipcRenderer.send(`${channel}:${ch}`, ...args);
        },
        invoke(ch, ...args) {
          return ipcRenderer.invoke(`${channel}:${ch}`, ...args);
        },
      },
      fs: {
        dataDir: paths ? paths.userRoot + "\\tweak-data\\" + id : null,
        async read(rel) {
          throw new Error("renderer tweak 请用 api.ipc 让 main 进程读写文件");
        },
      },
    };
  }

  function runTweakSource(source, api) {
    // CommonJS 形状的最小执行环境
    const module_ = { exports: {} };
    const fn = new Function("require", "module", "exports", source + "\n//# sourceURL=aimanapp-tweak.js");
    fn(miniRequire, module_, module_.exports);
    return module_.exports;
  }

  function miniRequire(name) {
    if (name === "electron") return { ipcRenderer, contextBridge };
    throw new Error(`renderer tweak 无法直接 require('${name}')，请把依赖打包进 tweak 文件`);
  }

  async function loadRendererTweaks() {
    const tweaks = await ipcRenderer.invoke("aimanapp:list-tweaks");
    const paths = await ipcRenderer.invoke("aimanapp:user-paths");
    try {
      const cfg = await ipcRenderer.invoke("aimanapp:tweak-config");
      if (cfg?.hotkey) hotkey = cfg.hotkey;
    } catch (_) {}

    setListedTweaks(tweaks, paths);

    let count = 0;
    for (const t of tweaks) {
      if ((t.manifest.scope || "both") === "main") continue;
      if (!t.entryExists || !t.enabled) continue;
      try {
        let mod = null;
        try {
          // sandbox:false：preload 里 require 是完整 Node require
          delete require.cache[require.resolve(t.entry)];
          mod = require(t.entry);
        } catch (requireError) {
          // sandbox:true 兜底：主进程读源码 + new Function
          const source = await ipcRenderer.invoke("aimanapp:read-tweak-source", t.entry);
          mod = runTweakSource(source, null);
        }
        const api = makeApi(t, paths);
        if (typeof mod?.start === "function") await mod.start(api);
        loaded.set(t.manifest.id, {
          stop: typeof mod?.stop === "function" ? mod.stop : null,
          api,
        });
        count++;
      } catch (e) {
        slog("error", `tweak 加载失败 ${t.manifest?.id}: ${(e && e.stack) || e}`);
      }
    }
    slog("info", `renderer 共加载 ${count} 个 tweak`);
  }

  async function stopRendererTweaks() {
    for (const [id, rec] of loaded) {
      try {
        if (typeof rec.stop === "function") await rec.stop();
      } catch (e) {
        slog("error", `tweak stop 失败 ${id}: ${e}`);
      }
    }
    loaded.clear();
    for (const key of [...sections.keys()]) {
      if (!sections.get(key).tweakId) sections.delete(key);
      else sections.delete(key);
    }
    renderSections();
  }

  ipcRenderer.on("aimanapp:reload-renderer", async () => {
    try {
      await stopRendererTweaks();
      await loadRendererTweaks();
    } catch (e) {
      slog("error", `reload 失败: ${e}`);
    }
  });

  /** ------------------------------------------------ 面板 UI ---- */

  const CSS = `
#aimanapp-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:34px;height:34px;
border-radius:50%;background:#18181c;color:#7ee2a8;border:1px solid #2e2e36;box-shadow:0 4px 14px rgba(0,0,0,.35);
font:600 11px/34px ui-monospace,Consolas,monospace;text-align:center;cursor:pointer;user-select:none;opacity:.55;
transition:opacity .15s, transform .15s}
#aimanapp-launcher:hover{opacity:1;transform:scale(1.06)}
#aimanapp-panel{position:fixed;right:14px;bottom:56px;z-index:2147483000;width:360px;max-height:70vh;
background:#141418;color:#e6e6ea;border:1px solid #2e2e36;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5);
font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;display:none;flex-direction:column;overflow:hidden}
#aimanapp-panel.open{display:flex}
#aimanapp-panel .aah-head{padding:10px 14px;border-bottom:1px solid #26262c;display:flex;align-items:center;gap:8px}
#aimanapp-panel .aah-title{font-weight:700;letter-spacing:.4px}
#aimanapp-panel .aah-title span{color:#7ee2a8}
#aimanapp-panel .aah-actions{margin-left:auto;display:flex;gap:6px}
#aimanapp-panel .aah-actions button{background:#1f1f26;color:#cfcfd6;border:1px solid #33333c;border-radius:6px;
padding:2px 10px;cursor:pointer;font-size:12px}
#aimanapp-panel .aah-actions button:hover{background:#2a2a33}
#aimanapp-panel .aah-body{overflow-y:auto;padding:6px 0 10px}
.aah-tweak{padding:8px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px dashed #222228}
.aah-tweak .aah-name{font-weight:600}
.aah-tweak .aah-ver{color:#8b8b95;font-size:11px}
.aah-tweak .aah-desc{color:#9a9aa4;font-size:11px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aah-tweak input[type=checkbox]{accent-color:#7ee2a8}
.aah-section{padding:10px 14px;border-bottom:1px solid #222228}
.aah-section h4{margin:0 0 6px;font-size:12px;color:#7ee2a8}
.aah-section p{margin:0 0 6px;font-size:11px;color:#9a9aa4}
.aah-empty{padding:18px 14px;color:#8b8b95;font-size:12px;text-align:center}
.aah-toggle{color:#7ee2a8;background:none;border:none;cursor:pointer;font-size:11px;padding:0}
`;

  let listedTweaks = [];
  let listedPaths = null;

  function setListedTweaks(tweaks, paths) {
    listedTweaks = tweaks;
    listedPaths = paths;
    renderTweakList();
  }

  function ensurePanel() {
    if (panelHost && document.contains(panelHost)) return panelHost;
    const style = document.createElement("style");
    style.id = "aimanapp-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "aimanapp-panel";
    panel.innerHTML = `
      <div class="aah-head">
        <div class="aah-title">AIMana<span>++</span></div>
        <div class="aah-actions">
          <button data-act="reload" title="重载所有 tweak">重载</button>
          <button data-act="open-dir" title="打开 tweaks 目录">目录</button>
          <button data-act="close">✕</button>
        </div>
      </div>
      <div class="aah-body">
        <div class="aah-tweaks"></div>
        <div class="aah-sections"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const launcher = document.createElement("div");
    launcher.id = "aimanapp-launcher";
    launcher.textContent = "++";
    launcher.title = `AIMana++ 面板 (${hotkey})`;
    launcher.addEventListener("click", () => togglePanel());
    document.body.appendChild(launcher);

    panel.querySelector('[data-act="close"]').addEventListener("click", () => togglePanel(false));
    panel.querySelector('[data-act="reload"]').addEventListener("click", async () => {
      await ipcRenderer.invoke("aimanapp:reload");
    });
    panel.querySelector('[data-act="open-dir"]').addEventListener("click", () => {
      if (listedPaths?.tweaksDir) ipcRenderer.invoke("aimanapp:open-tweaks-dir", listedPaths.tweaksDir).catch(() => {});
    });

    document.addEventListener("keydown", (e) => {
      const parts = hotkey.split("+").map((s) => s.trim().toLowerCase());
      const wantCtrl = parts.includes("ctrl");
      const wantAlt = parts.includes("alt");
      const key = parts[parts.length - 1];
      if (
        e.ctrlKey === wantCtrl &&
        e.altKey === wantAlt &&
        e.key.toLowerCase() === key
      ) {
        e.preventDefault();
        togglePanel();
      }
    });

    panelHost = panel;
    renderTweakList();
    renderSections();
    return panel;
  }

  function togglePanel(force) {
    const panel = ensurePanel();
    const open = force !== undefined ? force : !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    if (open) {
      renderTweakList();
      renderSections();
    }
  }

  function renderTweakList() {
    const panel = panelHost;
    if (!panel) return;
    const box = panel.querySelector(".aah-tweaks");
    if (!box) return;
    box.innerHTML = "";
    if (!listedTweaks.length) {
      box.innerHTML = `<div class="aah-empty">尚未安装任何 tweak。<br>运行 <code>aimanapp new-tweak</code> 创建第一个。</div>`;
      return;
    }
    for (const t of listedTweaks) {
      const row = document.createElement("div");
      row.className = "aah-tweak";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!t.enabled && !t.safeMode;
      cb.disabled = !!t.safeMode;
      cb.title = t.safeMode ? "safe-mode 开启中" : "启用 / 禁用";
      cb.addEventListener("change", async () => {
        await ipcRenderer.invoke("aimanapp:set-enabled", t.manifest.id, cb.checked);
      });
      const name = document.createElement("span");
      name.className = "aah-name";
      name.textContent = t.manifest.name;
      const ver = document.createElement("span");
      ver.className = "aah-ver";
      ver.textContent = `v${t.manifest.version}`;
      const desc = document.createElement("span");
      desc.className = "aah-desc";
      desc.textContent = t.manifest.description ?? "";
      row.append(cb, name, ver, desc);
      box.appendChild(row);
    }
  }

  function renderSections() {
    const panel = panelHost;
    if (!panel || !document.contains(panel)) return;
    const box = panel.querySelector(".aah-sections");
    if (!box) return;
    // 先执行上一轮的 teardown
    const prev = box.__aimanappTeardowns;
    if (Array.isArray(prev)) {
      for (const fn of prev) {
        try {
          fn();
        } catch (_) {}
      }
    }
    box.innerHTML = "";
    const teardowns = [];
    if (!sections.size) {
      box.innerHTML = `<div class="aah-empty">没有已注册的区块</div>`;
      return;
    }
    for (const sec of sections.values()) {
      const wrapEl = document.createElement("div");
      wrapEl.className = "aah-section";
      const h = document.createElement("h4");
      h.textContent = sec.title ?? sec.id;
      const p = document.createElement("p");
      p.textContent = sec.description ?? "";
      const body = document.createElement("div");
      wrapEl.append(h, p, body);
      try {
        const teardown = sec.render?.(body);
        if (typeof teardown === "function") teardowns.push(teardown);
      } catch (e) {
        body.textContent = `渲染失败: ${e}`;
      }
      box.appendChild(wrapEl);
    }
    // teardowns 由下一次 renderSections 前统一调用（保存在 box 上）
    box.__aimanappTeardowns = teardowns;
  }

  function initPanelWhenReady() {
    const init = () => {
      try {
        ensurePanel();
      } catch (e) {
        slog("error", `面板初始化失败: ${(e && e.stack) || e}`);
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
  }

  /** ------------------------------------------------ bootstrap ---- */

  loadRendererTweaks().catch((e) => slog("error", `初始化失败: ${(e && e.stack) || e}`));
  initPanelWhenReady();

  try {
    contextBridge.exposeInMainWorld("__aimanapp", {
      version: "0.1.0",
      togglePanel: () => togglePanel(),
      listTweaks: () => listedTweaks,
      reload: () => ipcRenderer.invoke("aimanapp:reload"),
    });
  } catch (_) {}

  slog("info", "preload 已就绪");
})();
