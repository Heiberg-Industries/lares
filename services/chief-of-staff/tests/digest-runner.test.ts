/**
 * `runDigest` with the article seams: which items are filed as articles, how many model calls a
 * pass may make, and that a runner given none of the new dependencies behaves exactly as before.
 * The collaborators are in-memory fakes; filing itself is covered in `digest-article-file.test.ts`.
 */
import { describe, it, expect } from "vitest";

import { runDigest, type RunnerDeps } from "../lib/digest/runner.js";
import type { EnrichedItem } from "../lib/digest/enrich.js";
import type { FileArticleFn } from "../lib/digest/article-file.js";

const LINK_NOTE = (n: number): string =>
  `---\nurl: https://example.com/post-${n}\ntitle: Post ${n}\nsource: karakeep\n---\n\nMy note ${n}.\n`;

const items = (count: number, make: (n: number) => string = LINK_NOTE) =>
  Array.from({ length: count }, (_, i) => ({ path: `_inbox/item-${String(i).padStart(2, "0")}.md`, body: make(i) }));

/** Pretends the reader opened every note that has a url. */
const enrich = async (item: { path: string; body: string }): Promise<EnrichedItem> => {
  const url = /^url: (\S+)$/m.exec(item.body)?.[1];
  if (!url) return { ...item, enriched: false };
  return { ...item, enriched: true, article: { url, title: "Page title", text: `The page text for ${url}. `.repeat(20) } };
};

const GENERIC_REPLY = JSON.stringify({
  route: "file", type: "reference", project: "", title: "A reference", summary: "S", links: [], reason: "",
});

function setup(over: Partial<RunnerDeps> = {}) {
  const log = {
    llm: [] as string[],
    articles: [] as string[],
    notes: [] as Array<{ destPath: string; body: string }>,
    posted: [] as unknown[],
    filedCallbacks: [] as Array<[string, { area: string; destPath: string }]>,
    enrichCalls: 0,
  };
  const fileArticle: FileArticleFn = async (input) => {
    log.articles.push(input.inboxPath);
    await input.classify();
    return { title: "T", area: "shared", destPath: `articles/${input.inboxPath.split("/").pop()}`, duplicate: false, fellBack: false };
  };
  const deps: RunnerDeps = {
    agent: "agent",
    listInbox: async () => [],
    alreadySkipped: async () => [],
    noteNames: async () => ["some-note"],
    llm: async (prompt) => {
      log.llm.push(prompt);
      return prompt.includes("saved web article")
        ? JSON.stringify({ summary: "S", topics: [], excerpts: [], links: [] })
        : GENERIC_REPLY;
    },
    fileNote: async (o) => {
      log.notes.push({ destPath: o.destPath, body: o.body });
      return { commit: "abc1234" };
    },
    recordSkip: async () => {},
    post: async (view) => {
      log.posted.push(view);
    },
    mode: "on-demand",
    capturedAt: "2026-10-09",
    enrich: async (item) => {
      log.enrichCalls += 1;
      return enrich(item);
    },
    fileArticle,
    onFiled: async (path, filed) => {
      log.filedCallbacks.push([path, filed]);
    },
    ...over,
  };
  return { deps, log };
}

describe("saved links become articles", () => {
  it("files each opened link through fileArticle with one model call, and never as an ordinary note", async () => {
    const { deps, log } = setup({ listInbox: async () => items(3) });
    const summary = await runDigest(deps);

    expect(log.articles).toEqual(["_inbox/item-00.md", "_inbox/item-01.md", "_inbox/item-02.md"]);
    expect(log.llm).toHaveLength(3);
    expect(log.notes).toEqual([]);
    expect(summary.filed).toEqual([
      { title: "T", destination: "articles" },
      { title: "T", destination: "articles" },
      { title: "T", destination: "articles" },
    ]);
    expect(summary.errors).toEqual([]);
  });

  it("puts the owner's own words in front of the model with the page, not instead of it", async () => {
    const { deps, log } = setup({ listInbox: async () => items(1) });
    await runDigest(deps);
    expect(log.llm[0]).toContain("My note 0.");
    expect(log.llm[0]).toContain("The page text for https://example.com/post-0");
  });

  it("reports where each article went", async () => {
    const { deps, log } = setup({ listInbox: async () => items(2) });
    await runDigest(deps);
    expect(log.filedCallbacks).toEqual([
      ["_inbox/item-00.md", { area: "shared", destPath: "articles/item-00.md" }],
      ["_inbox/item-01.md", { area: "shared", destPath: "articles/item-01.md" }],
    ]);
  });

  it("a failing callback never fails the filing", async () => {
    const { deps } = setup({
      listInbox: async () => items(1),
      onFiled: async () => {
        throw new Error("ledger down");
      },
    });
    const summary = await runDigest(deps);
    expect(summary.errors).toEqual([]);
    expect(summary.filed).toHaveLength(1);
  });

  it("one article that fails does not stop the others", async () => {
    const { deps, log } = setup({
      listInbox: async () => items(3),
      fileArticle: async (input) => {
        if (input.inboxPath.endsWith("01.md")) throw new Error("push failed");
        log.articles.push(input.inboxPath);
        await input.classify();
        return { title: "T", area: "shared", destPath: "articles/x.md", duplicate: false, fellBack: false };
      },
    });
    const summary = await runDigest(deps);
    expect(log.articles).toHaveLength(2);
    expect(summary.errors).toEqual([{ path: "_inbox/item-01.md", error: "push failed" }]);
  });
});

