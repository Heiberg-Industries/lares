"use client";

import * as React from "react";
import { Plus, X } from "../icons";
import { cn } from "../utils";
import { Button } from "./button";
import { Input } from "./input";

/** A list typed as one box per value, with a remove button beside each box and an Add button under them.
    It only holds what is typed: the caller keeps the values and decides how they are stored. A box left
    empty is still in `values`; the caller drops it when saving. `fixed` shows the boxes without Add and
    remove, for a list that always has the same number of values. */
function ListEditor({
  label,
  values,
  onChange,
  addLabel = "Add",
  size = "default",
  fixed = false,
  disabled = false,
  max,
  inputMode,
  placeholder,
  className,
}: {
  /** Names the group, and each box as "<label> 1", "<label> 2". */
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  addLabel?: string;
  /** "short" is for numbers and other few-character values. */
  size?: "default" | "short";
  fixed?: boolean;
  disabled?: boolean;
  /** The most values the list may hold; Add is unavailable once it is reached. */
  max?: number;
  inputMode?: React.ComponentProps<"input">["inputMode"];
  placeholder?: string;
  className?: string;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  // Where focus goes after the list changes: the box that was just added, or the neighbour of a removed one.
  const focusNext = React.useRef<number | "add" | null>(null);
  React.useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const element = target === "add"
      ? root.current?.querySelector<HTMLElement>('[data-slot="list-editor-add"]')
      : root.current?.querySelectorAll<HTMLElement>('[data-slot="input"]')[target];
    element?.focus();
  }, [values.length]);

  const full = max !== undefined && values.length >= max;
  return (
    <div ref={root} role="group" aria-label={label} data-slot="list-editor" data-size={size} className={cn("lares-list-editor", className)}>
      {values.length > 0 && (
        <ul className="lares-list-editor-items">
          {values.map((value, index) => (
            // The position is the identity: two boxes may hold the same text while it is being typed.
            <li key={index}>
              <Input
                type="text"
                autoComplete="off"
                spellCheck={false}
                inputMode={inputMode}
                placeholder={placeholder}
                aria-label={`${label} ${index + 1}`}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(values.map((old, i) => (i === index ? event.target.value : old)))}
              />
              {!fixed && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`Remove ${value.trim() || `${label} ${index + 1}`}`}
                  onClick={() => {
                    focusNext.current = values.length === 1 ? "add" : Math.min(index, values.length - 2);
                    onChange(values.filter((_, i) => i !== index));
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!fixed && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="list-editor-add"
          disabled={disabled || full}
          onClick={() => {
            focusNext.current = values.length;
            onChange([...values, ""]);
          }}
        >
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}

export { ListEditor };
