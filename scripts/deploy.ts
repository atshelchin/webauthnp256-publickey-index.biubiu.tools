#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=ssh,tar --allow-env=HOME,USER,XDG_CONFIG_HOME,TERM,NO_COLOR --allow-net
/**
 * Deploy script for webauthnp256-publickey-index.
 *
 * Usage:
 *   deno task deploy              # interactive: pick target, upload, activate
 *   deno task deploy rollback     # swap symlink to previous release
 *   deno task deploy status       # check remote status
 */
import {
  type DeployConfig,
  type DeployTarget,
  describeTarget,
  loadDeployConfig,
  saveDeployConfig,
  upsertTarget,
} from "./deploy/config.ts";
import { createSshSession } from "./deploy/ssh.ts";
import {
  ensureCloudflaredInstalled,
  ensureLoggedIn,
  setupTunnel,
} from "./deploy/tunnel.ts";
import {
  CURRENT_LINK,
  DATA_DIR,
  ensureDirectories,
  ensureServiceUser,
  installDeno,
  installSudoers,
  probeRemote,
  RELEASES_DIR,
  releaseTag,
  swapSymlink,
  uploadRelease,
} from "./deploy/remote.ts";

const SYSTEMD_UNIT = "webauthnp256-publickey-index.service";
const HTTP_PORT = 11256;

// ── Prompts ──

async function prompt(msg: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  const buf = new Uint8Array(1024);
  await Deno.stdout.write(new TextEncoder().encode(`${msg}${suffix}: `));
  const n = await Deno.stdin.read(buf);
  const input = new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim();
  return input || defaultVal || "";
}

