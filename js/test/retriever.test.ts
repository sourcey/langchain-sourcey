import { describe, expect, it } from "vitest";

import {
  SourceyRetriever,
  absolutizeUrl,
  extractTextFromHtml,
  parseLlmsFullText,
  rankSearchEntries,
  type SearchEntry,
} from "../src/retriever.js";

describe("parseLlmsFullText", () => {
  it("extracts pages by path", () => {
    const payload = `
# Example Docs

## Guides

### Search

Path: \`guides/search.html\`

Search docs explain how the index works.

### Search internals

This heading belongs to the page content and should not start a new page.

### API Reference

Path: \`api/index.html\`

GET /search
Returns indexed results.
`.trim();

    const pages = parseLlmsFullText(payload);

    expect(Object.keys(pages).sort()).toEqual([
      "api/index.html",
      "guides/search.html",
    ]);
    expect(pages["guides/search.html"]?.content).toContain(
      "This heading belongs to the page content"
    );
    expect(pages["api/index.html"]?.title).toBe("API Reference");
  });
});

describe("extractTextFromHtml", () => {
  it("strips tags and scripts", () => {
    const payload = `
<html>
  <head><script>console.log("ignore");</script></head>
  <body><main><h1>Search</h1><p>Find docs fast.</p></main></body>
</html>
`.trim();

    expect(extractTextFromHtml(payload)).toBe("Search Find docs fast.");
  });
});

describe("rankSearchEntries", () => {
  it("prefers title matches and deduplicates pages", () => {
    const entries: SearchEntry[] = [
      {
        title: "Search",
        content: "How Sourcey search works.",
        url: "/search.html",
        tab: "Docs",
        category: "Pages",
      },
      {
        title: "Search internals",
        content: "Tokenizer and index implementation details.",
        url: "/search.html#internals",
        tab: "Docs",
        category: "Sections",
      },
      {
        title: "Deploying",
        content: "Serve Sourcey output from static hosting.",
        url: "/deploying.html",
        tab: "Docs",
        category: "Pages",
      },
    ];

    const ranked = rankSearchEntries(
      entries,
      "search",
      "https://docs.example.com/reference"
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.outputPath).toBe("search.html");
    expect(ranked[0]?.sourceUrl).toBe(
      "https://docs.example.com/reference/search.html"
    );
  });

  it("ignores generic stopwords", () => {
    const entries: SearchEntry[] = [
      {
        title: "How slugs work",
        content: "Routing details for tabs and pages.",
        url: "/guides/guide-multi-tab-sites.html#how-slugs-work",
        tab: "Docs",
        category: "Sections",
      },
      {
        title: "Search",
        content: "Search docs explain how the index works.",
        url: "/search.html",
        tab: "Docs",
        category: "Pages",
      },
    ];

    const ranked = rankSearchEntries(
      entries,
      "how does search work",
      "https://sourcey.com/docs"
    );

    expect(ranked[0]?.entry.title).toBe("Search");
  });
});

describe("absolutizeUrl", () => {
  it("preserves docs mount paths", () => {
    expect(
      absolutizeUrl("/api/index.html", "https://sourcey.com/cheesestore")
    ).toBe("https://sourcey.com/cheesestore/api/index.html");
  });
});

describe("SourceyRetriever", () => {
  it("hydrates from llms-full.txt", async () => {
    const searchIndex = [
      {
        title: "Search",
        content: "Find docs quickly.",
        url: "/search.html",
        tab: "Docs",
        category: "Pages",
      },
      {
        title: "Deploying",
        content: "Host Sourcey output anywhere.",
        url: "/deploying.html",
        tab: "Docs",
        category: "Pages",
      },
    ];
    const llmsFull = `
# Example Docs

## Docs

### Search

Path: \`search.html\`

Search docs explain how the index works and how the dialog ranks results.

### Deploying

Path: \`deploying.html\`

Deploy Sourcey output to any static host.
`.trim();

    const retriever = new SourceyRetriever({
      siteUrl: "https://docs.example.com/reference",
      topK: 1,
      fetch: routeRequest({
        "https://docs.example.com/reference/search-index.json": jsonResponse(
          searchIndex
        ),
        "https://docs.example.com/reference/llms-full.txt": textResponse(
          llmsFull
        ),
      }),
    });

    const docs = await retriever.invoke("how does search work");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.pageContent).toContain("dialog ranks results");
    expect(docs[0]?.metadata.source).toBe(
      "https://docs.example.com/reference/search.html"
    );
    expect(docs[0]?.metadata.path).toBe("search.html");
  });

  it("falls back to html when llms-full.txt is missing", async () => {
    const searchIndex = [
      {
        title: "Deploying",
        content: "Host Sourcey output anywhere.",
        url: "/deploying.html",
        tab: "Docs",
        category: "Pages",
      },
    ];
    const htmlPage = `
<html>
  <body>
    <main>
      <h1>Deploying</h1>
      <p>Deploy Sourcey output to any static host.</p>
    </main>
  </body>
</html>
`.trim();

    const retriever = new SourceyRetriever({
      siteUrl: "https://docs.example.com/reference",
      topK: 1,
      fetch: routeRequest({
        "https://docs.example.com/reference/search-index.json": jsonResponse(
          searchIndex
        ),
        "https://docs.example.com/reference/llms-full.txt": {
          status: 404,
          body: "",
        },
        "https://docs.example.com/reference/deploying.html": textResponse(
          htmlPage
        ),
      }),
    });

    const docs = await retriever.invoke("deploy");

    expect(docs).toHaveLength(1);
    expect(docs[0]?.pageContent).toBe(
      "Deploying Deploy Sourcey output to any static host."
    );
    expect(docs[0]?.metadata.source).toBe(
      "https://docs.example.com/reference/deploying.html"
    );
  });

  const siteUrl = process.env.SOURCEY_TEST_SITE_URL;
  const maybeIt = siteUrl ? it : it.skip;

  maybeIt("retrieves from a live Sourcey site", async () => {
    const retriever = new SourceyRetriever({
      siteUrl: siteUrl!,
      topK: 2,
    });

    const docs = await retriever.invoke("search");

    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((doc) => doc.metadata.source.startsWith("http"))).toBe(
      true
    );
    expect(docs.every((doc) => doc.pageContent.length > 0)).toBe(true);
  });
});

interface MockResponse {
  status: number;
  body: string;
  headers?: HeadersInit;
}

function jsonResponse(payload: unknown): MockResponse {
  return {
    status: 200,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  };
}

function textResponse(body: string): MockResponse {
  return {
    status: 200,
    body,
    headers: { "content-type": "text/plain; charset=utf-8" },
  };
}

function routeRequest(
  responses: Record<string, MockResponse>
): (input: string | URL) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    const response = responses[url];

    if (!response) {
      return new Response("", { status: 404 });
    }

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
}
