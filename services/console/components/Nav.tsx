"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType } from "react";
import {
  House,
  Inbox,
  MessageSquareText,
  Bot,
  PenLine,
  Sparkles,
  IdCard,
  CircleUserRound,
  Plug,
  Wrench,
  BookOpen,
  CalendarDays,
  ListChecks,
  Bookmark,
  ShieldCheck,
  Bell,
  UsersRound,
  Tags,
  Settings2,
  Clock,
  Route,
  DatabaseBackup,
  UserRound,
  SunMoon,
  LogOut,
} from "@lares/ui/icons";
import { Mark } from "@lares/ui/patterns";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@lares/ui/primitives/sidebar";
import { ThemeControl, useConsoleTheme } from "./ThemeControl";
import { InboxDot } from "./InboxDot";
import styles from "./AppShell.module.css";

type Icon = ComponentType<{ "aria-hidden"?: boolean | "true" | "false" }>;
/** A page in the menu. Its address reads like its words. */
export type MenuPage = { href: string; label: string; Icon: Icon };
/** A group of pages under one label. The first group has none. */
export type MenuGroup = { label: string | null; pages: MenuPage[] };

/** The owner's menu, in order. */
export const OWNER_MENU: MenuGroup[] = [
  { label: null, pages: [
    { href: "/", label: "Overview", Icon: House },
    { href: "/reviews", label: "Reviews", Icon: Inbox },
    { href: "/chat", label: "Chat", Icon: MessageSquareText },
  ] },
  { label: "Agents", pages: [
    { href: "/agents", label: "Agents", Icon: Bot },
    { href: "/writing-style", label: "Writing style", Icon: PenLine },
  ] },
  { label: "Connections", pages: [
    { href: "/your-accounts", label: "Your accounts", Icon: CircleUserRound },
    { href: "/integrations", label: "Integrations", Icon: Plug },
    { href: "/outside-tools", label: "Outside tools", Icon: Wrench },
  ] },
  { label: "Tools", pages: [
    { href: "/deadlines", label: "Deadlines", Icon: CalendarDays },
    { href: "/meetings", label: "Meetings", Icon: ListChecks },
    { href: "/saved-preferences", label: "Saved preferences", Icon: Bookmark },
  ] },
  { label: "Activity", pages: [
    { href: "/permission-checks", label: "Permission checks", Icon: ShieldCheck },
    { href: "/alerts", label: "Alerts", Icon: Bell },
  ] },
  { label: "Organisation", pages: [
    { href: "/members", label: "Members", Icon: UsersRound },
  ] },
  { label: "Installation", pages: [
    { href: "/general", label: "General", Icon: Settings2 },
    { href: "/quiet-hours-and-delivery", label: "Quiet hours and delivery", Icon: Clock },
    { href: "/alert-routing", label: "Alert routing", Icon: Route },
    { href: "/backups", label: "Backups", Icon: DatabaseBackup },
  ] },
];

/** Pages that are announced but not built yet. Each shows greyed at the end of its group with a "Coming" tag,
    and is plain text: not a link, and nothing happens when it is clicked. When one ships, delete its line here
    and add it to its group in OWNER_MENU with an address. */
export const COMING: { group: string; label: string; Icon: Icon }[] = [
  { group: "Agents", label: "Skills", Icon: Sparkles },
  { group: "Agents", label: "Profiles", Icon: IdCard },
  { group: "Connections", label: "Knowledge sources", Icon: BookOpen },
  { group: "Organisation", label: "Brands", Icon: Tags },
];

/** Under the signed-in person's name, for everyone. */
export const MEMBERSHIP: MenuPage = { href: "/your-membership", label: "Your membership", Icon: UserRound };

/** The pages only the owner may open. An admin's menu is the owner's without them. The pages decide
    for themselves who gets in (lib/auth.ts); a test keeps this list equal to what they say. */
export const OWNER_ONLY_PAGES = ["/members", "/general", "/backups"];

/** What an admin sees: every page they may use, in the owner's order. A group left empty is dropped. */
export const ADMIN_MENU: MenuGroup[] = OWNER_MENU
  .map((group) => ({ ...group, pages: group.pages.filter((page) => !OWNER_ONLY_PAGES.includes(page.href)) }))
  .filter((group) => group.pages.length > 0);

/** Which menu a person gets. The console works it out from who is signed in (lib/auth.ts, consoleLevel). */
export type MenuLevel = "owner" | "admin" | "member";

/** What a member who is neither the owner nor an admin sees. */
export const MEMBER_MENU: MenuGroup[] = [
  { label: null, pages: [OWNER_MENU[0]!.pages[2]!] },
  { label: "Connections", pages: [OWNER_MENU[2]!.pages[0]!] },
];

/** The one current menu page for an address: the page whose address is the longest match. */
export function currentHref(pathname: string, pages: MenuPage[]): string | null {
  let best: string | null = null;
  for (const { href } of pages) {
    const match = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
    if (match && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

export function Nav({ level, person }: { level: MenuLevel; person?: string | null }) {
  const owner = level === "owner";
  const pathname = usePathname();
  const theme = useConsoleTheme();
  const [open, setOpen] = useState(false);
  const menu = owner ? OWNER_MENU : level === "admin" ? ADMIN_MENU : MEMBER_MENU;
  const current = currentHref(pathname, [...menu.flatMap((group) => group.pages), MEMBERSHIP]);
  const close = () => setOpen(false);
  const page = ({ href, label, Icon }: MenuPage) => (
    <SidebarMenuItem key={href}>
      <SidebarMenuButton asChild isActive={current === href}>
        <Link href={href} onClick={close} aria-current={current === href ? "page" : undefined}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
          {owner && href === "/chat" && <InboxDot />}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  const home = level === "member" ? "/chat" : "/";
  const contents = (
    <>
      <SidebarHeader>
        <Link className={styles.brand} href={home} onClick={close}>
          <Mark />
          lares
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Console navigation" className={styles.groups}>
          {menu.map((group) => (
            <SidebarGroup key={group.label ?? "top"}>
              {group.label && <SidebarGroupLabel asChild><p>{group.label}</p></SidebarGroupLabel>}
              <SidebarMenu>
                {group.pages.map(page)}
                {owner && COMING.filter((item) => item.group === group.label).map(({ label, Icon }) => (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton disabled>
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                      <SidebarMenuBadge>Coming</SidebarMenuBadge>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarGroup>
          <SidebarGroupLabel asChild><p className={styles.person}>{person || "Signed in"}</p></SidebarGroupLabel>
          <SidebarMenu>
            {page(MEMBERSHIP)}
            <SidebarMenuItem className={styles.appearance}>
              <span className={styles.appearanceLabel}>
                <SunMoon aria-hidden="true" />
                Appearance
              </span>
              <ThemeControl {...theme} />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <form action="/api/auth/logout" method="post">
                <SidebarMenuButton type="submit">
                  <LogOut aria-hidden="true" />
                  <span>Sign out</span>
                </SidebarMenuButton>
              </form>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarFooter>
    </>
  );
  return (
    <SidebarProvider openMobile={open} onOpenMobileChange={setOpen}>
      <Sidebar label="Console navigation">{contents}</Sidebar>
      <div className={styles.mobileBar}>
        <Link className={styles.brand} href={home}>
          <Mark />
          lares
        </Link>
        <SidebarTrigger aria-label="Open navigation" />
      </div>
    </SidebarProvider>
  );
}
