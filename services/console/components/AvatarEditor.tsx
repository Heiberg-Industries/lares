"use client";
import React, { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@lares/ui/primitives/button";
import { saveAvatar } from "../app/actions/avatar";
export function AvatarEditor({ name }: { name: string }) {
  const router = useRouter();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(data: FormData) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    data.set("name", name);
    try {
      const result = await saveAvatar(data);
      setMessage(result.message);
      if (result.ok) router.refresh();
    } catch {
      setMessage(
        "The image could not be saved. Reload to check its current state.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="lares-surface">
      <h2 className="lares-section-title">Agent image</h2>
      <p className="lares-muted">
        PNG, JPEG or WebP, up to 2 MB. Images save immediately and are included
        in the database backup.
      </p>
      <form action={save}>
        <label>
          Choose an image
          <input
            type="file"
            name="image"
            accept="image/png,image/jpeg,image/webp"
            required
            disabled={busy}
          />
        </label>
        <div className="lares-actions">
          <Button type="submit" disabled={busy}>
            Save image
          </Button>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => {
              const data = new FormData();
              data.set("reset", "true");
              void save(data);
            }}
          >
            Restore default
          </Button>
        </div>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
