import { Command } from "commander";
import { registerNetworkCommands } from "../lib/cli.js";

/**
 * The `lares` program with the network commands on it. Split from bin/cli.ts so a test can
 * inspect the registered commands without parsing the test runner's own argv.
 */
export function buildProgram(): Command {
  const program = new Command();
  program.name("lares").description("Lares — local CLI (relationship network)").version("0.1.0");
  registerNetworkCommands(program);
  return program;
}
