import { expect, it } from "vitest";
import { foundSentence, nextActionWords, stateWords } from "../lib/outside-connector-words";

it("says one sentence per kind of server, and names the next step", () => {
  expect(foundSentence("none")).toBe("Found the server. It needs no login.");
  expect(foundSentence("signin")).toContain("later release");
  expect(stateWords("setup", "token", 0)).toBe("Setting up");
  expect(stateWords("connected", "token", 2)).toBe("Connected");
  expect(stateWords("connected", "signin", 0)).toBe("Sign-in comes later");
  expect(nextActionWords("setup", "token", 0)).toBe("Choose who can use it");
});
