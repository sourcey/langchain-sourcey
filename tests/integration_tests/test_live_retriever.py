import os

import pytest

from langchain_sourcey import SourceyRetriever


@pytest.mark.integration
def test_live_sourcey_site() -> None:
    site_url = os.getenv("SOURCEY_TEST_SITE_URL")
    if not site_url:
        pytest.skip("set SOURCEY_TEST_SITE_URL to run the live retriever test")

    retriever = SourceyRetriever(site_url=site_url, top_k=2)
    docs = retriever.invoke("search")

    assert docs
    assert all(doc.metadata["source"].startswith("http") for doc in docs)
    assert all(doc.page_content for doc in docs)
