PYTHON  = .venv/bin/python
PIP     = .venv/bin/pip
CELERY  = .venv/bin/celery
DC      = docker compose
DC_DEV  = docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: help \
        run migrate migrations shell superuser worker collectstatic install check \
        dc-up dc-dev dc-down dc-build dc-logs dc-shell dc-migrate dc-superuser dc-restart

## ── Local dev without Docker ────────────────────────────────────────
run:           ## Start Django runserver (no Docker)
	$(PYTHON) manage.py runserver 0.0.0.0:8000

migrations:    ## Create migration files for changed models
	$(PYTHON) manage.py makemigrations

migrate:       ## Apply pending migrations
	$(PYTHON) manage.py migrate

superuser:     ## Create admin superuser
	$(PYTHON) manage.py createsuperuser

shell:         ## Django shell
	$(PYTHON) manage.py shell

worker:        ## Start Celery worker
	$(CELERY) -A config worker -l info

check:         ## Django system checks
	$(PYTHON) manage.py check

install:       ## Install / update Python dependencies
	$(PIP) install -r requirements.txt

collectstatic: ## Collect static files
	$(PYTHON) manage.py collectstatic --no-input

## ── Docker — production ─────────────────────────────────────────────
dc-up:         ## Start all production services (detached)
	$(DC) up -d

dc-down:       ## Stop all services
	$(DC) down

dc-build:      ## Rebuild the app image
	$(DC) build

dc-logs:       ## Follow logs (all services)
	$(DC) logs -f

dc-restart:    ## Restart web + celery only
	$(DC) restart web celery

dc-migrate:    ## Run migrations inside running web container
	$(DC) exec web python manage.py migrate

dc-superuser:  ## Create superuser inside running web container
	$(DC) exec web python manage.py createsuperuser

dc-shell:      ## Django shell inside running web container
	$(DC) exec web python manage.py shell

## ── Docker — development ────────────────────────────────────────────
dc-dev:        ## Start dev stack (live reload, no Nginx)
	$(DC_DEV) up

dc-dev-migrate: ## Run migrations in dev stack
	$(DC_DEV) run --rm web python manage.py migrate

## ── Help ─────────────────────────────────────────────────────────────
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
