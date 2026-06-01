.PHONY: backend-test frontend-build test

backend-test:
	cd backend && if [ -x .venv/bin/python ]; then .venv/bin/python -m unittest discover -s tests; else python3 -m unittest discover -s tests; fi

frontend-build:
	cd frontend && npm run build

test: backend-test frontend-build
