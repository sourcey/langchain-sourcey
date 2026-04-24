import { Document } from "@langchain/core/documents";
import type { CallbackManagerForRetrieverRun } from "@langchain/core/callbacks/manager";
import {
  BaseRetriever,
  type BaseRetrieverInput,
} from "@langchain/core/retrievers";

const TOKEN_RE = /[a-z0-9]+/g;
const PATH_LINE_RE = /^Path:\s*`([^`]+)`\s*$/;
const SCRIPT_STYLE_RE =
  /<(?:script|style)\b.*?>.*?<\/(?:script|style)>/gis;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;
const STOPWORDS = new Set([
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
]);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SearchEntry {
  title: string;
  content: string;
  url: string;
  tab: string;
  category: string;
  featured?: boolean;
  method?: string;
  path?: string;
}

export interface ParsedPage {
  title: string;
  path: string;
  content: string;
}

export interface Candidate {
  entry: SearchEntry;
  score: number;
  sourceUrl: string;
  matchedUrl: string;
  outputPath: string;
  anchor: string;
}

export interface SourceyDocumentMetadata {
  source: string;
  matched_url: string;
  matched_title: string;
  title: string;
  path: string;
  anchor?: string;
  tab: string;
  category: string;
  site_url: string;
  score: number;
}

export interface SourceyRetrieverInput extends BaseRetrieverInput {
  siteUrl: string;
  topK?: number;
  timeoutMs?: number;
  useLlmsFull?: boolean;
  userAgent?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

interface HydratedDocument {
  content: string;
  metadata: SourceyDocumentMetadata;
}

export class SourceyRetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceyRetrievalError";
  }
}

export class SourceyHttpError extends SourceyRetrievalError {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number, statusText: string) {
    super(`request failed for ${url}: ${status} ${statusText}`);
    this.name = "SourceyHttpError";
    this.status = status;
    this.url = url;
  }
}

export class SourceyRetriever extends BaseRetriever<SourceyDocumentMetadata> {
  static lc_name(): string {
    return "SourceyRetriever";
  }

  lc_namespace = ["sourcey", "retrievers"];
  lc_serializable = true;

  siteUrl: string;
  topK: number;
  timeoutMs: number;
  useLlmsFull: boolean;
  userAgent: string;
  headers: Record<string, string>;

  private readonly fetchImpl: FetchLike;
  private searchEntries?: SearchEntry[];
  private pageMap?: Record<string, ParsedPage>;

  get lc_aliases(): Record<string, string> {
    return {
      siteUrl: "site_url",
      topK: "top_k",
      timeoutMs: "timeout_ms",
      useLlmsFull: "use_llms_full",
      userAgent: "user_agent",
    };
  }

  get lc_serializable_keys(): string[] {
    return [
      "siteUrl",
      "topK",
      "timeoutMs",
      "useLlmsFull",
      "userAgent",
      "headers",
      "callbacks",
      "tags",
      "metadata",
      "verbose",
    ];
  }

  constructor(fields: SourceyRetrieverInput) {
    super(fields);

    if (!isAbsoluteHttpUrl(fields.siteUrl)) {
      throw new SourceyRetrievalError(
        "siteUrl must be an absolute http(s) URL"
      );
    }

    this.siteUrl = fields.siteUrl.replace(/\/+$/, "");
    this.topK = fields.topK ?? 6;
    this.timeoutMs = fields.timeoutMs ?? 10_000;
    this.useLlmsFull = fields.useLlmsFull ?? true;
    this.userAgent = fields.userAgent ?? "langchain-sourcey-js/0.1.3";
    this.headers = fields.headers ?? {};
    this.fetchImpl = fields.fetch ?? globalThis.fetch;

    if (!this.fetchImpl) {
      throw new SourceyRetrievalError("fetch is not available in this runtime");
    }
    if (this.topK <= 0) {
      throw new SourceyRetrievalError("topK must be greater than 0");
    }
    if (this.timeoutMs <= 0) {
      throw new SourceyRetrievalError("timeoutMs must be greater than 0");
    }
  }

  refresh(): void {
    this.searchEntries = undefined;
    this.pageMap = undefined;
  }

  async _getRelevantDocuments(
    query: string,
    _callbacks?: CallbackManagerForRetrieverRun
  ): Promise<Document<SourceyDocumentMetadata>[]> {
    void _callbacks;
    const entries = await this.loadSearchEntries();
    const candidates = rankSearchEntries(entries, query, this.siteUrl);
    const hydrated = await this.hydrateCandidates(candidates.slice(0, this.topK));

    return hydrated.map(
      (document) =>
        new Document<SourceyDocumentMetadata>({
          pageContent: document.content,
          metadata: document.metadata,
        })
    );
  }

  private async hydrateCandidates(
    candidates: Candidate[]
  ): Promise<HydratedDocument[]> {
    const pageMap = await this.loadPageMap();
    const hydrated: HydratedDocument[] = [];

    for (const candidate of candidates) {
      const parsedPage = pageMap[candidate.outputPath];
      const title = parsedPage?.title ?? candidate.entry.title;
      const content =
        parsedPage?.content ||
        (await this.fetchPageFallback(candidate.sourceUrl)) ||
        candidate.entry.content;

      hydrated.push({
        content,
        metadata: {
          source: candidate.sourceUrl,
          matched_url: candidate.matchedUrl,
          matched_title: candidate.entry.title,
          title,
          path: candidate.outputPath,
          anchor: candidate.anchor || undefined,
          tab: candidate.entry.tab,
          category: candidate.entry.category,
          site_url: this.siteUrl,
          score: candidate.score,
        },
      });
    }

    return hydrated;
  }

  private async loadSearchEntries(): Promise<SearchEntry[]> {
    if (this.searchEntries) {
      return this.searchEntries;
    }

    const raw = await this.fetchJson(this.artifactUrl("search-index.json"));
    if (!Array.isArray(raw)) {
      throw new SourceyRetrievalError("search-index.json did not contain a list");
    }

    const entries = raw
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item): SearchEntry | null => {
        const title = coerceText(item.title);
        const url = coerceText(item.url);
        if (!title || !url) {
          return null;
        }

        return {
          title,
          content: coerceText(item.content),
          url,
          tab: coerceText(item.tab) || "Docs",
          category: coerceText(item.category) || "Pages",
          featured: Boolean(item.featured),
          method: coerceText(item.method) || undefined,
          path: coerceText(item.path) || undefined,
        };
      })
      .filter((entry): entry is SearchEntry => entry !== null);

    if (!entries.length) {
      throw new SourceyRetrievalError(
        "search-index.json did not contain any usable entries"
      );
    }

    this.searchEntries = entries;
    return entries;
  }

  private async loadPageMap(): Promise<Record<string, ParsedPage>> {
    if (!this.useLlmsFull) {
      return {};
    }
    if (this.pageMap) {
      return this.pageMap;
    }

    try {
      const llmsFull = await this.fetchText(this.artifactUrl("llms-full.txt"));
      this.pageMap = parseLlmsFullText(llmsFull);
      return this.pageMap;
    } catch (error) {
      if (error instanceof SourceyHttpError && error.status === 404) {
        this.pageMap = {};
        return this.pageMap;
      }

      if (error instanceof Error) {
        throw new SourceyRetrievalError(
          `failed to fetch llms-full.txt from ${this.siteUrl}: ${error.message}`
        );
      }
      throw error;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const payload = await this.fetchText(url);

    try {
      return JSON.parse(payload) as unknown;
    } catch (error) {
      throw new SourceyRetrievalError(
        `failed to parse JSON from ${url}: ${String(error)}`
      );
    }
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchResponse(url);
    return response.text();
  }

  private async fetchResponse(url: string): Promise<Response> {
    const response = await this.fetchImpl(url, {
      headers: {
        "User-Agent": this.userAgent,
        ...this.headers,
      },
      signal: timeoutSignal(this.timeoutMs),
    });

    if (!response.ok) {
      throw new SourceyHttpError(url, response.status, response.statusText);
    }

    return response;
  }

  private async fetchPageFallback(url: string): Promise<string> {
    try {
      return extractTextFromHtml(await this.fetchText(url));
    } catch {
      return "";
    }
  }

  private artifactUrl(artifactName: string): string {
    return new URL(artifactName, ensureTrailingSlash(this.siteUrl)).toString();
  }
}

export function rankSearchEntries(
  entries: SearchEntry[],
  query: string,
  siteUrl: string
): Candidate[] {
  const queryTokens = tokenize(query);
  const normalizedQuery = normalizeText(query);
  const bestByPath = new Map<string, Candidate>();

  for (const entry of entries) {
    const matchedUrl = absolutizeUrl(entry.url, siteUrl);
    const url = new URL(matchedUrl);
    const anchor = url.hash.replace(/^#/, "");
    url.hash = "";
    const sourceUrl = url.toString();
    const outputPath = relativeOutputPath(sourceUrl, siteUrl);

    if (!outputPath) {
      continue;
    }

    const score = scoreEntry(entry, queryTokens, normalizedQuery);
    if (score <= 0) {
      continue;
    }

    const candidate: Candidate = {
      entry,
      score,
      sourceUrl,
      matchedUrl,
      outputPath,
      anchor,
    };
    const current = bestByPath.get(outputPath);
    if (!current || candidate.score > current.score) {
      bestByPath.set(outputPath, candidate);
    }
  }

  return [...bestByPath.values()].sort((left, right) => right.score - left.score);
}

function scoreEntry(
  entry: SearchEntry,
  queryTokens: string[],
  normalizedQuery: string
): number {
  if (!queryTokens.length) {
    return entry.featured ? 1 : 0;
  }

  const title = normalizeText(entry.title);
  const content = normalizeText(entry.content);
  const path = normalizeText(entry.path ?? "");
  const tab = normalizeText(entry.tab);
  const category = normalizeText(entry.category);
  const method = normalizeText(entry.method ?? "");
  const searchText = [title, path, tab, category, method, content]
    .filter(Boolean)
    .join(" ");

  const titleTokens = new Set(tokenize(entry.title));
  const pathTokens = new Set(tokenize(`${entry.path ?? ""} ${entry.url}`));
  const contentTokens = new Set(tokenize(entry.content));
  const metaTokens = new Set(tokenize(`${entry.tab} ${entry.category} ${entry.method ?? ""}`));

  let score = 0;
  if (normalizedQuery && title.includes(normalizedQuery)) {
    score += 40;
  }
  if (normalizedQuery && searchText.includes(normalizedQuery)) {
    score += 16;
  }

  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      score += 8;
    }
    if (pathTokens.has(token)) {
      score += 5;
    }
    if (contentTokens.has(token)) {
      score += 3;
    }
    if (metaTokens.has(token)) {
      score += 2;
    }
  }

  if (queryTokens.every((token) => searchText.includes(token))) {
    score += 10;
  }
  if (entry.featured) {
    score += 1;
  }

  return score;
}

export function parseLlmsFullText(text: string): Record<string, ParsedPage> {
  const lines = text.split(/\r?\n/);
  const pages: Record<string, ParsedPage> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? "";
    if (!line.startsWith("### ")) {
      index += 1;
      continue;
    }

    const title = line.slice(4).trim();
    let lookahead = index + 1;
    while (lookahead < lines.length && !lines[lookahead]?.trim()) {
      lookahead += 1;
    }
    if (lookahead >= lines.length) {
      break;
    }

    const match = PATH_LINE_RE.exec(lines[lookahead]?.trim() ?? "");
    if (!match) {
      index += 1;
      continue;
    }

    const path = normalizeOutputPath(match[1]);
    let bodyStart = lookahead + 1;
    while (bodyStart < lines.length && !lines[bodyStart]?.trim()) {
      bodyStart += 1;
    }

    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length) {
      const bodyLine = lines[bodyEnd] ?? "";
      if (bodyLine.startsWith("### ")) {
        let probe = bodyEnd + 1;
        while (probe < lines.length && !lines[probe]?.trim()) {
          probe += 1;
        }
        if (probe < lines.length && PATH_LINE_RE.test(lines[probe]?.trim() ?? "")) {
          break;
        }
      }
      bodyEnd += 1;
    }

    const content = lines.slice(bodyStart, bodyEnd).join("\n").trim();
    if (path && content) {
      pages[path] = { title, path, content };
    }

    index = bodyEnd;
  }

  return pages;
}

export function extractTextFromHtml(rawHtml: string): string {
  const stripped = rawHtml.replace(SCRIPT_STYLE_RE, " ").replace(TAG_RE, " ");
  const decoded = decodeHtmlEntities(stripped);
  return decoded.replace(WHITESPACE_RE, " ").trim();
}

export function absolutizeUrl(url: string, siteUrl: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return new URL(url.replace(/^\/+/, ""), ensureTrailingSlash(siteUrl)).toString();
  }
}

export function relativeOutputPath(url: string, siteUrl: string): string {
  const sitePath = new URL(siteUrl).pathname.replace(/\/+$/, "");
  let parsedPath = new URL(url).pathname;

  if (sitePath && parsedPath.startsWith(`${sitePath}/`)) {
    parsedPath = parsedPath.slice(sitePath.length + 1);
  } else {
    parsedPath = parsedPath.replace(/^\/+/, "");
  }

  return normalizeOutputPath(parsedPath);
}

/**
 * Canonicalise a page path into a single form that matches across all Sourcey
 * URL styles: `.html`, trailing-slash (`/foo/`), and extensionless (`/foo`).
 * Same page keys to the same value regardless of which form the site emits,
 * so `search-index.json` and `llms-full.txt` line up even in pretty-URL mode.
 */
function normalizeOutputPath(path: string): string {
  let value = path.split("#", 1)[0]?.trim() ?? "";
  if (!value) return "";

  try {
    value = new URL(value).pathname;
  } catch {
    // Not an absolute URL; treat input as a bare path.
  }

  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value) return "";

  if (value.endsWith(".html")) value = value.slice(0, -5);
  else if (value.endsWith(".htm")) value = value.slice(0, -4);

  if (value === "index") return "";
  if (value.endsWith("/index")) value = value.slice(0, -"/index".length);

  return value;
}

function tokenize(text: string): string[] {
  const tokens = normalizeText(text).match(TOKEN_RE) ?? [];
  const filtered = tokens.filter((token) => !STOPWORDS.has(token));
  return filtered.length ? filtered : tokens;
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function coerceText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }

  return AbortSignal.timeout(timeoutMs);
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();

    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return "\"";
    if (key === "apos" || key === "#39") return "'";
    if (key === "nbsp") return " ";
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return match;
  });
}
