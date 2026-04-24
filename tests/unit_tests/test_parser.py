from langchain_sourcey.retrievers import extract_text_from_html, parse_llms_full_text


def test_parse_llms_full_text_extracts_pages_by_path() -> None:
    payload = """
# Example Docs

## Guides

### Search

Path: `guides/search.html`

Search docs explain how the index works.

### Search internals

This heading belongs to the page content and should not start a new page.

### API Reference

Path: `api/index.html`

GET /search
Returns indexed results.
""".strip()

    pages = parse_llms_full_text(payload)

    assert set(pages) == {"guides/search", "api"}
    assert "This heading belongs to the page content" in pages["guides/search"].content
    assert pages["api"].title == "API Reference"


def test_parse_llms_full_text_canonicalises_pretty_url_paths() -> None:
    for path in ("guides/search.html", "/guides/search/", "/guides/search"):
        payload = f"### Search\n\nPath: `{path}`\n\nbody line\n".strip()
        pages = parse_llms_full_text(payload)
        assert set(pages) == {"guides/search"}, f"failed for {path!r}"


def test_extract_text_from_html_strips_tags_and_scripts() -> None:
    payload = """
<html>
  <head><script>console.log("ignore");</script></head>
  <body><main><h1>Search</h1><p>Find docs fast.</p></main></body>
</html>
""".strip()

    assert extract_text_from_html(payload) == "Search Find docs fast."

