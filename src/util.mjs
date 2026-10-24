import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  return file;
}

export function sha256File(file) {
  const buf = readFileSync(file);
  return createHash("sha256").update(buf).digest("hex");
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** 追加写日志文件，超过上限时截断保留尾部（与 Codex++ loader 同款策略）。 */
export function appendCappedLog(file, line) {
  try {
    const incoming = Buffer.from(line, "utf8");
    if (incoming.byteLength >= MAX_LOG_BYTES) {
      writeFileSync(file, incoming.subarray(incoming.byteLength - MAX_LOG_BYTES));
      return;
    }
    let existing = Buffer.alloc(0);
    if (existsSync(file)) existing = readFileSync(file);
    const allowed = MAX_LOG_BYTES - incoming.byteLength;
    if (existing.byteLength > allowed) {
      existing = existing.subarray(existing.byteLength - allowed);
    }
    const out = Buffer.concat([existing, incoming]);
    ensureDir(dirname(file));
    writeFileSync(file, out);
  } catch {
    // 日志失败不影响主流程
  }
}

export function timestamp() {
  return new Date().toISOString();
}

/** 检测某个进程映像名是否正在运行（仅 Windows）。 */
export function isProcessRunning(imageName) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

export function info(msg) {
  console.log(msg);
}

export function ok(msg) {
  console.log(`  ✔ ${msg}`);
}

export function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

export function fail(msg) {
  console.error(`  ✖ ${msg}`);
}

/** 极简 semver 比较：返回 a > b ? 1 : a < b ? -1 : 0。非法输入按 0 处理。 */
export function semverCompare(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/^v/i, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}
