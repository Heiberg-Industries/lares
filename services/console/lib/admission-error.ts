/** A failed authority lookup is unavailable, never evidence of a signed-out stranger. */
export class ConsoleAdmissionUnavailableError extends Error {
  constructor() {
    super("Console sign-in storage is unavailable. Try again.");
    this.name = "ConsoleAdmissionUnavailableError";
  }
}
/** Preserve route-specific invalid-session responses and expose only a neutral storage outage. */
export function withConsoleAdmission<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try { return await handler(...args); }
    catch (error) {
      if (error instanceof ConsoleAdmissionUnavailableError) return Response.json(
        { error: "admission-unavailable", message: error.message },
        { status: 503, headers: { "cache-control": "no-store" } });
      throw error;
    }
  };
}
