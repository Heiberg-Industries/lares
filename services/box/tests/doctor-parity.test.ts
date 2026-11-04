// `lares doctor`'s parity check: a server runs exactly the installed release, nothing extra.
// Pure data in, one finding out. No Docker, no real files except the small ones the file-reading
// test writes to a temp folder.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { main, parseArgs } from "../bin/doctor.js";
import { renderKeeperConfig, type KeeperConfigOptions } from "../lib/keeper-config.js";
import { checkParity, keeperConfigDifferences, provenanceRecord, type ContainerRow, type ParityInput } from "../lib/doctor-parity.js";
import type { ReleaseManifest } from "../lib/release-manifest.js";

const D = (n: string, c = "a") => `example.invalid/lares-${n}@sha256:${c.repeat(64)}`;
const RELEASE: ReleaseManifest = {
  release: "2026-11-04",
  images: {
    db: D("db", "1"), console: D("console", "2"), "lares-gateway": D("gateway", "3"), caddy: D("caddy", "4"),
    "lares-keeper": D("keeper", "5"), "lares-egress-proxy": D("egress", "6"), "lares-firewall-helper": D("firewall", "7"),
    "chief-of-staff": D("chief", "8"), creative: D("creative", "9"),
  },
  migrations: { box: "001_baseline.sql" },
  breaking: [],
};

const OPTS: KeeperConfigOptions = {
  project: "lares", network: "lares-network", subnet: "172.30.0.0/24",
  maintenanceAdmission: { hostDirectory: "/var/lib/lares-maintenance/admission", installationId: "11111111-1111-4111-8111-111111111111", epoch: 7 },
  proxyAddress: "172.30.0.2", dir: "/srv/lares", agentsDir: "/srv/lares/agents", retiredDir: "/srv/lares/retired",
  backupDir: "/srv/lares/backup", egressDir: "/srv/lares/egress", secretsDir: "/etc/lares/secrets", pgDatabase: "lares_state",
  gatewayUrl: "http://lares-gateway:4000", ownerId: "fixture-owner", publicDoorOrigin: "https://lares.example.com",
  ownerHomeTz: "Europe/Berlin",
};

const row = (service: string, image: string, project = "lares"): ContainerRow => ({ name: service, project, service, image });
const healthy = (): ContainerRow[] => [
  row("db", RELEASE.images.db!), row("console", RELEASE.images.console!), row("lares-gateway", RELEASE.images["lares-gateway"]!),
  row("caddy", RELEASE.images.caddy!), row("lares-keeper", RELEASE.images["lares-keeper"]!),
  row("lares-egress-proxy", RELEASE.images["lares-egress-proxy"]!),
  row("lares-assistant", RELEASE.images["chief-of-staff"]!), row("lares-studio", RELEASE.images.creative!),
];

const installerOutput = () => renderKeeperConfig(RELEASE, OPTS);
const input = (over: Partial<ParityInput> = {}): ParityInput => {
  const config = installerOutput();
  return { release: RELEASE, containers: healthy(), projects: ["lares"], keeperConfig: config, keeperConfigPresent: true, rendered: provenanceRecord(config), ...over };
};
const text = (r: ReturnType<typeof checkParity>) => `${r.say}\n${r.fix ?? ""}`;

describe("containers", () => {
  it("passes when every container runs the release's image", () => {
    expect(checkParity(input()).state).toBe("ok");
  });

  it("fails naming the one service whose image differs", () => {
    const containers = healthy().map((c) => (c.service === "console" ? { ...c, image: D("console", "f") } : c));
    const r = checkParity(input({ containers }));
    expect(r.state).toBe("fail");
    expect(text(r)).toContain("console");
    expect(text(r)).not.toContain("caddy");
  });

  it("fails for an image started by tag, not by digest", () => {
    const containers = healthy().map((c) => (c.service === "db" ? { ...c, image: "example.invalid/lares-db:latest" } : c));
    expect(text(checkParity(input({ containers })))).toContain("not pinned by digest");
  });

  it("fails for an agent container that runs none of the role images", () => {
    const containers = [...healthy(), row("lares-rogue", D("other", "e"))];
    const r = checkParity(input({ containers }));
    expect(r.state).toBe("fail");
    expect(text(r)).toContain("lares-rogue");
  });

  it("fails for an extra container in a Lares project", () => {
    const r = checkParity(input({ containers: [...healthy(), row("metrics", D("metrics", "e"))] }));
    expect(r.state).toBe("fail");
    expect(text(r)).toContain("metrics");
  });

  it("ignores containers outside the Lares projects", () => {
    expect(checkParity(input({ containers: [...healthy(), row("other-app", D("x", "e"), "someone-else"), { name: "loose", project: "", service: "", image: "x" }] })).state).toBe("ok");
  });
});

