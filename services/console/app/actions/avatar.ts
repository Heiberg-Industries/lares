"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { verify } from "../../lib/auth";
import { pool } from "../../lib/db";
import { MAX_AVATAR_BYTES, normalizeAvatar } from "../../lib/avatar-image";
export async function saveAvatar(
  form: FormData,
): Promise<{ ok: boolean; message: string }> {
  if (!(await verify((await cookies()).get("lares_session")?.value)))
    return { ok: false, message: "Sign in again to change this image." };
  const name = form.get("name");
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(name))
    return { ok: false, message: "Invalid agent name." };
  try {
    const found = await pool.query(
      "SELECT name FROM agent_definitions WHERE name=$1",
      [name],
    );
    if (!found.rows.length)
      return { ok: false, message: "Save this agent before adding its image." };
    if (form.get("reset") === "true")
      await pool.query("DELETE FROM agent_avatars WHERE name=$1", [name]);
    else {
      const file = form.get("image");
      if (!(file instanceof File) || file.size > MAX_AVATAR_BYTES)
        return { ok: false, message: "Choose an image up to 2 MB." };
      const image = await normalizeAvatar(
        Buffer.from(await file.arrayBuffer()),
      );
      await pool.query(
        "INSERT INTO agent_avatars(name,image) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET image=excluded.image,updated_at=clock_timestamp()",
        [name, image],
      );
    }
    revalidatePath("/", "layout");
    return {
      ok: true,
      message:
        form.get("reset") === "true"
          ? "Default image restored."
          : "Image saved.",
    };
  } catch {
    return {
      ok: false,
      message:
        "The image could not be saved. Use a still PNG, JPEG or WebP up to 2 MB, and check that avatar storage is available.",
    };
  }
}
