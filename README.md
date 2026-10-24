# AIMana++

**AIMana++ 让你给 MT AIMana 桌面应用安装本地 tweak（插件）。** tweak 可以修改 UI、在面板里添加页面、运行主进程代码、持久化数据。

> 非官方项目，与 AIMana 作者无关。自用请随意，插件只装信得过的来源。

灵感与设计参考 [codex-plusplus](https://github.com/kpkhxlgy0/codex-plusplus)（MIT），在此致谢。

![AIMana++ 面板](docs/screenshot.png)

*AIMana++ 面板（Ctrl+Alt+U 或右下角 ++ 按钮唤起）：插件开关、插件注册的 UI 区块都在这里。*

## TL;DR

AIMana++ 会修补本机的 AIMana 应用，让它在启动时先加载一个小的 AIMana++ runtime。runtime 不在应用目录里，而在你的用户数据目录中——它从 `tweaks/` 文件夹发现插件并加载。应用内的补丁极小且完全可回滚；你的插件、配置、日志都放在应用外面，改了即生效（面板里点"重载"即可），不用重装任何东西。

AIMana 官方更新后补丁会消失，AIMana++ 会通过登录时计划任务自动重新修补。

## 安装

```sh
git clone https://github.com/zhangmaofa/AIMana-plusplus.git
cd AIMana-plusplus
npm install
node bin/aimanapp.mjs install
```

然后正常启动 MT AIMana：

- 按 **Ctrl+Alt+U**（或点右下角的 **++** 圆钮）打开 AIMana++ 面板
- 面板里可以看到 tweak 列表、开关，以及 tweak 注册的 UI 区块

全局命令（可选）：

```sh
npm link   # 之后直接使用 aimanapp 命令
```

## 工作原理（stub-swap）

Electron 启动时按 `app.asar → app → default_app.asar` 的顺序查找应用。AIMana++ 利用这一点：

```
AIMana 安装目录 (例如 D:\AIMana\mt-aimana\resources\)
├─ app.asar          ← AIMana++ stub（只有 package.json + loader，~2KB）
├─ app.orig.asar     ← 你的原版，一个字节没动，改名保存
└─ app.orig.asar.unpacked

%LOCALAPPDATA%\.aimana-plusplus\        ← 所有 AIMana++ 数据都在这里
├─ runtime\   main.cjs + preload.cjs    ← 注入的运行时
├─ tweaks\    <tweak-id>\manifest.json + index.js
├─ tweak-data\<tweak-id>\storage.json
├─ app\       自托管的 CLI 副本（watcher 用，不依赖仓库位置）
├─ bin\aimanapp-repair.cmd              ← 登录时计划任务调用的修复脚本
├─ log\  state.json  config.json
```

启动流程：

1. Electron 读取 stub `app.asar` 的 `package.json#main` → 执行 `aimanapp-loader.cjs`
2. loader 先 require 用户目录的 `runtime/main.cjs`（在 AIMana 建窗口之前）：
   - 通过 `session.registerPreloadScript()` **追加式**注册 preload（不动 AIMana 自己的 preload）
   - 启动 main 进程 tweak，注册面板用的 IPC
3. loader 再 require `app.orig.asar` 里的原始入口 → **AIMana 照常启动**
4. AIMana 创建窗口时，AIMana++ 的 preload 一并运行 → 发现并加载 renderer tweak、注入面板 UI

补丁是幂等的：`install`/`repair` 重复执行安全；检测到 AIMana 更新（app.asar 变回原版）会自动重新 swap。

## 命令

| 命令 | 作用 |
|---|---|
| `aimanapp install` | 修补 AIMana 并安装 runtime |
| `aimanapp status` | 查看安装状态与 tweak 列表 |
| `aimanapp repair [--quiet]` | 修复补丁（更新后 / 手动） |
| `aimanapp uninstall [--purge]` | 还原原版 app.asar；`--purge` 连 tweaks/配置一起删 |
| `aimanapp safe-mode [on\|off]` | 临时禁用所有 tweak（不删除） |
| `aimanapp doctor` | 环境诊断 |
| `aimanapp new-tweak <目录>` | 创建新 tweak 脚手架 |
| `aimanapp validate-tweak <目录>` | 校验 manifest |
| `aimanapp list-tweaks` | 列出已装 tweak |

## 写一个 tweak

一个 tweak 就是一个文件夹：

```
my-tweak/
  manifest.json
  index.js
```

`manifest.json`：

```json
{
  "id": "com.you.my-tweak",
  "name": "我的插件",
  "version": "0.1.0",
  "githubRepo": "you/my-tweak",
  "description": "一句话说明",
  "scope": "renderer",
  "main": "index.js",
  "permissions": ["settings", "ipc"]
}
```

`index.js`：

```js
module.exports = {
  start(api) {
    const handle = api.settings.register({
      id: "main",
      title: api.manifest.name,
      render(root) {
        const btn = document.createElement("button");
        btn.textContent = "你好，AIMana++";
        btn.addEventListener("click", () => api.storage.set("clicked", true));
        root.appendChild(btn);
      },
    });
    return { async stop() { handle.unregister(); } };
  },
};
```

把目录放进 `%LOCALAPPDATA%\.aimana-plusplus\tweaks\`，重启 AIMana 或在面板点"重载"。完整 API 见 [docs/WRITING-TWEAKS.md](docs/WRITING-TWEAKS.md)。

## API 一览

tweak 的 `start(api)` 收到的 `api`：

| 成员 | 说明 |
|---|---|
| `api.manifest` | 只读 manifest |
| `api.storage` | 每插件持久化 KV：`get/set/delete/all` |
| `api.log` | 写入主日志并在控制台输出：`debug/info/warn/error` |
| `api.process` | `"renderer"` 或 `"main"` |
| `api.settings` | 渲染侧：`register(section)` / `registerPage(page)` 注册进面板 |
| `api.ipc` | 进程间通信：`on/send/invoke`（main 侧另有 `handle`） |
| `api.fs` | main 侧：`dataDir` + `read/write/exists`（沙箱限定在 tweak-data） |
| `api.app` | main 侧：`getVersion/getPath/quit` |
| `api.windows` | main 侧：`list/focus/reloadAll` |
| `api.aiMana` | main 侧：AIMana 版本、用户目录信息 |

`scope: "renderer"` 的 tweak 只在渲染进程加载；`"main"` 只在主进程；`"both"` 两边都加载（用 `api.process` 分支）。

## 更新与恢复

- AIMana 更新后：补丁消失 → 下次登录时计划任务自动 `repair`；也可以手动 `aimanapp repair`
- AIMana++ 异常时：`aimanapp safe-mode on` 一键禁用所有插件，排查后再开
- 完全卸载：`aimanapp uninstall`（还原原版 asar）；`--purge` 连数据一起清

## 安全

AIMana++ 会在你的 AIMana 里运行本地代码。只安装你信任的来源的 tweak：

- tweak 更新检查是"提示式"的——根据 `manifest.githubRepo` 每天至多查一次 GitHub Release，只在面板提示，不会自动下载安装
- `api.fs` 被沙箱限定在 tweak 自己的数据目录内
- 渲染进程 tweak 无法直接 require 任意 npm 包（需要打包成单文件），降低了供应链风险

## 兼容性说明

- 仅 Windows（AIMana 官方桌面版）；需要 AIMana 的 Electron `OnlyLoadAppFromAsar` fuse 处于关闭状态（当前官方版本如此，安装时 `doctor` 会检查）
- AIMana 大版本更新若改变入口结构，`repair` 会自动适配 `package.json#main` 的变化；极端情况（入口机制重构）需要等 AIMana++ 更新

## 文档

- [架构](docs/ARCHITECTURE.md)
- [tweak 开发指南](docs/WRITING-TWEAKS.md)

## License

MIT
