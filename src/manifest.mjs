/**
 * tweak manifest 校验（移植自 Codex++ SDK 的 validateTweakManifest，按 AIMana++ 调整）。
 * 必填：id / name / version / githubRepo；可选：description、author、homepage、
 * iconUrl、tags、scope、main、mcp、permissions。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const VALID_SCOPES = ["renderer", "main", "both"];

export const VALID_PERMISSIONS = [
  "settings",
  "ipc",
  "filesystem",
  "network",
  "windows",
  "model",
];

const ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateTweakManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!isRecord(manifest)) {
    return { ok: false, errors: [{ path: "$", message: "manifest 必须是 JSON 对象" }], warnings };
  }

  for (const key of ["id", "name", "version", "githubRepo"]) {
    if (typeof manifest[key] !== "string" || manifest[key] === "") {
      errors.push({ path: key, message: `${key} 是必填的非空字符串` });
    }
  }

  if (typeof manifest.id === "string" && !/^[a-zA-Z0-9._-]+$/.test(manifest.id)) {
    errors.push({
      path: "id",
      message: "id 只能包含字母、数字、点、下划线和短横线",
    });
  }

  if (
    typeof manifest.version === "string" &&
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)
  ) {
    warnings.push({ path: "version", message: "version 建议使用 semver 格式，例如 0.1.0" });
  }

  if (
    typeof manifest.githubRepo === "string" &&
    !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(manifest.githubRepo)
  ) {
    errors.push({ path: "githubRepo", message: "githubRepo 必须是 owner/repo 形式" });
  }

  if (
    manifest.scope !== undefined &&
    !VALID_SCOPES.includes(manifest.scope)
  ) {
    errors.push({ path: "scope", message: "scope 必须是 renderer、main 或 both" });
  }

  for (const key of ["description", "homepage", "iconUrl", "main", "minRuntime"]) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      errors.push({ path: key, message: `${key} 必须是字符串` });
    }
  }

  if (manifest.author !== undefined) {
    if (typeof manifest.author !== "string" && !isRecord(manifest.author)) {
      errors.push({ path: "author", message: "author 必须是字符串或对象" });
    } else if (isRecord(manifest.author)) {
      if (typeof manifest.author.name !== "string") {
        errors.push({ path: "author.name", message: "author.name 必须是字符串" });
      }
    }
  }

  if (manifest.tags !== undefined) {
    if (!Array.isArray(manifest.tags) || !manifest.tags.every((t) => typeof t === "string")) {
      errors.push({ path: "tags", message: "tags 必须是字符串数组" });
    }
  }

  if (manifest.permissions !== undefined) {
    if (
      !Array.isArray(manifest.permissions) ||
      !manifest.permissions.every((p) => VALID_PERMISSIONS.includes(p))
    ) {
      errors.push({
        path: "permissions",
        message: `permissions 必须是已知权限：${VALID_PERMISSIONS.join(", ")}`,
      });
    }
  }

  if (manifest.mcp !== undefined) {
    if (!isRecord(manifest.mcp)) {
      errors.push({ path: "mcp", message: "mcp 必须是对象" });
    } else {
      if (typeof manifest.mcp.command !== "string" || manifest.mcp.command === "") {
        errors.push({ path: "mcp.command", message: "mcp.command 是必填的非空字符串" });
      }
      if (
        manifest.mcp.args !== undefined &&
        (!Array.isArray(manifest.mcp.args) || !manifest.mcp.args.every((a) => typeof a === "string"))
      ) {
        errors.push({ path: "mcp.args", message: "mcp.args 必须是字符串数组" });
      }
      if (manifest.mcp.env !== undefined) {
        if (!isRecord(manifest.mcp.env)) {
          errors.push({ path: "mcp.env", message: "mcp.env 必须是字符串到字符串的对象" });
        } else {
          for (const [k, v] of Object.entries(manifest.mcp.env)) {
            if (typeof v !== "string") {
              errors.push({ path: `mcp.env.${k}`, message: "mcp.env 的值必须是字符串" });
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 在 tweak 目录里解析入口文件：main 优先，其次 index.js/.cjs/.mjs。 */
export function resolveEntry(dir, manifest, existsFn) {
  const exists = existsFn ?? ((p) => existsSync(p));
  if (manifest.main) {
    const p = join(dir, manifest.main);
    return exists(p) ? p : null;
  }
  for (const c of ENTRY_CANDIDATES) {
    const p = join(dir, c);
    if (exists(p)) return p;
  }
  return null;
}
