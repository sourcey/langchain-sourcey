import { SourceyRetriever } from "../src/index.js";

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
