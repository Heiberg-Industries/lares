"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ArrowUpRight } from "@lares/ui/icons";
import { Field } from "@lares/ui/patterns";
import { Button } from "@lares/ui/primitives/button";
import { Input } from "@lares/ui/primitives/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@lares/ui/primitives/dialog";
import * as Menu from "@lares/ui/primitives/dropdown-menu";
import type { AccountOption, ServiceRow } from "../lib/your-accounts";
import { removeAccount } from "../app/actions/accounts";
import { PersonalConsentPowerSelect } from "./AddAccountForm";
import { LogoTile } from "./LogoTile";

/** The form that sends the member to the provider. Google needs the address to pick the right sign-in. */
function ConsentForm({ service, name, account, submit }: { service: ServiceRow["service"]; name: string; account?: AccountOption; submit: string }) {
  return (
    <form method="post" action={`/api/accounts/${service}/start`} className="lares-stack">
      {account ? <>
        <input type="hidden" name="intent" value="reconnect" />
        <input type="hidden" name="accountId" value={account.id} />
        <input type="hidden" name="generation" value={account.generation} />
      </> : <input type="hidden" name="intent" value="new" />}
      {!account && service === "google" && (
        <Field label={`${name} email address`}>
          <Input name="email" type="email" required placeholder="name@example.com" />
        </Field>
      )}
      <PersonalConsentPowerSelect />
      <div className="lares-actions"><Button type="submit">{submit}</Button></div>
    </form>
  );
}

function ConsentDialog({ row, account, open, onOpenChange, title, submit }: {
  row: ServiceRow; account?: AccountOption; open?: boolean; onOpenChange?: (open: boolean) => void; title: string; submit: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open === undefined && <DialogTrigger asChild><Button variant="outline">Connect <ArrowUpRight aria-hidden="true" /></Button></DialogTrigger>}
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>You will go to {row.name} to say yes, then come back here.</DialogDescription>
        <ConsentForm service={row.service} name={row.name} account={account} submit={submit} />
      </DialogContent>
    </Dialog>
  );
}

/** One service: its mark, a plain line, and either "Connect" or the account menu. */
export function AccountServiceRow({ row, attention }: { row: ServiceRow; attention?: string }) {
  const [adding, setAdding] = useState(false);
  const [reconnecting, setReconnecting] = useState<AccountOption | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const many = row.accounts.length > 1;
  const connected = row.accounts.some(a => a.ok);
  const disconnect = (account: AccountOption) => start(async () => {
    setError("");
    try { await removeAccount({ accountId: account.id, generation: account.generation }); router.refresh(); }
    catch { setError("Account could not be disconnected. Refresh and try again."); }
  });
  return (
    <div className="lares-service-row">
      <LogoTile logo={row.service === "google" ? { kind: "letter", text: "G" } : { kind: "microsoft" }} label={`${row.name} logo`} />
      <div className="lares-service-text">
        <div className="lares-service-name">{row.name}</div>
        <p className="lares-service-line">
          {attention ?? row.line}
        </p>
        {row.usedBy.length > 0 && <p className="lares-service-line">Used by: {row.usedBy.join(", ")}</p>}
        {error && <p role="alert" className="lares-form-error">{error}</p>}
      </div>
      {row.accounts.length === 0 ? (
        <ConsentDialog row={row} title={`Connect ${row.name}`} submit="Continue" />
      ) : (
        <>
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button variant="outline" disabled={pending}>{connected ? "Connected" : "Needs attention"} <ChevronDown aria-hidden="true" /></Button>
            </Menu.Trigger>
            <Menu.Content aria-label={`${row.name} account`}>
              <Menu.Label>{many ? "Accounts" : "Account"}</Menu.Label>
              {row.accounts.map(a => <Menu.Item key={a.id}>{a.label}{a.ok && <Check aria-hidden="true" />}</Menu.Item>)}
              <Menu.Item onSelect={() => setAdding(true)}>Connect another {row.name} account</Menu.Item>
              <Menu.Separator />
              {row.accounts.map(a => <Menu.Item key={`r-${a.id}`} onSelect={() => setReconnecting(a)}>Reconnect{many ? ` ${a.label}` : ""}</Menu.Item>)}
              {row.accounts.filter(a => !a.revoked).map(a => <Menu.Item key={`d-${a.id}`} onSelect={() => disconnect(a)}>Disconnect{many ? ` ${a.label}` : ""}</Menu.Item>)}
            </Menu.Content>
          </Menu.Root>
          <ConsentDialog row={row} open={adding} onOpenChange={setAdding} title={`Connect another ${row.name} account`} submit="Continue" />
          <ConsentDialog row={row} account={reconnecting ?? undefined} open={reconnecting !== null} onOpenChange={o => { if (!o) setReconnecting(null); }}
            title={`Reconnect ${reconnecting?.label ?? row.name}`} submit="Reconnect" />
        </>
      )}
    </div>
  );
}
