import { describe, expect, it } from "vitest";
import { connectorReach, foundSentence, nextActionWords, stateTone, stateWords } from "../lib/outside-connector-words";

const connected = { state: "connected" as const };

it("says one sentence per kind of server, and names the next step", () => {
  expect(foundSentence("none")).toBe("Found the server. It needs no login.");
  expect(foundSentence("signin")).toContain("later release");
  expect(stateWords("setup", "token", 0, connected)).toBe("Setting up");
  expect(stateWords("connected", "token", 2, connected)).toBe("Connected");
  expect(stateWords("connected", "signin", 0, connected)).toBe("Sign-in comes later");
  expect(nextActionWords("setup", "token", 0)).toBe("Choose who can use it");
});

describe("Connected means the change reached the agent, not that an agent has it saved", () => {
  const uses = [{ agent: "first", displayName: "First" }, { agent: "second", displayName: "Second" }];

  it("is Connected only when every agent that has it runs it as saved", () => {
    const reach = connectorReach("rates", uses, { first: { rates: "applied" }, second: { rates: "applied" } });
    expect(reach).toEqual({ state: "connected" });
    expect(stateWords("connected", "token", 2, reach)).toBe("Connected");
    expect(stateTone("connected", "token", 2, reach)).toBe("success");
  });

  it("reads a saved choice that is not applied as Waiting, with why and what to press", () => {
    const reach = connectorReach("rates", uses, { first: { rates: "applied" }, second: { rates: "pending" } });
    expect(reach.state).toBe("waiting");
    expect(reach.why).toBe("Saved for Second, not applied yet. It takes effect when the agent restarts with Apply in Edit agent.");
    expect(stateWords("connected", "token", 2, reach)).toBe("Waiting");
    expect(stateTone("connected", "token", 2, reach)).toBe("attention");
  });

  it("reads a connection waiting for its token as Waiting", () => {
    const reach = connectorReach("rates", uses, { first: { rates: "waiting-key" }, second: { rates: "applied" } });
    expect(reach).toEqual({ state: "waiting", why: "Waiting for its token for First." });
  });

  it("reads an agent the keeper cannot tell about as Failed, with why", () => {
    const reach = connectorReach("rates", uses, { first: { rates: "unavailable" }, second: { rates: "pending" } });
    expect(reach.state).toBe("failed");
    expect(reach.why).toContain("Lares cannot tell whether First uses it, because it has not been started with a saved definition yet.");
    expect(stateWords("connected", "token", 2, reach)).toBe("Failed");
    expect(stateTone("connected", "token", 2, reach)).toBe("error");
  });

  it("claims nothing when the states could not be read, for all agents or for one", () => {
    expect(stateWords("connected", "token", 2, connectorReach("rates", uses, null))).toBe("Status unavailable");
    expect(connectorReach("rates", uses, { first: { rates: "applied" } })).toEqual({ state: "unknown", why: "Whether it reached Second could not be read just now." });
  });

  it("keeps the words for a connector nobody uses, and for sign-in servers", () => {
    expect(stateWords("connected", "token", 0, connectorReach("rates", [], {}))).toBe("Not used yet");
    expect(stateWords("connected", "signin", 2, connectorReach("rates", uses, null))).toBe("Sign-in comes later");
  });
});
