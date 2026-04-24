# langchain-sourcey

[![PyPI - Version](https://img.shields.io/pypi/v/langchain-sourcey?label=%20)](https://pypi.org/project/langchain-sourcey/)
[![PyPI - Downloads](https://img.shields.io/pepy/dt/langchain-sourcey)](https://pypistats.org/packages/langchain-sourcey)
[![PyPI - License](https://img.shields.io/pypi/l/langchain-sourcey)](https://pypi.org/project/langchain-sourcey/)
[![CI](https://github.com/sourcey/langchain-sourcey/actions/workflows/ci.yml/badge.svg)](https://github.com/sourcey/langchain-sourcey/actions/workflows/ci.yml)

`langchain-sourcey` is the native LangChain retriever for Sourcey-generated
documentation sites.

It turns a published Sourcey docs root into a LangChain knowledge source
without a private indexing service or ingestion pipeline. The retriever works
directly against Sourcey's public artefacts:

- `search-index.json` for candidate discovery
- `llms-full.txt` for full-page hydration
- canonical page URLs for citations

## Why this integration is a good LangChain fit

- No credentials required for public docs sites
- Retrieval works against static hosting, subpath deployments, and GitHub Pages
- Returned `Document` objects carry canonical `metadata["source"]` URLs
- `llms-full.txt` gives cleaner full-page content than scraping rendered HTML
- If `llms-full.txt` is missing, the retriever falls back to page HTML

## Install

```bash
pip install -U langchain-sourcey
```

Point `site_url` at the root of a published Sourcey build, for example
`https://sourcey.com/docs` or `https://sourcey.com/cheesestore`.

## Quickstart

```python
from langchain_sourcey import SourceyRetriever

retriever = SourceyRetriever(
    site_url="https://sourcey.com/docs",
    top_k=3,
)

docs = retriever.invoke("mcp integration")

for doc in docs:
    print(doc.metadata["title"])
    print(doc.metadata["source"])
    print(doc.page_content[:160])
    print()
```

For a runnable script, see [examples/live_quickstart.py](examples/live_quickstart.py).

## Use In A LangChain Chain

Install a chat model integration of your choice. This example uses OpenAI:

```bash
pip install -U langchain-openai
```

```python
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_openai import ChatOpenAI

from langchain_sourcey import SourceyRetriever

retriever = SourceyRetriever(site_url="https://sourcey.com/docs", top_k=3)

prompt = ChatPromptTemplate.from_template(
    """Answer the question using the documentation context below.

{context}

Question: {question}"""
)

chain = (
    RunnablePassthrough.assign(context=(lambda x: x["question"]) | retriever)
    | prompt
    | ChatOpenAI(model="gpt-4.1-mini")
    | StrOutputParser()
)

answer = chain.invoke({"question": "How does Sourcey document MCP servers?"})
print(answer)
```

For a fuller example, see [examples/rag_chain.py](examples/rag_chain.py).

## Sourcey Site Contract

For best results, the published Sourcey site should:

- publish `search-index.json`
- publish `llms-full.txt`
- set `siteUrl` in `sourcey.config.ts` so citations are canonical

`search-index.json` is required. `llms-full.txt` is strongly recommended because
it lets the retriever return full page content instead of HTML-derived fallback
text.

## Returned Metadata

Each returned `Document` includes:

- `source`: canonical page URL used for citations
- `matched_url`: original matched URL, including anchors when relevant
- `matched_title`: matched search entry title
- `title`: hydrated page title
- `path`: Sourcey output path such as `guides/search.html`
- `anchor`: matched fragment, if any
- `tab`: Sourcey tab label
- `category`: Sourcey search category
- `site_url`: docs root used for retrieval
- `score`: retriever ranking score

## Development

```bash
python -m pip install -e .[dev] build twine
PYTHONPATH=src pytest -q
SOURCEY_TEST_SITE_URL=https://sourcey.com/docs PYTHONPATH=src pytest tests/integration_tests/test_live_retriever.py -q
python -m build
python -m twine check dist/*
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release and verification flow.

## LangChain Submission Assets

This repo includes draft docs ready to turn into a LangChain docs PR:

- [docs/langchain/provider-sourcey.mdx](docs/langchain/provider-sourcey.mdx)
- [docs/langchain/retriever-sourcey.mdx](docs/langchain/retriever-sourcey.mdx)

## Scope

This package intentionally ships `SourceyRetriever` only. A document loader is
deferred until the retriever proves enough demand to justify the maintenance
surface.
