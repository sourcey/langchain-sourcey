import json

import httpx

from langchain_sourcey import SourceyRetriever
from langchain_sourcey.retrievers import absolutize_url, rank_search_entries, SearchEntry


def test_rank_search_entries_prefers_title_and_deduplicates_page() -> None:
    entries = [
        SearchEntry(
            title="Search",
            content="How Sourcey search works.",
            url="/search.html",
            tab="Docs",
            category="Pages",
        ),
        SearchEntry(
            title="Search internals",
            content="Tokenizer and index implementation details.",
            url="/search.html#internals",
            tab="Docs",
            category="Sections",
        ),
        SearchEntry(
            title="Deploying",
            content="Serve Sourcey output from static hosting.",
            url="/deploying.html",
            tab="Docs",
            category="Pages",
        ),
    ]

    ranked = rank_search_entries(entries, "search", "https://docs.example.com/reference")

    assert len(ranked) == 1
    assert ranked[0].output_path == "search"
    assert ranked[0].source_url == "https://docs.example.com/reference/search.html"


def test_rank_search_entries_dedupes_across_url_styles() -> None:
    entries = [
        SearchEntry(title="Search", content="one", url="/search.html", tab="Docs", category="Pages"),
        SearchEntry(title="Search", content="two", url="/search/", tab="Docs", category="Pages"),
        SearchEntry(title="Search", content="three", url="/search", tab="Docs", category="Pages"),
    ]

    ranked = rank_search_entries(entries, "search", "https://docs.example.com")

    assert len(ranked) == 1
    assert ranked[0].output_path == "search"


def test_retriever_hydrates_from_llms_full() -> None:
    search_index = [
        {
            "title": "Search",
            "content": "Find docs quickly.",
            "url": "/search.html",
            "tab": "Docs",
            "category": "Pages",
        },
        {
            "title": "Deploying",
            "content": "Host Sourcey output anywhere.",
            "url": "/deploying.html",
            "tab": "Docs",
            "category": "Pages",
        },
    ]
    llms_full = """
# Example Docs

## Docs

### Search

Path: `search.html`

Search docs explain how the index works and how the dialog ranks results.

### Deploying

Path: `deploying.html`

Deploy Sourcey output to any static host.
""".strip()

    transport = httpx.MockTransport(
        lambda request: _route_request(
            request,
            {
                "https://docs.example.com/reference/search-index.json": httpx.Response(
                    200, text=json.dumps(search_index)
                ),
                "https://docs.example.com/reference/llms-full.txt": httpx.Response(
                    200, text=llms_full
                ),
            },
        )
    )

    retriever = SourceyRetriever(
        site_url="https://docs.example.com/reference",
        top_k=1,
        transport=transport,
    )

    docs = retriever.invoke("how does search work")

    assert len(docs) == 1
    assert "dialog ranks results" in docs[0].page_content
    assert docs[0].metadata["source"] == "https://docs.example.com/reference/search.html"
    assert docs[0].metadata["path"] == "search"


def test_retriever_falls_back_to_html_when_llms_full_missing() -> None:
    search_index = [
        {
            "title": "Deploying",
            "content": "Host Sourcey output anywhere.",
            "url": "/deploying.html",
            "tab": "Docs",
            "category": "Pages",
        },
    ]
    html_page = """
<html>
  <body>
    <main>
      <h1>Deploying</h1>
      <p>Deploy Sourcey output to any static host.</p>
    </main>
  </body>
</html>
""".strip()

    transport = httpx.MockTransport(
        lambda request: _route_request(
            request,
            {
                "https://docs.example.com/reference/search-index.json": httpx.Response(
                    200, text=json.dumps(search_index)
                ),
                "https://docs.example.com/reference/llms-full.txt": httpx.Response(404),
                "https://docs.example.com/reference/deploying.html": httpx.Response(
                    200, text=html_page
                ),
            },
        )
    )

    retriever = SourceyRetriever(
        site_url="https://docs.example.com/reference",
        top_k=1,
        transport=transport,
    )

    docs = retriever.invoke("deploy")

    assert len(docs) == 1
    assert docs[0].page_content == "Deploying Deploy Sourcey output to any static host."
    assert docs[0].metadata["source"] == "https://docs.example.com/reference/deploying.html"


def test_absolutize_url_preserves_docs_mount_path() -> None:
    assert (
        absolutize_url("/api/index.html", "https://sourcey.com/cheesestore")
        == "https://sourcey.com/cheesestore/api/index.html"
    )


def test_rank_search_entries_ignores_generic_stopwords() -> None:
    entries = [
        SearchEntry(
            title="How slugs work",
            content="Routing details for tabs and pages.",
            url="/guides/guide-multi-tab-sites.html#how-slugs-work",
            tab="Docs",
            category="Sections",
        ),
        SearchEntry(
            title="Search",
            content="Search docs explain how the index works.",
            url="/search.html",
            tab="Docs",
            category="Pages",
        ),
    ]

    ranked = rank_search_entries(entries, "how does search work", "https://sourcey.com/docs")

    assert ranked
    assert ranked[0].entry.title == "Search"


def _route_request(request: httpx.Request, responses: dict[str, httpx.Response]) -> httpx.Response:
    response = responses.get(str(request.url))
    if response is None:
        return httpx.Response(404, request=request)
    response.request = request
    return response
