import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLAUDE_BIN = "/home/claude/.local/bin/claude";
const DEFAULT_CWD = "/var/projet-test";

export async function post({ body }) {
  const prompt = String(body?.prompt || "").trim();
  const cwd = String(body?.cwd || DEFAULT_CWD);

  if (!prompt) {
    const err = new Error("prompt required");
    err.statusCode = 400;
    throw err;
  }

  const { stdout, stderr } = await execFileAsync(
    "sudo",
    ["-u", "claude", CLAUDE_BIN, "--print", "-p", prompt],
    {
      cwd,
      env: { ...process.env, HOME: "/home/claude" },
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  return { result: stdout.trim(), warning: stderr.trim() || null };
}
