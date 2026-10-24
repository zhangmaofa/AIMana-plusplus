# AIMana++ tweak 开发指南

## 快速开始

```sh
aimanapp new-tweak ./my-tweak --id com.you.my-tweak --name "我的插件"
aimanapp validate-tweak ./my-tweak
# 把 my-tweak 目录复制到 %LOCALAPPDATA%\.aimana-plusplus\tweaks\
# 启动 AIMana → Ctrl+Alt+U 打开面板 → 看到你的插件 → 点"重载"迭代
```

开发循环：改 `index.js` → 面板点"重载"（或重启 AIMana）→ 看效果。main 进程 tweak 的日志在 `%LOCALAPPDATA%\.aimana-plusplus\log\main.log`。

## manifest.json

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✔ | 全局唯一 id，`com.you.my-tweak` 风格（字母数字._-） |
| `name` | ✔ | 显示名 |
| `version` | ✔ | semver |
| `githubRepo` | ✔ | `owner/repo`，用于提示式更新检查 |
| `description` | | 一句话说明 |
| `author` | | 字符串或 `{name, url?, email?}` |
| `homepage` | | 主页链接 |
| `iconUrl` | | 面板显示用图标（暂未渲染，预留） |
| `tags` | | 字符串数组 |
| `scope` | | `"renderer"` / `"main"` / `"both"`（默认 both） |
| `main` | | 入口文件，默认 `index.js`（`.cjs`/`.mjs` 也可） |
| `mcp` | | `{command, args?, env?}` —— 预留，v0.1 未实现同步 |
| `permissions` | | 权限声明：`settings` `ipc` `filesystem` `network` `windows` `model` |

## Tweak 契约

```js
module.exports = {
  start(api) {
    // 必需。加载时调用。可以返回 { stop } 或Promise
  },
  stop() {
    // 可选。禁用/重载/退出时调用
  },
};
```

## API

### 通用

| API | 说明 |
|---|---|
| `api.manifest` | 只读 manifest |
| `api.process` | `"renderer"` 或 `"main"`，`both` scope 的插件用它分支 |
| `api.storage.get(key, fallback?)` | 读持久化 KV |
| `api.storage.set(key, value)` | 写持久化 KV |
| `api.storage.delete(key)` / `api.storage.all()` | 删除 / 全量 |
| `api.log.debug/info/warn/error(...)` | 写主日志 + 控制台 |

### renderer 专属

| API | 说明 |
|---|---|
| `api.settings.register({id,title,description?,render})` | 在面板注册一个区块。`render(root)` 往 root 里挂 DOM，可返回清理函数。返回 `{unregister()}` |
| `api.settings.registerPage(page)` | v0.1 中与 register 等效（预留：未来原生接入 AIMana 设置页） |
| `api.ipc.on/send/invoke` | 与 main 通信，通道自动限定在本 tweak 命名空间 |

### main 专属

| API | 说明 |
|---|---|
| `api.ipc.handle(channel, handler)` | 响应 renderer 的 invoke |
| `api.ipc.send(channel, ...)` | 广播到所有窗口 |
| `api.fs.dataDir` / `read` / `write` / `exists` | 沙箱文件系统（限定在 `tweak-data\<id>\`，防穿越） |
| `api.app.getVersion/getPath/quit` | Electron app 常用操作 |
| `api.windows.list/focus/reloadAll` | 窗口枚举与控制 |
| `api.aiMana.version` | 当前 AIMana 版本 |

## 模式与示例

### UI 增强型（renderer）

在面板注册区块，往 AIMana 页面注入按钮/快捷键。示例见 `tweaks/hello-world`。

### 后台服务型（main）

长驻任务、文件监听、与 AIMana 主进程集成：

```js
// manifest: { "scope": "main", ... }
const { setInterval } = require("node:timers");
module.exports = {
  start(api) {
    const timer = setInterval(() => api.log.info("tick"), 60_000);
    return { stop() { clearInterval(timer); } };
  },
};
```

### 双进程型（both）

renderer 收集输入 → `api.ipc.invoke` → main `api.ipc.handle` 干活（写文件/发请求）→ 结果回渲染。

## 打包依赖

renderer tweak 目前以单文件加载（sandbox 兜底路径不支持多文件 require）。需要 npm 依赖时用 esbuild 打成一个文件：

```sh
npx esbuild index.js --bundle --format=cjs --outfile=dist/index.js
# manifest.main 指向 dist/index.js
```

main tweak 运行在完整 Node 环境，可以直接 require 用户目录 `runtime\node_modules\` 下的包，也可以单文件打包后由 manifest.main 指定。

## 调试

- 渲染进程：面板里能看到 tweak 列表和日志条目；也可以给 AIMana 开 `--remote-debugging-port=9222` 后用 Chrome DevTools 连接
- 主进程：看 `%LOCALAPPDATA%\.aimana-plusplus\log\main.log`
- loader 问题：看 `log\loader.log`
- 出问题先 `aimanapp safe-mode on` 排除 tweak 因素

## 发布

manifest 的 `githubRepo` 指向你的仓库。AIMana++ 每天至多查一次该仓库的最新 Release，发现新版本只在面板提示（不自动下载）。用户手动更新文件。
