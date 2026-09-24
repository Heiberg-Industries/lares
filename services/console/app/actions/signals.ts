"use server";
import { cookies } from "next/headers";
import { verify } from "../../lib/auth";
import { putAdmin } from "../../lib/signals";

async function who(): Promise<string> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  return email;
}
export async function saveRules(json: string): Promise<void> {
  const by = await who();
  await putAdmin("/admin/rules", JSON.parse(json), by);
}
export async function saveCatalogue(json: string): Promise<void> {
  const by = await who();
  await putAdmin("/admin/catalogue", JSON.parse(json), by);
}
/** ORB-240. Takes the switches as values, not JSON: this one is checkboxes, not an editor. */
export async function saveConsumers(consumers: { name: "slack" | "linear"; enabled: boolean }[]): Promise<void> {
  const by = await who();
  await putAdmin("/admin/consumers", consumers, by);
}
