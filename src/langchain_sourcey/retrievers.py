from __future__ import annotations

from dataclasses import dataclass
import html
import json
import re
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import Field, PrivateAttr, field_validator

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_PATH_LINE_RE = re.compile(r"^Path:\s*`([^`]+)`\s*$")
_SCRIPT_STYLE_RE = re.compile(r"<(?:script|style)\b.*?>.*?</(?:script|style)>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_STOPWORDS = {
    "a",
    "an",
    "all",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "do",
    "does",
    "for",
    "from",
    "get",
    "how",
    "i",
    "in",
    "into",
    "is",
    "it",
    "list",
    "of",
    "on",
    "or",
    "the",
    "to",
    "what",
    "with",
    "work",
    "works",
}


class SourceyRetrievalError(RuntimeError):
    """Raised when Sourcey retriever setup or artefact fetching fails."""


@dataclass(slots=True)
class SearchEntry:
    title: str
    content: str
    url: str
    tab: str
    category: str
    featured: bool = False
    method: str | None = None
    path: str | None = None


@dataclass(slots=True)
class ParsedPage:
    title: str
    path: str
    content: str


@dataclass(slots=True)
class Candidate:
    entry: SearchEntry
    score: float
    source_url: str
    matched_url: str
    output_path: str
    anchor: str


class SourceyRetriever(BaseRetriever):
    """Retrieve Sourcey-generated docs via public build artefacts."""

    site_url: str
    top_k: int = Field(default=6, gt=0)
    timeout: float = Field(default=10.0, gt=0)
    use_llms_full: bool = True
    user_agent: str = "langchain-sourcey/0.1.6"
    headers: dict[str, str] = Field(default_factory=dict)
    transport: httpx.BaseTransport | None = Field(default=None, exclude=True, repr=False)

    _search_entries: list[SearchEntry] | None = PrivateAttr(default=None)
    _page_map: dict[str, ParsedPage] | None = PrivateAttr(default=None)

    @field_validator("site_url")
    @classmethod
    def validate_site_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("site_url must be an absolute http(s) URL")
        return value.rstrip("/")

    def refresh(self) -> None:
        """Clear any cached Sourcey artefacts."""

        self._search_entries = None
        self._page_map = None

    def _get_relevant_documents(self, query: str, *, run_manager: Any) -> list[Document]:
        del run_manager
        entries = self._load_search_entries()
        candidates = rank_search_entries(entries, query, self.site_url)
        hydrated = self._hydrate_candidates(candidates[: self.top_k])
        return [
            Document(page_content=document.content, metadata=document.metadata)
            for document in hydrated
        ]

    def _hydrate_candidates(self, candidates: list[Candidate]) -> list[_HydratedDocument]:
        page_map = self._load_page_map()
        hydrated: list[_HydratedDocument] = []

        for candidate in candidates:
            parsed_page = page_map.get(candidate.output_path)
            if parsed_page is not None:
                title = parsed_page.title
                content = parsed_page.content
            else:
                title = candidate.entry.title
                content = self._fetch_page_fallback(candidate.source_url) or candidate.entry.content

            metadata = {
                "source": candidate.source_url,
                "matched_url": candidate.matched_url,
                "matched_title": candidate.entry.title,
                "title": title,
                "path": candidate.output_path,
                "anchor": candidate.anchor or None,
                "tab": candidate.entry.tab,
                "category": candidate.entry.category,
                "site_url": self.site_url,
                "score": candidate.score,
            }
            hydrated.append(_HydratedDocument(content=content, metadata=metadata))

        return hydrated

    def _load_search_entries(self) -> list[SearchEntry]:
        if self._search_entries is not None:
            return self._search_entries

        raw = self._fetch_json(self._artifact_url("search-index.json"))
        if not isinstance(raw, list):
            raise SourceyRetrievalError("search-index.json did not contain a list")

        entries: list[SearchEntry] = []
        for item in raw:
            if not isinstance(item, dict):
                continue

            title = _coerce_text(item.get("title"))
            url = _coerce_text(item.get("url"))
            if not title or not url:
                continue

            entries.append(
                SearchEntry(
                    title=title,
                    content=_coerce_text(item.get("content")),
                    url=url,
                    tab=_coerce_text(item.get("tab")) or "Docs",
                    category=_coerce_text(item.get("category")) or "Pages",
                    featured=bool(item.get("featured")),
                    method=_coerce_text(item.get("method")) or None,
                    path=_coerce_text(item.get("path")) or None,
                )
            )

        if not entries:
            raise SourceyRetrievalError("search-index.json did not contain any usable entries")

        self._search_entries = entries
        return entries

    def _load_page_map(self) -> dict[str, ParsedPage]:
        if not self.use_llms_full:
            return {}
        if self._page_map is not None:
            return self._page_map

        try:
            llms_full = self._fetch_text(self._artifact_url("llms-full.txt"))
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                self._page_map = {}
                return self._page_map
            raise SourceyRetrievalError(
                f"failed to fetch llms-full.txt from {self.site_url}: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise SourceyRetrievalError(
                f"failed to fetch llms-full.txt from {self.site_url}: {exc}"
            ) from exc

        self._page_map = parse_llms_full_text(llms_full)
        return self._page_map

    def _fetch_json(self, url: str) -> Any:
        payload = self._fetch_text(url)
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise SourceyRetrievalError(f"failed to parse JSON from {url}: {exc}") from exc

    def _fetch_text(self, url: str) -> str:
        try:
            with self._client() as client:
                response = client.get(url)
                response.raise_for_status()
                return response.text
        except httpx.HTTPError:
            raise

    def _fetch_page_fallback(self, url: str) -> str:
        try:
            return extract_text_from_html(self._fetch_text(url))
        except httpx.HTTPError:
            return ""

    def _artifact_url(self, artifact_name: str) -> str:
        return urljoin(f"{self.site_url}/", artifact_name)

    def _client(self) -> httpx.Client:
        headers = {"User-Agent": self.user_agent, **self.headers}
        return httpx.Client(timeout=self.timeout, headers=headers, transport=self.transport)


