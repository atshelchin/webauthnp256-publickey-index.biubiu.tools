/**
 * Cloudflare Tunnel -- HTTPS without opening firewall ports.
 * Cert is stored per zone to avoid cross-zone conflicts.
 */
import type { SshSession } from "./ssh.ts";

function sh(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

function extractZone(domain: string): string {
  const parts = domain.split(".");
  return parts.slice(-2).join(".");
}

function certPathForZone(zone: string): string {
  return `/root/.cloudflared/cert-${zone.replace(/\./g, "-")}.pem`;
}

export async function ensureCloudflaredInstalled(ssh: SshSession): Promise<void> {
  const probe = await ssh.runCapture(["bash", "-lc", "command -v cloudflared && cloudflared --version || true"]);
  if (probe.code === 0 && /cloudflared version/i.test(probe.stdout)) return;

  const code = await ssh.runShell(`
    set -e
    if command -v apt-get >/dev/null 2>&1; then
      sudo mkdir -p --mode=0755 /usr/share/keyrings
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
      CODENAME=$( . /etc/os-release 2>/dev/null; echo "\${VERSION_CODENAME:-bookworm}" )
      echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $CODENAME main" | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
      sudo apt-get update && sudo apt-get install -y cloudflared
    elif command -v dnf >/dev/null 2>&1; then
      curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo | sudo tee /etc/yum.repos.d/cloudflared.repo >/dev/null
      sudo dnf install -y cloudflared
    else
      ARCH=$(uname -m)
      case "$ARCH" in x86_64|amd64) BIN=amd64;; aarch64|arm64) BIN=arm64;; *) echo "unsupported: $ARCH" >&2; exit 1;; esac
      TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
      curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$BIN -o "$TMP"
      sudo install -m 0755 "$TMP" /usr/local/bin/cloudflared
    fi
    cloudflared --version
  `);
  if (code !== 0) throw new Error("cloudflared install failed");
}

export async function ensureLoggedIn(ssh: SshSession, domain: string): Promise<void> {
  const targetZone = extractZone(domain);
  const certPath = certPathForZone(targetZone);

  // Check if cert for this zone already exists
  const probe = await ssh.runCapture(["bash", "-lc", `test -f ${certPath}`]);
  if (probe.code === 0) {
    console.log(`  Using existing cert for ${targetZone}: ${certPath}`);
    return;
  }

  console.error(
    `\n  Cloudflare login required for zone: ${targetZone}\n` +
    `  A URL will print below -- open it in your browser,\n` +
    `  log in to Cloudflare, and select "${targetZone}" as the zone.\n`,
  );

  // Backup existing default cert
  const defaultCert = "/root/.cloudflared/cert.pem";
  await ssh.runShell(
    `[ -f ${defaultCert} ] && cp ${defaultCert} ${defaultCert}.bak || true`,
    { stdio: "null" },
  );

  const code = await ssh.runShell("cloudflared tunnel login");
  if (code !== 0) {
    await ssh.runShell(`[ -f ${defaultCert}.bak ] && mv ${defaultCert}.bak ${defaultCert} || true`, { stdio: "null" });
    throw new Error(
      `cloudflared login failed.\n` +
      `Make sure you selected the "${targetZone}" zone in the browser.`,
    );
  }

  // Save cert with zone-specific name
  await ssh.runShell(`cp ${defaultCert} ${certPath}`, { stdio: "null" });

  // Restore previous default cert
  await ssh.runShell(
    `[ -f ${defaultCert}.bak ] && mv ${defaultCert}.bak ${defaultCert} || true`,
    { stdio: "null" },
  );

  console.log(`  Cloudflare login successful -- cert saved to ${certPath}`);
}

export async function setupTunnel(ssh: SshSession, domain: string, localPort: number): Promise<string> {
  const zone = extractZone(domain);
  const certPath = certPathForZone(zone);
  const tunnelName = `webauthn-${zone.replace(/\./g, "-")}`;
  const certFlag = `--origincert ${certPath}`;

  // List existing tunnels
  const listed = await ssh.runCapture(
    ["bash", "-lc", `cloudflared ${certFlag} tunnel list --output json 2>/dev/null || echo '[]'`],
  );
  let tunnelId: string | undefined;
  try {
    const arr = JSON.parse(listed.stdout) as { id: string; name: string }[];
    tunnelId = arr.find(t => t.name === tunnelName)?.id;
  } catch { /* create new */ }

  if (!tunnelId) {
    const create = await ssh.runCapture(
      ["bash", "-lc", `cloudflared ${certFlag} tunnel create ${sh(tunnelName)}`],
    );
    if (create.code !== 0) throw new Error(`tunnel create failed: ${create.stderr.trim()}`);
    tunnelId = create.stdout.match(/([0-9a-f-]{36})/)?.[1];
    if (!tunnelId) throw new Error("couldn't parse tunnel id from: " + create.stdout);
    console.log(`  Created tunnel: ${tunnelName} (${tunnelId})`);
  } else {
    console.log(`  Using existing tunnel: ${tunnelName} (${tunnelId})`);
  }

  // Write tunnel config
  const configYml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: /root/.cloudflared/${tunnelId}.json`,
    `origincert: ${certPath}`,
    `ingress:`,
    `  - hostname: ${domain}`,
    `    service: http://127.0.0.1:${localPort}`,
    `  - service: http_status:404`,
    "",
  ].join("\n");

  const b64 = btoa(configYml);
  await ssh.runShell(`
    mkdir -p /etc/cloudflared
    printf %s ${sh(b64)} | base64 -d > /etc/cloudflared/config.yml
  `);

  // Route DNS
  const routeResult = await ssh.runCapture(
    ["bash", "-lc", `cloudflared ${certFlag} tunnel route dns ${sh(tunnelName)} ${sh(domain)} 2>&1`],
  );
  const routeOutput = routeResult.stdout + routeResult.stderr;
  if (routeResult.code !== 0 && !routeOutput.includes("already configured")) {
    console.error(`  DNS route failed: ${routeOutput.trim()}`);
    console.error(`  You may need to manually delete conflicting DNS records in Cloudflare Dashboard`);
  } else {
    console.log(`  DNS: ${domain} -> tunnel ${tunnelName}`);
  }

  // Install/restart cloudflared service
  const svcProbe = await ssh.runCapture(["bash", "-lc", "systemctl list-unit-files cloudflared.service --no-pager"]);
  if (!/cloudflared\.service/.test(svcProbe.stdout)) {
    await ssh.runShell("cloudflared --config /etc/cloudflared/config.yml service install");
  }
  await ssh.runShell("systemctl restart cloudflared");

  return tunnelId;
}
