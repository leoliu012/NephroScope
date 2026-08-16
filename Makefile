.PHONY: viewer-only-check backend-test frontend-build test

viewer-only-check:
	python3 scripts/assert_viewer_only.py

backend-test:
	cd backend && if [ -x .venv/bin/python ]; then .venv/bin/python -m unittest discover -s tests; else python3 -m unittest discover -s tests; fi

frontend-build:
	cd frontend && npm run build

test: viewer-only-check backend-test frontend-build
