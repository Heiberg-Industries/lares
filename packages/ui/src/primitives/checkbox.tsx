import * as React from "react";
import { cn } from "../utils";

type ChoiceProps = Omit<React.ComponentProps<"input">, "type">;

function Checkbox({ className, ...props }: ChoiceProps) {
  return <input type="checkbox" data-slot="checkbox" className={cn(className)} {...props} />;
}

function Radio({ className, ...props }: ChoiceProps) {
  return <input type="radio" data-slot="radio" className={cn(className)} {...props} />;
}

export { Checkbox, Radio };
