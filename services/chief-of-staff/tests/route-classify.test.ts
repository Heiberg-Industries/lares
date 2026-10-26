import { describe, it, expect } from "vitest";
import { makeRouteClassifier, type RouteActivity } from "../lib/route-classify.js";

const tracks = [
  { id: "acme", name: "Acme", purpose: "first made-up workflow", steps: ["new", "meeting", "done"], closingSteps: ["done"] },
  { id: "beta", name: "Beta", purpose: "second workflow", steps: ["start", "complete"], closingSteps: ["complete"] },
];

function capture() {
  const prompts: string[] = [];
  const llm = async (p: string) => {
    prompts.push(p);
    return '{"brand":null,"stage":null,"action":"none","confidence":0,"reasoning":"x"}';
  };
  return { prompts, llm };
}

function email(body: string): RouteActivity {
  return { personHandle: "someone@agency.example", kind: "email", subject: "Hello", body, at: "2026-10-19T08:00:00Z" };
}

describe("route classifier prompt", () => {
  it("never lets quoted reply text reach the prompt", async () => {
    const { prompts, llm } = capture();
    const body = [
      "Can we talk next week?",
      "",
      "On Mon, 12 Oct 2026, Owner <owner@example.com> wrote:",
      "Best regards, QUOTED-SIGNATURE-ACME",
      "> QUOTED-LINE-ACME",
    ].join("\n");
    await makeRouteClassifier({ llm }).classify({ activity: [email(body)], openOpportunities: [], tracks });
    expect(prompts[0]).toContain("Can we talk next week?");
    expect(prompts[0]).not.toContain("QUOTED-SIGNATURE-ACME");
    expect(prompts[0]).not.toContain("QUOTED-LINE-ACME");
  });

  it("states the self-signature rule and lists the owner's handles and domains", async () => {
    const { prompts, llm } = capture();
    await makeRouteClassifier({
      llm,
      selfHandles: ["owner@example.com", "Owner@Work.example"],
      selfDomains: ["example.org"],
    }).classify({ activity: [email("Hi")], openOpportunities: [], tracks });
    const p = prompts[0]!;
    expect(p).toContain("The owner's own name, signature, addresses and domains are never evidence for a track.");
    expect(p).toContain("owner@example.com");
    expect(p).toContain("owner@work.example");
    expect(p).toContain("example.com");
    expect(p).toContain("work.example");
    expect(p).toContain("example.org");
  });

  it("still states the rule when no owner handles are known", async () => {
    const { prompts, llm } = capture();
    await makeRouteClassifier({ llm }).classify({ activity: [email("Hi")], openOpportunities: [], tracks });
    expect(prompts[0]).toContain("never evidence for a track");
  });
});
