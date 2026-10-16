/** Display names for schedule keys; the saved keys remain unchanged. */
export function scheduleLabel(key: string): string {
  return key
    .split("-")
    .map((part) => part === "crm" ? "CRM" : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