@dataclass(slots=True)
class _HydratedDocument:
    content: str
    metadata: dict[str, Any]


def rank_search_entries(entries: list[SearchEntry], query: str, site_url: str) -> list[Candidate]:
    query_tokens = tokenize(query)
    normalized_query = normalize_text(query)

    best_by_path: dict[str, Candidate] = {}
    for entry in entries:
        matched_url = absolutize_url(entry.url, site_url)
        source_url, anchor = urldefrag(matched_url)
        output_path = relative_output_path(source_url, site_url)
        if not output_path:
            continue

        score = score_entry(entry, query_tokens, normalized_query)
        if score <= 0:
            continue

        candidate = Candidate(
            entry=entry,
            score=score,
            source_url=source_url,
            matched_url=matched_url,
            output_path=output_path,
            anchor=anchor,
        )
        current = best_by_path.get(output_path)
        if current is None or candidate.score > current.score:
            best_by_path[output_path] = candidate

    return sorted(best_by_path.values(), key=lambda candidate: candidate.score, reverse=True)


def score_entry(entry: SearchEntry, query_tokens: list[str], normalized_query: str) -> float:
    if not query_tokens:
        return 1.0 if entry.featured else 0.0

    title = normalize_text(entry.title)
    content = normalize_text(entry.content)
    path = normalize_text(entry.path or "")
    tab = normalize_text(entry.tab)
    category = normalize_text(entry.category)
    method = normalize_text(entry.method or "")
    search_text = " ".join(part for part in [title, path, tab, category, method, content] if part)

    title_tokens = set(tokenize(entry.title))
    path_tokens = set(tokenize((entry.path or "") + " " + entry.url))
    content_tokens = set(tokenize(entry.content))
    meta_tokens = set(tokenize(f"{entry.tab} {entry.category} {entry.method or ''}"))

    score = 0.0
    if normalized_query and normalized_query in title:
        score += 40.0
    if normalized_query and normalized_query in search_text:
        score += 16.0

    for token in query_tokens:
        if token in title_tokens:
            score += 8.0
        if token in path_tokens:
            score += 5.0
        if token in content_tokens:
            score += 3.0
        if token in meta_tokens:
            score += 2.0

    if all(token in search_text for token in query_tokens):
        score += 10.0
    if entry.featured:
        score += 1.0

    return score


