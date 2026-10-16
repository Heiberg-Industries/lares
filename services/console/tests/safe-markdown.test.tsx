import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript } from "../components/ChatTranscript";
import type { EveMessage } from "eve/react";

const message = (role: "user" | "assistant", text: string): EveMessage =>
  ({ id: "m", role, parts: [{ type: "text", text }] } as unknown as EveMessage);

const render = (role: "user" | "assistant", text: string) =>
  renderToStaticMarkup(<ChatTranscript status="ready" messages={[message(role, text)]} />);

const cardWith = (input: unknown): EveMessage =>
  ({
    id: "c",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: "call_1",
        toolName: "gmail_send",
        state: "approval-requested",
        approval: { id: "appr_1" },
        input,
        toolMetadata: {
          eve: {
            kind: "tool-call",
            name: "gmail_send",
            inputRequest: {
              requestId: "req_A",
              kind: "tool-approval",
              display: "confirmation",
              allowFreeform: false,
              prompt: "Send an email",
              options: [{ id: "approve", label: "Approve" }],
            },
          },
        },
      },
    ],
  }) as unknown as EveMessage;

describe("formatting in agent replies", () => {
  it("shows bold, a list and an https link as real elements", () => {
    const html = render("assistant", "**File the annual report**\n\n- first\n- second\n\n1. one\n2. two\n\nSee [the site](https://example.com/a?b=1).");
    expect(html).toContain("<strong>File the annual report</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<ol");
    expect(html).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain("**");
  });

  it("shows italic, inline code, a code block, a heading and line breaks", () => {
    const html = render("assistant", "# Title\nline one\nline two with *soft* and `code`\n\n```\nlet a = <b>;\n```");
    expect(html).toContain('role="heading"');
    expect(html).toContain("<br/>");
    expect(html).toContain("<em>soft</em>");
    expect(html).toContain("code</code>");
    expect(html).toContain("let a = &lt;b&gt;;");
  });

  it("renders raw HTML in a reply as text, never as markup", () => {
    const html = render("assistant", "<img src=x onerror=alert(1)> <script>alert(2)</script> <b>x</b>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not turn javascript:, data: or other non-web links into anchors", () => {
    for (const bad of [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](data:text/html;base64,AAAA)",
      "[x](vbscript:msgbox)",
      "[x](/relative/path)",
      "[x](//evil.example/x)",
      "[x](java\tscript:alert(1))",
    ]) {
      const html = render("assistant", bad);
      expect(html, bad).not.toMatch(/<a[ >]/);
      expect(html, bad).not.toContain("href=");
    }
    expect(render("assistant", "[x](javascript:alert(1))")).toContain("[x](javascript:alert(1))");
  });

  it("does not auto-link bare addresses, and allows mailto links", () => {
    expect(render("assistant", "visit https://example.com now")).not.toMatch(/<a[ >]/);
    expect(render("assistant", "[mail me](mailto:a@example.com)")).toContain('href="mailto:a@example.com"');
  });

  it("leaves the owner's own messages as plain text", () => {
    const html = render("user", "**not bold** - not a list");
    expect(html).toContain("**not bold**");
    expect(html).not.toContain("<strong>");
  });

  it("keeps approval card fields plain text even when they contain markdown", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        status="ready"
        messages={[cardWith({ bodyText: "**bold** [x](https://example.com) <b>hi</b>", to: ["a@example.invalid"] })]}
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain("**bold** [x](https://example.com) &lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<a ");
  });
});
