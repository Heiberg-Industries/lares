"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "../utils";
import { Menu } from "../icons";
import { Button } from "./button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./sheet";

/* The parts of the shadcn sidebar the console uses, with the console's values. On a wide screen the
   sidebar is a fixed column; at phone width the same contents open in a Sheet from the left. The
   stylesheet decides which one shows, so the server and the browser render the same thing. */

type SidebarContextValue = {
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

/** Holds whether the phone sheet is open. Put the Sidebar and its SidebarTrigger inside it. */
function SidebarProvider({
  openMobile: openProp,
  onOpenMobileChange,
  children,
}: {
  openMobile?: boolean;
  onOpenMobileChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(false);
  const openMobile = openProp ?? inner;
  const setOpenMobile = React.useCallback(
    (open: boolean) => {
      setInner(open);
      onOpenMobileChange?.(open);
    },
    [onOpenMobileChange],
  );
  const value = React.useMemo(() => ({ openMobile, setOpenMobile }), [openMobile, setOpenMobile]);
  return (
    <SidebarContext.Provider value={value}>
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        {children}
      </Sheet>
    </SidebarContext.Provider>
  );
}

/** The menu column. `label` names the phone sheet for screen readers. */
function Sidebar({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & { label: string }) {
  return (
    <>
      <aside data-slot="sidebar" className={cn("lares-sidebar", className)} {...props}>
        {children}
      </aside>
      <SheetContent
        side="left"
        data-slot="sidebar"
        data-mobile="true"
        className={cn("lares-sidebar lares-sidebar-sheet", className)}
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">{label}</SheetTitle>
        {children}
      </SheetContent>
    </>
  );
}

/** The button that opens the phone sheet. It carries the expanded state, and focus returns to it on close. */
function SidebarTrigger({
  children,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <SheetTrigger asChild>
      <Button data-slot="sidebar-trigger" variant="ghost" size="icon" {...props}>
        {children ?? <Menu aria-hidden="true" />}
      </Button>
    </SheetTrigger>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("lares-sidebar-header", className)} {...props} />;
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("lares-sidebar-content", className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("lares-sidebar-footer", className)} {...props} />;
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<"hr">) {
  return <hr data-slot="sidebar-separator" className={cn("lares-sidebar-separator", className)} {...props} />;
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("lares-sidebar-group", className)} {...props} />;
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp data-slot="sidebar-group-label" className={cn("lares-sidebar-group-label", className)} {...props} />;
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group-content" className={cn("lares-sidebar-group-content", className)} {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("lares-sidebar-menu", className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("lares-sidebar-menu-item", className)} {...props} />;
}

/** One menu entry. `asChild` hands the look to a link; `isActive` marks the current page;
    `disabled` draws an entry that is not there yet: plain text, not a link, not focusable. */
function SidebarMenuButton({
  asChild = false,
  isActive = false,
  disabled = false,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean; isActive?: boolean }) {
  if (disabled) {
    return (
      <span data-slot="sidebar-menu-button" data-disabled="true" aria-disabled="true" className={cn("lares-sidebar-menu-button", className)}>
        {children}
      </span>
    );
  }
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive || undefined}
      className={cn("lares-sidebar-menu-button", className)}
      {...props}
    >
      {children}
    </Comp>
  );
}

/** A small tag at the end of a menu entry. */
function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="sidebar-menu-badge" className={cn("lares-sidebar-menu-badge", className)} {...props} />;
}

/** The page area beside the sidebar. */
function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return <main data-slot="sidebar-inset" className={cn("lares-sidebar-inset", className)} {...props} />;
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
