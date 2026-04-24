# Contributing

## Local Setup

Python:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -U pip
python -m pip install -e .[dev] build twine
```

JavaScript:

```bash
cd js
npm install
```

## Test And Verify

Run the Python test suite:

```bash
PYTHONPATH=src pytest -q
```

Run the Python live Sourcey integration test against a published docs site:

```bash
SOURCEY_TEST_SITE_URL=https://sourcey.com/docs PYTHONPATH=src pytest tests/integration_tests/test_live_retriever.py -q
```

Build and validate the Python distribution artefacts:

```bash
python -m build
python -m twine check dist/*
```

Run the JavaScript checks:

```bash
cd js
npm run check
npm run test
npm run build
```

Run the JavaScript live Sourcey integration test:

```bash
cd js
SOURCEY_TEST_SITE_URL=https://sourcey.com/docs npm run test
```

## Release Notes

- Keep `pyproject.toml` and `src/langchain_sourcey/retrievers.py` on the same
  package version so the `User-Agent` stays accurate.
- Publish only after the local test suite, live test, build, and `twine check`
  pass.
- If package metadata changes, confirm the public repository and issue tracker
  URLs resolve before publishing.
- Keep `js/package.json` and `js/src/retriever.ts` on the same package version
  so the JS `User-Agent` stays accurate.
- Publish the JS package from `js/` only after `npm run check`, `npm run test`,
  the live JS test, and `npm run build` pass.
