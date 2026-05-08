export type AuthMethod = "key" | "password";

export interface DeployTarget {
  name: string;
  host: string;
  port: number;
  user: string;
  authMethod: AuthMethod;
  keyPath?: string;
  lastDomain?: string;
  lastDeployedAt?: string;
  lastReleaseTag?: string;
}

export interface DeployConfig {
  lastTarget?: string;
  targets: DeployTarget[];
}

function configPath(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const xdg = Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
  return `${xdg}/webauthnp256-publickey-index/deploy.json`;
}

export async function loadDeployConfig(): Promise<DeployConfig> {
  try {
    return JSON.parse(await Deno.readTextFile(configPath()));
  } catch {
    return { targets: [] };
  }
}

export async function saveDeployConfig(cfg: DeployConfig): Promise<void> {
  const path = configPath();
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function upsertTarget(cfg: DeployConfig, target: DeployTarget): DeployConfig {
  const others = cfg.targets.filter((t) => t.name !== target.name);
  return { ...cfg, targets: [target, ...others], lastTarget: target.name };
}

export function describeTarget(t: DeployTarget): string {
  const auth = t.authMethod === "key" ? `key ${t.keyPath ?? "(default)"}` : "password";
  return `${t.name}  ${t.user}@${t.host}${t.port === 22 ? "" : ":" + t.port}  (${auth})`;
}
