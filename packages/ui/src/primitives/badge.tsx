import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";
import { Slot } from "radix-ui";

/** The variant names the status; console.css gives each its text colour and background. */
const badgeVariants = cva("lares-badge", {
  variants: {
    variant: {
      neutral: "",
      success: "",
      warning: "",
      error: "",
      info: "",
      accent: "",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
});

/** A small pill that states a status in a word or two, with a dot in the same colour. */
function Badge({
  className,
  variant = "neutral",
  dot = true,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean; dot?: boolean }) {
  if (asChild) {
    return (
      <Slot.Root data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <span data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span data-slot="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