describe("keeper.json", () => {
  it("the installer's own output is ok, including after JSON round trip", () => {
    const config = JSON.parse(JSON.stringify(installerOutput()));
    expect(keeperConfigDifferences(config, provenanceRecord(installerOutput()))).toEqual([]);
  });

  it("fails naming a hand-added key path", () => {
    const config = JSON.parse(JSON.stringify(installerOutput()));
    config.lifecycle.runtime.extraSwitch = true;
    const r = checkParity(input({ keeperConfig: config }));
    expect(r.state).toBe("fail");
    expect(text(r)).toContain("lifecycle.runtime.extraSwitch");
  });

  it("fails naming a changed installer value", () => {
    const config = JSON.parse(JSON.stringify(installerOutput()));
    config.publicDoorOrigin = "https://elsewhere.example.com";
    const r = checkParity(input({ keeperConfig: config }));
    expect(text(r)).toContain("publicDoorOrigin");
    expect(text(r)).not.toContain("elsewhere");
  });

  it("fails for a hand-set agent setting carried through an installer re-run", () => {
    // What the installer rendered, versus what keeper.json holds after a re-run carried a hand-set key.
    const rendered = provenanceRecord(installerOutput());
    const carried = JSON.parse(JSON.stringify(installerOutput()));
    carried.lifecycle.defaultBindings["chief-of-staff"].environment.VAULT_PATH = "/srv/vault";
    carried.lifecycle.defaultBindings["chief-of-staff"].mounts.push({ source: "/srv/vault-host", target: "/srv/vault", readOnly: false });
    const r = checkParity(input({ keeperConfig: carried, rendered }));
    expect(r.state).toBe("fail");
    expect(text(r)).toContain("lifecycle.defaultBindings.chief-of-staff.environment.VAULT_PATH");
    expect(text(r)).toContain("lifecycle.defaultBindings.chief-of-staff.mounts[0]");
    expect(text(r)).not.toContain("/srv/vault");
  });

  it("does not count what a Lares command writes later", () => {
    const config = JSON.parse(JSON.stringify(installerOutput()));
    config.gatewayBudget = { serviceKeyFile: "/etc/lares/secrets/k" };
    config.budgetNative = { directory: "/var/lib/lares/budget-native" };
    config.lifecycle.runtime.google = { clientIdFile: "/x" };
    expect(checkParity(input({ keeperConfig: config })).state).toBe("ok");
  });

  it("warns, rather than guessing, when the installer's record is missing", () => {
    const r = checkParity(input({ rendered: null }));
    expect(r.state).toBe("warn");
    expect(text(r)).toContain("run the installer again");
  });

  it("warns when nothing could be listed, and still fails on what it did find", () => {
    expect(checkParity(input({ containers: null })).state).toBe("warn");
    const config = JSON.parse(JSON.stringify(installerOutput()));
    config.surprise = 1;
    expect(checkParity(input({ containers: null, keeperConfig: config })).state).toBe("fail");
  });

  it("reports one entry for a whole hand-added block, not one per leaf", () => {
    const config = JSON.parse(JSON.stringify(installerOutput()));
    config.handBlock = { a: 1, b: { c: 2, d: 3 } };
    const r = checkParity(input({ keeperConfig: config }));
    expect(r.say).toContain("1 place");
    expect(text(r)).toContain("handBlock");
  });
});

describe("secrets never appear", () => {
  it("prints key paths and names, never values", () => {
    const config = JSON.parse(JSON.stringify(installerOutput()));
    config.lifecycle.defaultBindings["chief-of-staff"].environment.API_TOKEN = "super-secret-value-123";
    config.lifecycle.runtime.sneaky = "another-secret-value-456";
    const r = checkParity(input({ keeperConfig: config, containers: [...healthy(), row("extra", "registry.example/with-credentials@secret")] }));
    expect(text(r)).not.toContain("super-secret-value-123");
    expect(text(r)).not.toContain("another-secret-value-456");
    expect(text(r)).not.toContain("registry.example");
    expect(JSON.stringify(provenanceRecord(config))).not.toContain("secret-value");
  });
});

describe("the doctor command", () => {
  it("only runs the check when given a release file, and reads the files it is handed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-parity-"));
    try {
      const config = installerOutput();
      const secret = "never-print-this-value";
      const handSet = JSON.parse(JSON.stringify(config));
      handSet.lifecycle.runtime.sneaky = secret;
      writeFileSync(join(dir, "release.json"), JSON.stringify(RELEASE));
      writeFileSync(join(dir, "containers.jsonl"), healthy().map((c) => JSON.stringify({ ...c, name: `/${c.name}` })).join("\n") + "\n");
      writeFileSync(join(dir, "keeper.json"), JSON.stringify(handSet));
      writeFileSync(join(dir, "keeper.json.rendered"), JSON.stringify(provenanceRecord(config)));
      const flags = [
        "--release-file", join(dir, "release.json"), "--containers-file", join(dir, "containers.jsonl"),
        "--keeper-config-file", join(dir, "keeper.json"), "--keeper-rendered-file", join(dir, "keeper.json.rendered"),
        "--lares-project", "lares",
      ];
      expect(parseArgs(flags).laresProjects).toEqual(["lares"]);

      const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), end: vi.fn() } as unknown as Pool;
      const out: string[] = [];
      const code = await main(flags, { db, env: {}, out: (s) => out.push(s) });
      const report = out.join("\n");
      expect(code).toBe(1);
      expect(report).toContain("Matches the release");
      expect(report).toContain("lifecycle.runtime.sneaky");
      expect(report).not.toContain(secret);

      const plain: string[] = [];
      await main([], { db, env: {}, out: (s) => plain.push(s) });
      expect(plain.join("\n")).not.toContain("Matches the release");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
