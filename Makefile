.PHONY: up down logs build test restart clean

up: ## Build and start backend (:8000) and frontend (:3000)
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example - put your real keys in LLM_API_KEYS")
	docker compose up --build -d
	@echo "Frontend: http://localhost:3000   Backend: http://localhost:8000/health"

down: ## Stop the stack (the SQLite volume is kept)
	docker compose down

restart: down up

logs:
	docker compose logs -f

build:
	docker compose build

test: ## Run backend tests locally (no real API calls)
	cd backend && python -m pytest -q

clean: ## Stop the stack AND delete the SQLite volume
	docker compose down -v
