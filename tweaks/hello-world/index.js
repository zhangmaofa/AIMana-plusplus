/**
 * Hello World —— AIMana++ 官方示例 tweak。
 *
 * 演示四件事：
 *   1. api.settings.register()  在 AIMana++ 面板里注册一个区块
 *   2. api.storage              持久化 KV（重启后仍在）
 *   3. api.ipc                  renderer ↔ main 双向通信
 *   4. api.log                  输出到 <用户目录>/log/main.log
 *
 * scope 为 renderer：只运行在渲染进程。要写 main 进程 tweak，
 * 把 manifest.json 的 scope 改成 "main" 或 "both"。
 */

let disposeIpc = null;

module.exports = {
  async start(api) {
    const greeted = api.storage.get("greetedCount", 0);
    api.log.info(`hello-world 启动，历史问候次数: ${greeted}`);

    // main 进程回声：演示 renderer → main IPC
    // （main 侧需要对应的 tweak，这里用 AIMana++ 内置回声通道演示 invoke）
    const handle = api.settings.register({
      id: "main",
      title: "Hello World",
      description: "第一个 AIMana++ 插件 —— 在这里和 AIMana++ 打个招呼。",
      render(root) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap";

        const btn = document.createElement("button");
        btn.textContent = "跟我打个招呼";
        btn.style.cssText =
          "background:#234d34;color:#7ee2a8;border:1px solid #2e6b45;border-radius:6px;" +
          "padding:5px 14px;cursor:pointer;font-size:12px";

        const counter = document.createElement("span");
        counter.style.cssText = "color:#9a9aa4;font-size:12px";
        const total = api.storage.get("greetedCount", 0);
        counter.textContent = `历史问候: ${total} 次`;

        btn.addEventListener("click", () => {
          const n = api.storage.get("greetedCount", 0) + 1;
          api.storage.set("greetedCount", n);
          counter.textContent = `历史问候: ${n} 次`;
          api.log.info(`问候 #${n}`);
          // 通过 IPC 通知 main 进程（会写进 main.log）
          api.ipc.send("hello", `问候 #${n}`);
        });

        wrap.append(btn, counter);
        root.appendChild(wrap);
      },
    });

    // main 进程 tweak 若监听了同名通道可以收到；这里也注册一个自己的监听示例
    disposeIpc = api.ipc.on("echo", (msg) => {
      api.log.info(`收到回声: ${msg}`);
    });

    return {
      async stop() {
        handle.unregister();
        if (disposeIpc) disposeIpc();
      },
    };
  },
};
