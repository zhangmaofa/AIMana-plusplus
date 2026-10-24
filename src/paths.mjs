import { existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const EXE_NAME = "mt-aimana.exe";

export const AIANA_TASK_NAME = "AIManaPlusPlus Repair";

/**
 * 定位 MT AIMana 安装目录（返回含 mt-aimana.exe 的目录）。
 * 查找顺序：
 *   1. AIMANA_HOME 环境变量
 *   2. 常见安装位置（含实测的 D:\AIMana\mt-aimana）
 *   3. 注册表卸载信息（HKLM/HKCU，DisplayName 匹配 MT AIMana）
 *   4. 开始菜单快捷方式解析
 */
export function discoverAIMana() {
  const candidates = [];

  if (process.env.AIMANA_HOME) candidates.push(process.env.AIMANA_HOME);

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  candidates.push(
    join(localAppData, "Programs", "mt-aimana"),
    join(appData, "Programs", "mt-aimana"),
    "D:\\AIMana\\mt-aimana",
    "D:\\Program Files\\mt-aimana",
    "C:\\Program Files\\mt-aimana",
    "C:\\Program Files (x86)\\mt-aimana",
  );

  for (const dir of candidates) {
    if (existsSync(join(dir, EXE_NAME))) return { dir, source: "path" };
  }

  // 注册表卸载项
  const regDir = findFromRegistry();
  if (regDir) return { dir: regDir, source: "registry" };

  // 开始菜单 .lnk 解析
  const lnkDir = findFromStartMenu();
  if (lnkDir) return { dir: lnkDir, source: "start-menu" };

  return null;
}

function findFromRegistry() {
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const key of keys) {
    try {
      const out = execFileSync("reg", ["query", key, "/s", "/f", "MT AIMana", "/d"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      // 从查询结果里找 InstallLocation 或 UninstallString 推断目录
      const lines = out.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
        if (m) {
          const dir = m[1].trim();
          if (existsSync(join(dir, EXE_NAME))) return dir;
        }
      }
      for (const line of lines) {
        const m = line.match(/UninstallString\s+REG_SZ\s+(.+)/i);
        if (m) {
          // "D:\AIMana\mt-aimana\Uninstall mt-aimana.exe" 之类
          const raw = m[1].trim().replace(/^"|"$/g, "");
          const dir = dirname(raw.replace(/Uninstall[^\\"\s]*\.exe$/i, ""));
          if (existsSync(join(dir, EXE_NAME))) return dir;
        }
      }
    } catch {
      // reg query 没命中时返回非零，忽略
    }
  }
  return null;
}

function findFromStartMenu() {
  const roots = [
    join(process.env.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const out = execFileSync("where", ["/R", root, "MT AIMana.lnk"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      const lnk = out.split(/\r?\n/).find(Boolean);
      if (!lnk) continue;
      const ps =
        `$sh = New-Object -ComObject WScript.Shell; ` +
        `$lnk = $sh.CreateShortcut('${lnk.trim().replace(/'/g, "''")}'); ` +
        `$lnk.TargetPath`;
      const target = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", ps],
        { encoding: "utf8", windowsHide: true, timeout: 20000 },
      ).trim();
      if (basename(target).toLowerCase() === EXE_NAME && existsSync(target)) {
        return dirname(target);
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

/** AIMana++ 自己的用户数据根目录（runtime/tweaks/日志都放这里，不进应用目录）。 */
export function userRoot() {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return process.env.AIMANAPP_HOME ?? join(localAppData, ".aimana-plusplus");
}

export function runtimeDir() {
  return join(userRoot(), "runtime");
}

export function tweaksDir() {
  return join(userRoot(), "tweaks");
}

export function logDir() {
  return join(userRoot(), "log");
}

export function backupDir() {
  return join(userRoot(), "backup");
}

export function stateFile() {
  return join(userRoot(), "state.json");
}

export function configFile() {
  return join(userRoot(), "config.json");
}

export function stagedAppDir() {
  return join(userRoot(), "app");
}
