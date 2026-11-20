"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "@lares/ui/icons";
import { Field } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Select } from "@lares/ui/primitives/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@lares/ui/primitives/dialog";
import * as Menu from "@lares/ui/primitives/dropdown-menu";
import type { AccountEntry, AccountService } from "../lib/your-accounts";
import { removeAccount } from "../app/actions/accounts";
import { PersonalConsentPowerSelect } from "./AddAccountForm";
import { LogoTile } from "./LogoTile";

const logo = (service: AccountService) => service === "google" ? { kind: "letter" as const, text: "G" } : { kind: "microsoft" as const };

/** Add account: pick the provider, pick the power, go to the provider's own account chooser. No address is typed. */
export function AddAccount({ orgs }: { orgs: { id: string; label: string }[] }) {
  const [service, setService] = useState<AccountService>("google");
  const name = service === "google" ? "Google" : "Microsoft";
  return (
    <Dialog>
      <DialogTrigger asChild><Button>Add account</Button></DialogTrigger>
      <DialogContent>
        <DialogTitle>Add account</DialogTitle>
        <DialogDescription>You will go to {name} to choose the account and say yes, then come back here.</DialogDescription>
        <form method="post" action={`/api/accounts/${service}/start`} className="lares-stack">
          <input type="hidden" name="intent" value="new" />
          <Field label="Connect with">
            <Select value={service} onChange={e => setService(e.target.value === "microsoft" ? "microsoft" : "google")}>
              <option value="google">Google (Gmail, Calendar and Drive)</option>
              <option value="microsoft">Microsoft (work mailbox and calendar)</option>
            </Select>
          </Field>
          {service === "google" && orgs.length > 1 && (
            <Field label="Which Google sign-in app">
              <Select name="org" defaultValue={orgs[0].id}>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </Field>
          )}
          <PersonalConsentPowerSelect />
          <div className="lares-actions"><Button type="submit">Connect with {name}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Reconnect({ account, onClose }: { account: AccountEntry; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogTitle>{`Reconnect ${account.label}`}</DialogTitle>
        <DialogDescription>You will go to {account.serviceName} to say yes, then come back here.</DialogDescription>
        <form method="post" action={`/api/accounts/${account.service}/start`} className="lares-stack">
          <input type="hidden" name="intent" value="reconnect" />
          <input type="hidden" name="accountId" value={account.id} />
          <input type="hidden" name="generation" value={account.generation} />
          <PersonalConsentPowerSelect />
          <div className="lares-actions"><Button type="submit">Reconnect</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The date alone, in a fixed form, so the server and the browser print the same text. */
const day = (iso: string) => iso.slice(0, 10);

export function AccountList({ accounts }: { accounts: AccountEntry[] }) {
  const [reconnecting, setReconnecting] = useState<AccountEntry | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const disconnect = (account: AccountEntry) => start(async () => {
    setError("");
    try { await removeAccount({ accountId: account.id, generation: account.generation }); router.refresh(); }
    catch { setError("Account could not be disconnected. Refresh and try again."); }
  });
  if (accounts.length === 0) return <p className="lares-muted">No accounts yet. Use Add account to connect one.</p>;
  return (
    <section className="lares-service-list" aria-label="Accounts">
      {error && <p role="alert" className="lares-form-error">{error}</p>}
      {accounts.map(a => (
        <div key={a.id} className="lares-service-row" data-account={a.id}>
          <LogoTile logo={logo(a.service)} label={`${a.serviceName} logo`} />
          <div className="lares-service-text">
            <div className="lares-service-name">{a.label}</div>
            <p className="lares-service-line">{a.serviceName} · <strong data-status={a.ok ? "working" : "problem"}>{a.status}</strong>{a.lastRead ? ` · Last read ${day(a.lastRead)}` : ""}</p>
            {a.problem && <p className="lares-service-line">{a.problem}</p>}
            {a.usedBy.length > 0 && <p className="lares-service-line">Used by: {a.usedBy.join(", ")}</p>}
          </div>
          <Menu.Root>
            <Menu.Trigger asChild><Button variant="outline" disabled={pending} aria-label={`Actions for ${a.label}`}>Manage <ChevronDown aria-hidden="true" /></Button></Menu.Trigger>
            <Menu.Content aria-label={`${a.label} actions`}>
              <Menu.Item onSelect={() => setReconnecting(a)}>Reconnect</Menu.Item>
              {!a.revoked && <Menu.Item onSelect={() => disconnect(a)}>Disconnect</Menu.Item>}
            </Menu.Content>
          </Menu.Root>
        </div>
      ))}
      {reconnecting && <Reconnect account={reconnecting} onClose={() => setReconnecting(null)} />}
    </section>
  );
}
