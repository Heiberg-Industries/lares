"use client";
import React, { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@lares/ui/primitives/button";
import { AgentAvatar } from "@lares/ui/patterns";
import { saveAvatar } from "../app/actions/avatar";
export function AvatarEditor({ name, role, initialVersion }: { name: string; role: string; initialVersion?: string }) {
  const router = useRouter();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previewVersion, setPreviewVersion] = useState(initialVersion);
  async function save(data: FormData) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    data.set("name", name);
    try {
      const result = await saveAvatar(data);
      setMessage(result.message);
      if (result.ok) {
        setPreviewVersion(data.get("reset") === "true" ? undefined : String(Date.now()));
        router.refresh();
      }
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
      <figure className="lares-avatar-preview">
        <AgentAvatar
          role={role}
          src={previewVersion ? `/api/agents/${encodeURIComponent(name)}/avatar?v=${previewVersion}` : undefined}
        />
        <figcaption>{previewVersion ? "Current image" : "Default symbol"}</figcaption>
      </figure>
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
