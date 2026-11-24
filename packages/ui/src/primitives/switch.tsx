"use client";

import * as React from "react";
import { cn } from "../utils";
import { Switch as SwitchPrimitive } from "radix-ui";

/** An on/off control that takes effect as you flip it. Name it with `aria-label` or a wrapping label. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={cn("lares-switch", className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="lares-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
