# langchain-sourcey

Build your own Ask AI on top of a published Sourcey docs site.

`langchain-sourcey` is the retrieval layer behind that feature.

Sourcey already emits the files a retriever needs:

- `search-index.json` for candidate discovery
- `llms-full.txt` for full-page hydration
- canonical page URLs for citations

No hosted index is required. Point `siteUrl` at the docs root and use it.

## Install

`npm`

```bash
npm install langchain-sourcey @langchain/core
```

`yarn`

```bash
yarn add langchain-sourcey @langchain/core
```

`pnpm`

```bash
pnpm add langchain-sourcey @langchain/core
```

## Quickstart

```typescript
import { SourceyRetriever } from "langchain-sourcey";

const retriever = new SourceyRetriever({
  siteUrl: "https://sourcey.com/docs",
  topK: 3,
});

const docs = await retriever.invoke("mcp integration");

for (const doc of docs) {
  console.log(doc.metadata.title);
  console.log(doc.metadata.source);
  console.log(doc.pageContent.slice(0, 160));
  console.log();
}
```

For a runnable script, see [examples/live-quickstart.ts](examples/live-quickstart.ts).

More context: `https://sourcey.com/docs/guides/guide-langchain-retriever`

## Implement Ask AI

Install a chat model package. This example uses OpenAI:

`npm`

```bash
npm install @langchain/openai
```

`yarn`

```bash
yarn add @langchain/openai
```

`pnpm`

```bash
pnpm add @langchain/openai
```

```typescript
import { StringOutputParser } from "@langchain/core/output_parsers";
import type { Document } from "@langchain/core/documents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnablePassthrough, RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { SourceyRetriever } from "langchain-sourcey";

const retriever = new SourceyRetriever({
  siteUrl: "https://sourcey.com/docs",
  topK: 3,
});

const prompt = ChatPromptTemplate.fromTemplate(
  `Answer the question using the documentation context below.

{context}

Question: {question}`
);

const formatDocs = (docs: Document[]) =>
  docs.map((doc) => doc.pageContent).join("\n\n");

const chain = RunnableSequence.from([
  {
    context: retriever.pipe(formatDocs),
    question: new RunnablePassthrough(),
  },
  prompt,
  new ChatOpenAI({ model: "gpt-4.1-mini" }),
  new StringOutputParser(),
]);

const answer = await chain.invoke("How does Sourcey document MCP servers?");

console.log(answer);
```

For a fuller example, see [examples/rag-chain.ts](examples/rag-chain.ts).

## What Has To Exist

For clean retrieval, the published Sourcey site should expose:

- publish `search-index.json`
- publish `llms-full.txt`
- set `siteUrl` in `sourcey.config.ts` so citations are canonical

`search-index.json` is required.

`llms-full.txt` is strongly recommended. If it is missing, the retriever falls
back to the matched page HTML.
