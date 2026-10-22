import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  createPublicDocsPublicationReceipt,
  exportPublicCorpus,
  verifyPublicCorpus,
  verifyPublicDocsPublicationReceipt,
} from "../packages/agent-kit/src/public-docs.js";

function argumentsMap(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) throw new Error("Arguments must be unique --name value pairs");
    values.set(key, value);
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required argument ${key}`);
  return value;
}

function exactArguments(values: Map<string, string>, allowed: string[]): void {
  if (values.size !== allowed.length || [...values.keys()].some((key) => !allowed.includes(key))) {
    throw new Error(`Unexpected arguments; expected ${allowed.join(", ")}`);
  }
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  tsx scripts/public-docs.ts export --root <repo> --release <candidate|full-rc> --out <absolute-dir>",
    "  tsx scripts/public-docs.ts verify --snapshot <absolute-dir> --expected-corpus <sha256>",
    "  tsx scripts/public-docs.ts receipt-create --snapshot <dir> --manifest <file> --out <file> --expected-corpus <sha256>",
    "  tsx scripts/public-docs.ts receipt-verify --receipt <file> --manifest <file> --release <full-rc> --source-commit <sha> --expected-corpus <sha256>",
  ].join("\n"));
}

const [command, ...args] = process.argv.slice(2);
if (!command) usage();
const values = argumentsMap(args);

if (command === "export") {
  exactArguments(values, ["--root", "--release", "--out"]);
  const repoRoot = path.resolve(required(values, "--root"));
  const sourceCommit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const identity = exportPublicCorpus({
    repoRoot,
    sourceCommit,
    release: required(values, "--release"),
    outDir: required(values, "--out"),
  });
  process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
} else if (command === "verify") {
  exactArguments(values, ["--snapshot", "--expected-corpus"]);
  const docs = verifyPublicCorpus(required(values, "--snapshot"), required(values, "--expected-corpus"));
  process.stdout.write(`${JSON.stringify({ release: docs.release, sourceCommit: docs.sourceCommit, corpusSha256: docs.corpusSha256, pages: docs.list() }, null, 2)}\n`);
} else if (command === "receipt-create") {
  exactArguments(values, ["--snapshot", "--manifest", "--out", "--expected-corpus"]);
  const receipt = createPublicDocsPublicationReceipt({
    snapshotDir: required(values, "--snapshot"),
    releaseManifestPath: required(values, "--manifest"),
    outputPath: required(values, "--out"),
    expectedCorpusSha256: required(values, "--expected-corpus"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else if (command === "receipt-verify") {
  exactArguments(values, ["--receipt", "--manifest", "--release", "--source-commit", "--expected-corpus"]);
  const receipt = verifyPublicDocsPublicationReceipt({
    receiptPath: required(values, "--receipt"),
    releaseManifestPath: required(values, "--manifest"),
    expected: {
      release: required(values, "--release"),
      sourceCommit: required(values, "--source-commit"),
      corpusSha256: required(values, "--expected-corpus"),
    },
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else usage();
