SHELL := /bin/bash

PYTHON ?= python3
BACKEND_DIR := backend
FRONTEND_DIR := frontend
VENV := .venv
VENV_PYTHON := $(VENV)/bin/python
VENV_PIP := $(VENV)/bin/pip
RUN_DIR := .run
BACKEND_PID_FILE := $(RUN_DIR)/backend.pid
FRONTEND_PID_FILE := $(RUN_DIR)/frontend.pid

.PHONY: help env backend-env frontend-env install backend-install frontend-install \
	backend-migrate backend-run frontend-run dev native-start native-stop up down \
	backend-lint backend-test frontend-test frontend-build deploy-test lint test check \
	docker-db docker-migrate docker-up docker-down

help:
	@echo "Available targets:"
	@echo "  make env              Copy missing .env files from examples"
	@echo "  make install          Install backend and frontend dependencies"
	@echo "  make backend-install  Create root venv and install backend dev requirements"
	@echo "  make frontend-install Install frontend dependencies with npm ci"
	@echo "  make backend-migrate  Run Alembic migrations locally"
	@echo "  make backend-run      Start FastAPI backend locally"
	@echo "  make frontend-run     Start Vite frontend locally"
	@echo "  make dev              Run backend and frontend together locally"
	@echo "  make up               Idempotently start backend and frontend locally in background"
	@echo "  make down             Stop local background services and docker compose services"
	@echo "  make backend-lint     Run backend Ruff checks"
	@echo "  make backend-test     Run backend pytest suite"
	@echo "  make frontend-test    Run frontend Vitest suite"
	@echo "  make frontend-build   Build frontend production bundle"
	@echo "  make deploy-test      Test deployment orchestration with mocked external commands"
	@echo "  make lint             Run all lint checks"
	@echo "  make test             Run all test suites"
	@echo "  make check            Run lint, tests, and frontend build"
	@echo "  make docker-db        Start only PostgreSQL via docker compose"
	@echo "  make docker-migrate   Run Alembic in docker compose backend"
	@echo "  make docker-up        Start db, migrate, then run backend + frontend in Docker"
	@echo "  make docker-down      Stop docker compose services"

env: backend-env frontend-env

backend-env:
	@[ -f $(BACKEND_DIR)/.env ] || cp $(BACKEND_DIR)/.env.example $(BACKEND_DIR)/.env

frontend-env:
	@[ -f $(FRONTEND_DIR)/.env ] || cp $(FRONTEND_DIR)/.env.example $(FRONTEND_DIR)/.env

backend-install: backend-env
	@[ -x $(VENV_PYTHON) ] || $(PYTHON) -m venv $(VENV)
	@$(VENV_PYTHON) -m pip uninstall -y gec_annotation_backend >/dev/null 2>&1 || true
	$(VENV_PIP) install -r $(BACKEND_DIR)/requirements-dev.txt

frontend-install: frontend-env
	cd $(FRONTEND_DIR) && npm ci

install: backend-install frontend-install

backend-migrate:
	cd $(BACKEND_DIR) && ../$(VENV)/bin/alembic -c alembic.ini upgrade head

backend-run:
	cd $(BACKEND_DIR) && ../$(VENV)/bin/uvicorn app.main:app --reload

frontend-run:
	cd $(FRONTEND_DIR) && npm run dev -- --host

dev:
	@trap 'kill 0' EXIT; \
	$(MAKE) backend-run & \
	$(MAKE) frontend-run & \
	wait

native-start:
	@mkdir -p $(RUN_DIR)
	@(cd $(BACKEND_DIR) && nohup ../$(VENV)/bin/uvicorn app.main:app --reload > ../$(RUN_DIR)/backend.log 2>&1 & echo $$! > ../$(BACKEND_PID_FILE))
	@(cd $(FRONTEND_DIR) && nohup npm run dev -- --host > ../$(RUN_DIR)/frontend.log 2>&1 & echo $$! > ../$(FRONTEND_PID_FILE))
	@echo "Backend started: http://localhost:8000"
	@echo "Frontend started: http://localhost:4173"
	@echo "Logs: $(RUN_DIR)/backend.log, $(RUN_DIR)/frontend.log"

native-stop:
	@mkdir -p $(RUN_DIR)
	@if [ -f $(BACKEND_PID_FILE) ]; then \
		pid=$$(cat $(BACKEND_PID_FILE)); \
		kill $$pid 2>/dev/null || true; \
		rm -f $(BACKEND_PID_FILE); \
	fi
	@if [ -f $(FRONTEND_PID_FILE) ]; then \
		pid=$$(cat $(FRONTEND_PID_FILE)); \
		kill $$pid 2>/dev/null || true; \
		rm -f $(FRONTEND_PID_FILE); \
	fi

up: env native-stop backend-migrate native-start

down: native-stop docker-down

backend-lint:
	cd $(BACKEND_DIR) && ../$(VENV)/bin/python -m ruff check .

backend-test:
	cd $(BACKEND_DIR) && ../$(VENV)/bin/python -m pytest -q

frontend-test:
	cd $(FRONTEND_DIR) && npm test

frontend-build:
	cd $(FRONTEND_DIR) && npm run build

deploy-test:
	bash scripts/test_deploy_workflow.sh

lint: backend-lint

test: backend-test frontend-test deploy-test

check: lint test frontend-build

docker-db:
	docker compose up db -d

docker-migrate:
	docker compose run --rm backend alembic -c alembic.ini upgrade head

docker-up: env
	docker compose down --remove-orphans
	docker compose up db -d
	docker compose run --rm backend alembic -c alembic.ini upgrade head
	docker compose up -d --build backend frontend
	@echo "Backend started: http://localhost:8000"
	@echo "Frontend started: http://localhost:4173"

docker-down:
	docker compose down
