import { StringOutputParser } from "@langchain/core/output_parsers";
import type { Document } from "@langchain/core/documents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnablePassthrough, RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";

import { SourceyRetriever } from "../src/index.js";

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
