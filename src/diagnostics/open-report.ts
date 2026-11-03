import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const execute = promisify(execFile);

export async function openDiagnosticDemo(output: string): Promise<boolean> {
  if (!process.stdout.isTTY || !process.stdin.isTTY || process.env.CI) return false;
  const url = pathToFileURL(output).href;
  try {
    if (process.platform === "win32") await execute("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, timeout: 3000 });
    else if (process.platform === "darwin") await execute("open", [url], { timeout: 3000 });
    else if (process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) await execute("xdg-open", [url], { timeout: 3000 });
    else return false;
    return true;
  } catch { return false; }
}
