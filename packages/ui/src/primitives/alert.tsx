import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";

/** The variant names the meaning; console.css gives each one colour: default is info (blue),
    warning is amber, destructive is the error (red), success is green. */
const alertVariants = cva("lares-alert", {
  variants: {
    variant: {
      default: "",
      warning: "",
      destructive: "",
      success: "",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

/** The message box under Notice. Pages use Notice from patterns, which adds the icon and picks the
    role; use Alert directly only for a message with its own title and description. */
function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("lares-alert-title", className)} {...props} />;
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("lares-alert-description", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
