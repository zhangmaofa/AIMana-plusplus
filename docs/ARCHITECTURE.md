# 架构

```
┌──────────────────────────────────────────────────────────────────┐
│  MT AIMana 安装目录 (…\mt-aimana\resources\)                       │
│  ├─ app.asar            ← AIMana++ stub（package.json + loader）   │
│  │    package.json#main = "aimanapp-loader.cjs"  ◄── 唯一"补丁"    │
│  │    __aimanapp: { originalAsar, originalMain, userRoot }         │
│  ├─ aimanapp-loader.cjs ◄── 注入的引导文件（~2KB）                  │
│  ├─ app.orig.asar       ← 原版 asar（原样改名保存，未修改）          │
│  └─ app.orig.asar.unpacked                                          │
└───────────────┬──────────────────────────────────────────────────┘
                │ loader: 先 require runtime，再 require 原入口
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  %LOCALAPPDATA%\.aimana-plusplus\                                  │
│  ├─ runtime\main.cjs      主进程：追加式 preload + main tweak + IPC │
│  ├─ runtime\preload.cjs   渲染进程：加载 renderer tweak + 面板 UI   │
│  ├─ tweaks\<id>\          manifest.json + index.js                 │
│  ├─ tweak-data\<id>\      每插件持久化沙箱                          │
│  ├─ app\                  自托管 CLI（watcher 用）                  │
│  ├─ bin\aimanapp-repair.cmd                                        │
│  ├─ log\  backup\  state.json  config.json                         │
└──────────────────────────────────────────────────────────────────┘
```

## 为什么选 stub-swap 而不是重打包 asar

Codex++（其参考原型）对 Codex 采取"解包 → 改 package.json → 重打包"的方式。AIMana 的 `app.asar` 约 550MB，重打包慢、临时空间开销大，而且任何打包偏差都可能损坏应用。stub-swap 只做文件改名 + 写入一个 2KB 的 stub：

- **快**：安装/修复秒级完成
- **可逆**：原版 asar 原样保存（改名 `app.orig.asar`），卸载即改回
- **零风险**：不重新打包原文件，不存在打包损坏的可能

Electron v41.7.2 的查找顺序（`shell/common/node_bindings.cc`）：

```cpp
const std::vector<std::string> search_paths = {"app.asar", "app", "default_app.asar"};
```

stub 占据 `app.asar` 名字 → 必然被加载。stub 的 loader 通过 Electron 的 asar 透明加载机制 `require("…/app.orig.asar/out/main/index.js")` 把控制权还给原版——跨 asar require 是 Electron 的官方特性（asar 对 `fs`/`Module` 完全透明）。

`app.asar.unpacked` 同步改名为 `app.orig.asar.unpacked`：asar header 里 `unpacked: true` 的文件按 `<同名asar>.unpacked\` 规则映射，改名后映射依然成立。

## 启动时序

1. 用户启动 mt-aimana.exe
2. Electron 解析 stub `app.asar` → 执行 `aimanapp-loader.cjs`
3. loader 读取 `__aimanapp` 元数据，设置环境变量，require `runtime/main.cjs`
4. runtime（此时 AIMana 尚未启动任何窗口）：
   - `session.registerPreloadScript()` 向 defaultSession 注册 preload
   - `app.on("session-created")` 兜底：AIMana 自建的分区 session 也会被注册
   - 注册面板用 IPC handlers
   - `app.whenReady()` 后启动 main 进程 tweak
5. loader require `app.orig.asar` 的原始入口 → AIMana 正常初始化
6. AIMana 创建窗口 → 它自己的 preload 与 AIMana++ preload 同时生效
7. AIMana++ preload：向主进程要 tweak 列表 → 加载 renderer tweak → 注入面板 UI

## 为什么用追加式 preload

`webPreferences.preload` 只有一个名额，覆盖会破坏 AIMana。Electron ≥35 提供 `session.registerPreloadScript({ id, type, filePath })`，可以给一个 session 注册**多个** preload，且与 AIMana 自己的 `webPreferences.preload` 叠加生效。AIMana 使用 Electron 41.7.2，原生支持。

## 为什么面板用独立 DOM 注入而不是改 AIMana 设置页

Codex++ 注入 Codex 的 Radix 设置对话框，依赖 Codex UI 的 DOM 特征（`[role="tablist"]` 等）。AIMana 用 Ant Design 6 + 自有组件，DOM 特征完全不同，而且每个版本都可能变。v0.1 采用自绘面板（固定定位 + 热键/按钮唤起）：

- 不依赖 AIMana UI 结构，官方更新几乎不会弄坏它
- 后续版本可以增加 antd 启发式，把 tweak 页面原生接入 AIMana 设置（见 preload.cjs 中的 `settings-injector` 预留位）

## Update handling

`mt-aimana-updater` 更新 AIMana 时会重写安装目录：

1. 更新器写入新的原版 `app.asar`（我们的 stub 被覆盖或删除）
2. 登录时计划任务执行 `<userRoot>\bin\aimanapp-repair.cmd` → `aimanapp repair --quiet`
3. `repair` 检测到 `app.asar` 不是 stub（或缺失）→ 删除旧 `app.orig.asar`、把新原版改名、重建 stub、刷新 runtime

整个流程幂等，`state.json` 记录安装指纹供 `status`/`doctor` 展示。

## 安全模型

- 补丁面积极小且可审计：stub 里只有 `package.json` 和 `loader.cjs`
- tweak 只从用户目录 `tweaks\` 加载，manifest 必须合法（id/name/version/githubRepo）
- `api.fs`（main）和 storage 通道有目录穿越校验；`read-tweak-source` 只允许读 tweaks 目录内文件
- renderer tweak 的 require 受 sandbox 限制（sandbox:true 时退化为"主进程读源码 + new Function"，无法接触 Node 全量 API）
- permissions 目前是声明式（面板可见、校验器检查），原生权限强制执行留待后续版本