async function choose(msg: string, options: string[]): Promise<number> {
  console.log(`\n${msg}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  const ans = await prompt("Choice", "1");
  return Math.max(0, Math.min(options.length - 1, parseInt(ans) - 1));
}

// ── Main ──

async function main() {
  const subcommand = Deno.args[0] ?? "deploy";
  const cfg = await loadDeployConfig();

  if (subcommand === "deploy") {
    await runDeploy(cfg);
  } else if (subcommand === "status") {
    await runStatus(cfg);
  } else if (subcommand === "rollback") {
    await runRollback(cfg);
  } else {
    console.log("Usage: deno task deploy [deploy|status|rollback]");
  }
}

async function pickTarget(cfg: DeployConfig): Promise<{ target: DeployTarget; cfg: DeployConfig }> {
  let target: DeployTarget;

  if (cfg.targets.length > 0) {
    const options = [...cfg.targets.map(describeTarget), "+ Add new target"];
    if (cfg.lastTarget) {
      const last = cfg.targets.find((t) => t.name === cfg.lastTarget);
      if (last) options.unshift(`Last: ${describeTarget(last)}`);
    }
    const idx = await choose("Select deploy target:", options);
    if (cfg.lastTarget && idx === 0) {
      target = cfg.targets.find((t) => t.name === cfg.lastTarget)!;
    } else {
      const adjustedIdx = cfg.lastTarget ? idx - 1 : idx;
      if (adjustedIdx >= cfg.targets.length) {
        target = await promptNewTarget();
      } else {
        target = cfg.targets[adjustedIdx];
      }
    }
  } else {
    target = await promptNewTarget();
  }

  const updated = upsertTarget(cfg, target);
  await saveDeployConfig(updated);
  return { target, cfg: updated };
}

async function promptNewTarget(): Promise<DeployTarget> {
  const name = await prompt("Target name (e.g. prod, staging)");
  const host = await prompt("Host (IP or domain)");
  const port = parseInt(await prompt("SSH port", "22"));
  const user = await prompt("SSH user", "root");
  const authIdx = await choose("Auth method:", ["SSH key", "Password"]);
  const authMethod = authIdx === 0 ? "key" as const : "password" as const;
  let keyPath: string | undefined;
  if (authMethod === "key") {
    keyPath = await prompt("Key path", "~/.ssh/id_ed25519");
  }
  return { name, host, port, user, authMethod, keyPath };
}

async function runDeploy(cfg: DeployConfig) {
  console.log("\n--- WebAuthn P256 Public Key Index Deploy ---\n");

  const { target, cfg: updatedCfg } = await pickTarget(cfg);
  console.log(`\nTarget: ${describeTarget(target)}\n`);

  const ssh = createSshSession(target);
  try {
    console.log("-> Connecting...");
    await ssh.primeConnection();

    // Probe
    console.log("-> Checking remote...");
    const state = await probeRemote(ssh);
    console.log(`  Deno: ${state.denoInstalled ? `v${state.denoVersion}` : "NOT installed"}`);
    console.log(`  systemd: ${state.systemdAvailable ? "yes" : "no"}`);
    console.log(`  First deploy: ${state.firstTime ? "yes" : "no"}`);

    if (!state.systemdAvailable) {
      throw new Error("systemd not found -- required for service management");
    }

    // Bootstrap
    if (!state.denoInstalled) {
      console.log("-> Installing Deno...");
      await installDeno(ssh);
    }
    console.log("-> Ensuring service user...");
    await ensureServiceUser(ssh);
    console.log("-> Creating directories...");
    await ensureDirectories(ssh);

    // Prompt for service args on first deploy or if args file missing
    const argsCheck = await ssh.runCapture(["bash", "-lc", `test -f ${DATA_DIR}/args && echo found || echo missing`]);
    if (state.firstTime || argsCheck.stdout.trim() === "missing") {
      console.log("\n-> Configure service parameters:");
      const portVal = await prompt("Port", "11256");
      const privateKey = await prompt("Private key (server wallet, 0x...)");
      const telegramBotToken = await prompt("Telegram bot token (optional)");
      const telegramChatId = await prompt("Telegram chat ID (optional)");
      if (!privateKey) {
        console.log("  WARNING: private key not set -- POST /api/create will fail");
      }

      const argParts = [
        `--port ${portVal}`,
        `--queue-db ${DATA_DIR}/queue.db`,
      ];
      if (privateKey) argParts.push(`--private-key ${privateKey}`);
      if (telegramBotToken) argParts.push(`--telegram-bot-token ${telegramBotToken}`);
      if (telegramChatId) argParts.push(`--telegram-chat-id ${telegramChatId}`);
      const argsStr = argParts.join(" ");

      const writeCode = await ssh.runShell(`
        set -e
        echo '${argsStr}' | sudo tee ${DATA_DIR}/args >/dev/null
        sudo chown webauthn:webauthn ${DATA_DIR}/args
        sudo chmod 0600 ${DATA_DIR}/args
      `);
      if (writeCode !== 0) throw new Error("failed to write args file");
      console.log("  Args saved");
    }

    // Cloudflare Tunnel
    const domain = await prompt("Public domain (Cloudflare Tunnel)", target.lastDomain || "webauthnp256-publickey-index.biubiu.tools");
    if (domain) {
      console.log("-> Setting up Cloudflare Tunnel...");
      await ensureCloudflaredInstalled(ssh);
      await ensureLoggedIn(ssh, domain);
      await setupTunnel(ssh, domain, HTTP_PORT);
      target.lastDomain = domain;
    }

    console.log("-> Installing sudoers...");
    await installSudoers(ssh, target.user);

    // Upload
    const tag = releaseTag();
    const releaseDir = `${RELEASES_DIR}/${tag}`;
    console.log(`-> Uploading release ${tag}...`);
    const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    await uploadRelease(ssh, repoRoot, releaseDir);

    // Install systemd unit (inject args from data/args file)
    console.log("-> Installing systemd unit...");
    const unitPath = `${repoRoot}/deploy/systemd/${SYSTEMD_UNIT}`;
    const unitTemplate = await Deno.readTextFile(unitPath);
    const argsContent = await ssh.runCapture(["bash", "-lc", `cat ${DATA_DIR}/args 2>/dev/null || echo ""`]);
    const unitFinal = unitTemplate.replace("__ARGS__", argsContent.stdout.trim());
    const b64 = bytesToBase64(new TextEncoder().encode(unitFinal));
    const installCode = await ssh.runShell(`
      set -e
      printf '%s' '${b64}' | base64 -d > /tmp/${SYSTEMD_UNIT}
      mv /tmp/${SYSTEMD_UNIT} /etc/systemd/system/${SYSTEMD_UNIT}
      chmod 644 /etc/systemd/system/${SYSTEMD_UNIT}
      systemctl daemon-reload
      systemctl enable ${SYSTEMD_UNIT}
    `);
    if (installCode !== 0) throw new Error("systemd unit install failed");

    // Swap symlink
    console.log("-> Swapping symlink...");
    await swapSymlink(ssh, releaseDir);

    // Restart
    console.log("-> Restarting service...");
    await ssh.runShell(`sudo systemctl restart ${SYSTEMD_UNIT}`);

    // Health check
    console.log("-> Waiting for health...");
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const check = await ssh.runCapture([
        "bash", "-lc",
        `curl -sf http://127.0.0.1:${HTTP_PORT}/api/health 2>/dev/null || true`,
      ]);
      if (check.stdout.includes("ok")) {
        healthy = true;
        break;
      }
    }

    // Update config
    target.lastDeployedAt = new Date().toISOString();
    target.lastReleaseTag = tag;
    await saveDeployConfig(upsertTarget(updatedCfg, target));

    // Summary
    console.log("\n" + "=".repeat(50));
    console.log(healthy ? "Deploy successful!" : "Service started but health check inconclusive");
    console.log(`  Release: ${tag}`);
    console.log(`  Service: ${SYSTEMD_UNIT}`);
    if (domain) {
      console.log(`  URL:     https://${domain}/`);
    }
    console.log(`  HTTP:    http://${target.host}:${HTTP_PORT}/`);
    console.log("=".repeat(50) + "\n");
  } finally {
    await ssh.close();
  }
}

