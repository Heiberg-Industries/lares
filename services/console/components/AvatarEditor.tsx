"use client";
import { Field, Notice } from "@lares/ui/patterns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lares/ui/primitives/card";
import { Input } from "@lares/ui/primitives/input";
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
  const [failed, setFailed] = useState(false);
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
      setFailed(!result.ok);
      if (result.ok) {
        setPreviewVersion(data.get("reset") === "true" ? undefined : String(Date.now()));
        router.refresh();
      }
    } catch {
      setFailed(true);
      setMessage(
        "The image could not be saved. Reload to check its current state.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>Agent image</CardTitle>
        <CardDescription>
          PNG, JPEG or WebP, up to 2 MB. Images save immediately and are included
          in the database backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="lares-stack">
      <figure className="lares-avatar-preview">
        <AgentAvatar
          role={role}
          src={previewVersion ? `/api/agents/${encodeURIComponent(name)}/avatar?v=${previewVersion}` : undefined}
        />
        <figcaption>{previewVersion ? "Current image" : "Default symbol"}</figcaption>
      </figure>
      <form action={save} className="lares-stack">
        <Field label="Choose an image">
          <Input
            type="file"
            name="image"
            accept="image/png,image/jpeg,image/webp"
            required
            disabled={busy}
          />
        </Field>
        <div className="lares-actions">
          <Button variant="outline" type="submit" disabled={busy}>
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
      {message && <Notice tone={failed ? "error" : "success"}>{message}</Notice>}
      </CardContent>
    </Card>
  );
}
