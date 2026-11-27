// When a piece of background work last did something, in the words every status line uses
// ("today at 14:03", "on 2026-11-20 at 08:00"), on the owner's clock. One place, so Writing style,
// Deadlines and an agent's Schedules tab say a time the same way (ADR 0031).
import { formatInOwnerTz, ownerDayIn } from "./proactivity";

export function runWhen(at: Date, now: Date, tz: string): string {
  const [day, time] = formatInOwnerTz(at, tz).split(" ");
  return day === ownerDayIn(now, tz) ? `today at ${time}` : `on ${day} at ${time}`;
}
