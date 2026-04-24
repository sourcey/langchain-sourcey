# Contributing

## Local Setup

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -U pip
python -m pip install -e .[dev] build twine
```

## Test And Verify

Run the full local test suite:

```bash
PYTHONPATH=src pytest -q
```

Run the live Sourcey integration test against a published docs site:

```bash
SOURCEY_TEST_SITE_URL=https://sourcey.com/docs PYTHONPATH=src pytest tests/integration_tests/test_live_retriever.py -q
```

Build and validate the distribution artefacts:

```bash
python -m build
python -m twine check dist/*
```

## Release Notes

- Keep `pyproject.toml` and `src/langchain_sourcey/retrievers.py` on the same
  package version so the `User-Agent` stays accurate.
- Publish only after the local test suite, live test, build, and `twine check`
  pass.
- If package metadata changes, confirm the public repository and issue tracker
  URLs resolve before publishing.
