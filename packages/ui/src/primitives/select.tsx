import * as React from "react";
import { cn } from "../utils";

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(className)} {...props} />;
}

export { Select };
