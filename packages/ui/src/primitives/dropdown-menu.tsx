"use client";
import * as React from "react";
import { DropdownMenu } from "radix-ui";
import { cn } from "../utils";
export const Root = DropdownMenu.Root;
export const Trigger = DropdownMenu.Trigger;
export const Portal = DropdownMenu.Portal;
export const Label = ({ className, ...props }: React.ComponentProps<typeof DropdownMenu.Label>) =>
  <DropdownMenu.Label className={cn("lares-menu-label", className)} {...props} />;
export const Separator = ({ className, ...props }: React.ComponentProps<typeof DropdownMenu.Separator>) =>
  <DropdownMenu.Separator className={cn("lares-menu-separator", className)} {...props} />;
export const Content = ({ className, sideOffset = 6, align = "end", ...props }: React.ComponentProps<typeof DropdownMenu.Content>) =>
  <DropdownMenu.Portal><DropdownMenu.Content sideOffset={sideOffset} align={align} className={cn("lares-menu", className)} {...props} /></DropdownMenu.Portal>;
export const Item = ({ className, ...props }: React.ComponentProps<typeof DropdownMenu.Item>) =>
  <DropdownMenu.Item className={cn("lares-menu-item", className)} {...props} />;
