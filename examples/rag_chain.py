from __future__ import annotations

import argparse

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_openai import ChatOpenAI

from langchain_sourcey import SourceyRetriever


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Answer a question over a published Sourcey docs site."
    )
    parser.add_argument(
        "--site-url",
        default="https://sourcey.com/docs",
        help="Published Sourcey docs root.",
    )
    parser.add_argument(
        "--question",
        default="How does Sourcey document MCP servers?",
        help="Question to answer with retrieved documentation.",
    )
    args = parser.parse_args()

    retriever = SourceyRetriever(site_url=args.site_url, top_k=3)

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

    print(chain.invoke({"question": args.question}))


if __name__ == "__main__":
    main()