async function runStatus(cfg: DeployConfig) {
  if (cfg.targets.length === 0) {
    console.log("No targets configured. Run: deno task deploy");
    return;
  }
  const { target } = await pickTarget(cfg);
  const ssh = createSshSession(target);
  try {
    await ssh.primeConnection();
    console.log(`\n-> Status of ${describeTarget(target)}\n`);
    await ssh.run(["bash", "-lc", `sudo systemctl status ${SYSTEMD_UNIT} --no-pager 2>/dev/null || echo 'Service not found'`]);
    console.log("\n-> Current release:");
    await ssh.run(["bash", "-lc", `readlink ${CURRENT_LINK} 2>/dev/null || echo 'No current release'`]);
    console.log("\n-> Recent releases:");
    await ssh.run(["bash", "-lc", `ls -lt ${RELEASES_DIR}/ 2>/dev/null | head -5`]);
    console.log("\n-> Health:");
    await ssh.run(["bash", "-lc", `curl -sf http://127.0.0.1:${HTTP_PORT}/api/health 2>/dev/null || echo 'Service not responding'`]);
  } finally {
    await ssh.close();
  }
}

async function runRollback(cfg: DeployConfig) {
  if (cfg.targets.length === 0) {
    console.log("No targets configured.");
    return;
  }
  const { target } = await pickTarget(cfg);
  const ssh = createSshSession(target);
  try {
    await ssh.primeConnection();
    const releases = await ssh.runCapture(["bash", "-lc", `ls -t ${RELEASES_DIR}/ 2>/dev/null`]);
    const dirs = releases.stdout.trim().split("\n").filter(Boolean);
    if (dirs.length < 2) {
      console.log("Not enough releases to rollback");
      return;
    }
    const current = await ssh.runCapture(["bash", "-lc", `readlink ${CURRENT_LINK} | xargs basename`]);
    const currentTag = current.stdout.trim();
    const prev = dirs.find((d) => d !== currentTag) ?? dirs[1];
    console.log(`\nRolling back: ${currentTag} -> ${prev}`);
    await swapSymlink(ssh, `${RELEASES_DIR}/${prev}`);
    await ssh.runShell(`sudo systemctl restart ${SYSTEMD_UNIT}`);
    console.log("Rollback complete");
  } finally {
    await ssh.close();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

main().catch((err) => {
  console.error("Deploy failed:", err.message);
  Deno.exit(1);
});
