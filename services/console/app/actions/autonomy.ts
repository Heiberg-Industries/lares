"use server";
import { cookies } from "next/headers";
import { PgRatchet } from "@lares/agent-kit/ratchet-store";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";
import type { AutonomyLevel } from "../../lib/contracts";

export interface SetAutonomyInput {
  agent: string;
  capability: string;
  action?: string;
  level: AutonomyLevel;
}

export async function setAutonomy(input: SetAutonomyInput): Promise<void> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  const ratchet = new PgRatchet(pool);
  await ratchet.setLevel(input.agent, input.capability, input.level, input.action, email);
}
