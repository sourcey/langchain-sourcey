from __future__ import annotations

import argparse

from langchain_sourcey import SourceyRetriever


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a live Sourcey retrieval query.")
    parser.add_argument(
        "--site-url",
        default="https://sourcey.com/docs",
        help="Published Sourcey docs root.",
    )
    parser.add_argument(
        "--query",
        default="mcp integration",
        help="Natural-language retrieval query.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=3,
        help="Maximum number of documents to return.",
    )
    args = parser.parse_args()

    retriever = SourceyRetriever(site_url=args.site_url, top_k=args.top_k)
    docs = retriever.invoke(args.query)

    for index, doc in enumerate(docs, start=1):
        print(f"{index}. {doc.metadata['title']}")
        print(f"   source: {doc.metadata['source']}")
        print(f"   score: {doc.metadata['score']}")
        print(f"   snippet: {doc.page_content[:160]}")
        print()


if __name__ == "__main__":
    main()
