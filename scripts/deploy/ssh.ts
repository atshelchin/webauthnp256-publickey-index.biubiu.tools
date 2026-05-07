import type { DeployTarget } from "./config.ts";

export interface SshSession {
  readonly target: DeployTarget;
  run(argv: string[], opts?: { sudo?: boolean; stdio?: "inherit" | "piped" | "null" }): Promise<number>;
  runCapture(argv: string[], opts?: { sudo?: boolean }): Promise<{ code: number; stdout: string; stderr: string }>;
  runShell(script: string, opts?: { sudo?: boolean; stdio?: "inherit" | "null" }): Promise<number>;
  runWithStdin(argv: string[], stdin: ReadableStream<Uint8Array>, opts?: { sudo?: boolean }): Promise<number>;
  primeConnection(): Promise<void>;
  close(): Promise<void>;
}

function sh(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

function baseArgs(t: DeployTarget, cp: string): string[] {
  const args = [
    "-o", "ControlMaster=auto", "-o", `ControlPath=${cp}`, "-o", "ControlPersist=60",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15",
    "-o", "ConnectTimeout=10", "-p", String(t.port),
  ];
  if (t.authMethod === "key") {
    if (t.keyPath) { args.push("-i", t.keyPath.replace(/^~/, Deno.env.get("HOME") ?? "~"), "-o", "IdentitiesOnly=yes"); }
    args.push("-o", "PreferredAuthentications=publickey", "-o", "BatchMode=yes");
  } else {
    args.push("-o", "PreferredAuthentications=password,keyboard-interactive");
  }
  return args;
}

function remoteCmd(argv: string[], sudo: boolean): string {
  const q = argv.map((s) => sh(s)).join(" ");
  return sudo ? `sudo -n ${q}` : q;
}

export function createSshSession(target: DeployTarget): SshSession {
  const cp = `/tmp/webauthn-ssh-${target.user}@${target.host}-${Deno.pid}.sock`;
  let primed = false;

  return {
    target,
    async primeConnection() {
      if (primed) return;
      const { code } = await new Deno.Command("ssh", {
        args: [...baseArgs(target, cp), "-N", "-f", `${target.user}@${target.host}`],
        stdin: "inherit", stdout: "inherit", stderr: "inherit",
      }).output();
      if (code !== 0) throw new Error(`SSH failed to ${target.user}@${target.host}:${target.port}`);
      primed = true;
    },
    async run(argv, opts) {
      const { code } = await new Deno.Command("ssh", {
        args: [...baseArgs(target, cp), `${target.user}@${target.host}`, remoteCmd(argv, opts?.sudo ?? false)],
        stdin: opts?.stdio ?? "inherit", stdout: opts?.stdio ?? "inherit", stderr: opts?.stdio ?? "inherit",
      }).output();
      return code;
    },
    async runCapture(argv, opts) {
      const { code, stdout, stderr } = await new Deno.Command("ssh", {
        args: [...baseArgs(target, cp), `${target.user}@${target.host}`, remoteCmd(argv, opts?.sudo ?? false)],
        stdin: "null", stdout: "piped", stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return { code, stdout: d.decode(stdout), stderr: d.decode(stderr) };
    },
    async runShell(script, opts) {
      const cmd = opts?.sudo ? "sudo -n bash -s" : "bash -s";
      const proc = new Deno.Command("ssh", {
        args: [...baseArgs(target, cp), `${target.user}@${target.host}`, cmd],
        stdin: "piped", stdout: opts?.stdio === "null" ? "null" : "inherit", stderr: opts?.stdio === "null" ? "null" : "inherit",
      }).spawn();
      const w = proc.stdin.getWriter();
      try { await w.write(new TextEncoder().encode(script)); } finally { try { await w.close(); } catch { /* */ } }
      return (await proc.status).code;
    },
    async runWithStdin(argv, stdin, opts) {
      const proc = new Deno.Command("ssh", {
        args: [...baseArgs(target, cp), `${target.user}@${target.host}`, remoteCmd(argv, opts?.sudo ?? false)],
        stdin: "piped", stdout: "inherit", stderr: "inherit",
      }).spawn();
      const w = proc.stdin.getWriter();
      const r = stdin.getReader();
      try { while (true) { const { done, value } = await r.read(); if (done) break; await w.write(value); } } finally { try { await w.close(); } catch { /* */ } }
      return (await proc.status).code;
    },
    async close() {
      if (!primed) return;
      try { await new Deno.Command("ssh", { args: ["-o", `ControlPath=${cp}`, "-O", "exit", `${target.user}@${target.host}`], stdin: "null", stdout: "null", stderr: "null" }).output(); } catch { /* */ }
      try { await Deno.remove(cp); } catch { /* */ }
      primed = false;
    },
  };
}
