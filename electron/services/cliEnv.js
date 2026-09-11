const path = require("path");
const { spawnSync } = require("child_process");

function getPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
}

function expandWindowsEnv(value, env) {
  return String(value || "").replace(/%([^%]+)%/g, (_match, name) => env[name] || env[name.toUpperCase()] || env[name.toLowerCase()] || "");
}

function readRegistryPath(root, keyPath) {
  const result = spawnSync("reg", ["query", `${root}\\${keyPath}`, "/v", "Path"], {
    windowsHide: true,
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  const output = result.stdout || "";
  const match = output.match(/\sPath\s+REG_\w+\s+(.+)/i);
  return match ? match[1].trim() : "";
}

function buildCliEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const pathKey = getPathKey(env);
  const pathParts = String(env[pathKey] || "")
    .split(path.delimiter)
    .filter(Boolean);

  [
    readRegistryPath("HKCU", "Environment"),
    readRegistryPath("HKLM", "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    env.APPDATA ? path.join(env.APPDATA, "npm") : "",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Antigravity", "bin") : "",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "agy", "bin") : ""
  ].forEach((entry) => {
    String(entry || "")
      .split(path.delimiter)
      .map((item) => expandWindowsEnv(item.trim(), env))
      .filter(Boolean)
      .forEach((item) => pathParts.push(item));
  });

  const seen = new Set();
  env[pathKey] = pathParts
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join(path.delimiter);
  return env;
}

module.exports = {
  buildCliEnv
};
