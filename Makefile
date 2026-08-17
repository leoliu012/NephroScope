.PHONY: app-scope-check viewer-only-check backend-test frontend-build test

app-scope-check:
	python3 scripts/assert_viewer_only.py

# Backward-compatible alias retained for existing CI/deployment commands.
viewer-only-check: app-scope-check

backend-test:
	cd backend && if [ -x .venv/bin/python ]; then .venv/bin/python -m unittest discover -s tests; else python3 -m unittest discover -s tests; fi

frontend-build:
	cd frontend && npm run build

test: app-scope-check backend-test frontend-build