describe("the ceiling on model calls per pass", () => {
  it("makes 20 calls, leaves the other 5 untouched in the inbox and tells the owner", async () => {
    const { deps, log } = setup({ listInbox: async () => items(25) });
    const summary = await runDigest(deps);

    expect(log.llm).toHaveLength(20);
    expect(log.articles).toHaveLength(20);
    // The five held back are not even fetched.
    expect(log.enrichCalls).toBe(20);
    expect(summary.filed).toHaveLength(20);
    expect(summary.notices).toContain("5 more saved items will be filed in the next pass.");
  });

  it("a link that is already filed costs nothing, so 25 of them all get retired", async () => {
    const { deps, log } = setup({
      listInbox: async () => items(25),
      fileArticle: async (input) => {
        log.articles.push(input.inboxPath);
        return { title: "T", area: "shared", destPath: "articles/x.md", duplicate: true, fellBack: false };
      },
    });
    const summary = await runDigest(deps);

    expect(log.llm).toHaveLength(0);
    expect(log.articles).toHaveLength(25);
    expect(summary.notices).toEqual([]);
    expect(log.filedCallbacks).toHaveLength(25);
    // Nothing new was filed, so there is nothing to list.
    expect(summary.filed).toEqual([]);
  });

  it("ordinary notes count against the same ceiling", async () => {
    const plain = items(5, (n) => `Just a thought number ${n}.`);
    const { deps, log } = setup({ listInbox: async () => plain, maxClassify: 2 });
    const summary = await runDigest(deps);
    expect(log.llm).toHaveLength(2);
    expect(summary.notices).toContain("3 more saved items will be filed in the next pass.");
  });

  it("says 'item' for exactly one", async () => {
    const { deps } = setup({ listInbox: async () => items(3), maxClassify: 2 });
    expect((await runDigest(deps)).notices).toContain("1 more saved item will be filed in the next pass.");
  });

  it("the ceiling can be changed", async () => {
    const { deps, log } = setup({ listInbox: async () => items(8), maxClassify: 5 });
    await runDigest(deps);
    expect(log.llm).toHaveLength(5);
  });
});

describe("when the shared area is not connected", () => {
  it("tells the owner how many articles went to the private area", async () => {
    const { deps } = setup({
      listInbox: async () => items(3),
      fileArticle: async (input) => {
        await input.classify();
        return { title: "T", area: "private", destPath: "articles/x.md", duplicate: false, fellBack: true };
      },
    });
    const summary = await runDigest(deps);
    expect(summary.notices).toContain("The shared area is not connected, so 3 articles were filed in the private area.");
  });

  it("uses the singular for one", async () => {
    const { deps } = setup({
      listInbox: async () => items(1),
      fileArticle: async (input) => {
        await input.classify();
        return { title: "T", area: "private", destPath: "articles/x.md", duplicate: false, fellBack: true };
      },
    });
    expect((await runDigest(deps)).notices).toContain(
      "The shared area is not connected, so 1 article was filed in the private area.",
    );
  });
});

describe("items that are not articles keep their old path", () => {
  it("a plain note is classified and filed as an ordinary note", async () => {
    const { deps, log } = setup({ listInbox: async () => items(1, () => "Just a thought.") });
    const summary = await runDigest(deps);
    expect(log.articles).toEqual([]);
    expect(log.notes).toHaveLength(1);
    expect(log.notes[0]!.destPath).toBe("reads/a-reference.md");
    expect(summary.filed).toEqual([{ title: "A reference", destination: "reads" }]);
  });

  it("README and already-skipped items are left alone", async () => {
    const { deps, log } = setup({
      listInbox: async () => [
        { path: "_inbox/README.md", body: "x" },
        { path: "_inbox/skipped.md", body: "x" },
        { path: "_inbox/real.md", body: "Just a thought." },
      ],
      alreadySkipped: async () => ["_inbox/skipped.md"],
    });
    await runDigest(deps);
    expect(log.llm).toHaveLength(1);
  });
});

describe("a runner given none of the new dependencies", () => {
  it("classifies and files a fetched page exactly as before, with no ceiling", async () => {
    const { deps, log } = setup({
      listInbox: async () => items(25),
      fileArticle: undefined,
      onFiled: undefined,
    });
    const summary = await runDigest(deps);

    expect(log.llm).toHaveLength(25);
    expect(log.notes).toHaveLength(25);
    // The page text replaces the saved note, with its provenance comment, as it always did.
    expect(log.llm[0]).toContain("The page text for https://example.com/post-0");
    expect(log.llm[0]).not.toContain("My note 0.");
    expect(log.notes[0]!.body).toContain("<!-- source: https://example.com/post-0 -->");
    expect(summary.notices).toEqual([]);
    expect(summary.filed.every((f) => f.destination === "reads")).toBe(true);
  });
});