def parse_llms_full_text(text: str) -> dict[str, ParsedPage]:
    lines = text.splitlines()
    pages: dict[str, ParsedPage] = {}
    index = 0

    while index < len(lines):
        line = lines[index].rstrip()
        if not line.startswith("### "):
            index += 1
            continue

        title = line[4:].strip()
        lookahead = index + 1
        while lookahead < len(lines) and not lines[lookahead].strip():
            lookahead += 1

        if lookahead >= len(lines):
            break

        match = _PATH_LINE_RE.match(lines[lookahead].strip())
        if match is None:
            index += 1
            continue

        path = normalize_output_path(match.group(1))
        body_start = lookahead + 1
        while body_start < len(lines) and not lines[body_start].strip():
            body_start += 1

        body_end = body_start
        while body_end < len(lines):
            if lines[body_end].startswith("### "):
                probe = body_end + 1
                while probe < len(lines) and not lines[probe].strip():
                    probe += 1
                if probe < len(lines) and _PATH_LINE_RE.match(lines[probe].strip()):
                    break
            body_end += 1

        content = "\n".join(lines[body_start:body_end]).strip()
        if path and content:
            pages[path] = ParsedPage(title=title, path=path, content=content)

        index = body_end

    return pages


def extract_text_from_html(raw_html: str) -> str:
    stripped = _SCRIPT_STYLE_RE.sub(" ", raw_html)
    stripped = _TAG_RE.sub(" ", stripped)
    stripped = html.unescape(stripped)
    return _WHITESPACE_RE.sub(" ", stripped).strip()


def absolutize_url(url: str, site_url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme and parsed.netloc:
        return url
    return urljoin(f"{site_url.rstrip('/')}/", url.lstrip("/"))


def relative_output_path(url: str, site_url: str) -> str:
    site_path = urlparse(site_url).path.rstrip("/")
    parsed_path = urlparse(url).path

    if site_path and parsed_path.startswith(f"{site_path}/"):
        parsed_path = parsed_path[len(site_path) + 1 :]
    else:
        parsed_path = parsed_path.lstrip("/")

    return normalize_output_path(parsed_path)


def normalize_output_path(path: str) -> str:
    """Canonicalise a page path across Sourcey's URL styles.

    Collapses ``foo.html``, ``foo/``, ``foo``, and ``foo/index.html`` onto the
    same key so ``search-index.json`` and ``llms-full.txt`` line up even when
    the site is built with ``prettyUrls`` enabled.
    """

    value = path.split("#", 1)[0].strip()
    if "://" in value:
        value = urlparse(value).path

    value = value.strip("/")
    if not value:
        return ""

    if value.endswith(".html"):
        value = value[:-5]
    elif value.endswith(".htm"):
        value = value[:-4]

    if value == "index":
        return ""
    if value.endswith("/index"):
        value = value[:-len("/index")]

    return value


def tokenize(text: str) -> list[str]:
    tokens = _TOKEN_RE.findall(normalize_text(text))
    filtered = [token for token in tokens if token not in _STOPWORDS]
    return filtered or tokens


def normalize_text(text: str) -> str:
    return text.lower().strip()


def _coerce_text(value: Any) -> str:
    return value if isinstance(value, str) else ""
