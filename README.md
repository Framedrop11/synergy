# Synergy backend

Express API and MongoDB-backed escalation worker for the Synergy patient medication reminder app.

## Local setup

1. Copy `.env.example` to `.env` and replace the required placeholders. Keep `.env` private.
2. From this directory, run `npm ci`.
3. Run `docker compose up --build` to start the API and worker, or run `npm start` and `npm run start:worker` in separate terminals.
4. Check `http://localhost:5001/health` after the API connects to MongoDB.

For email and SMS environment variables, Twilio webhook configuration, and mobile build setup, see [`../docs/DEPLOYMENT_AND_MANUAL_SETUP.md`](../docs/DEPLOYMENT_AND_MANUAL_SETUP.md).

## Tests

- `npm test` runs unit tests. If `API_BASE_URL` is set, it also checks the API health and unauthenticated access response.
- `npm run test:integration` runs only those API smoke tests against `API_BASE_URL`.

GitHub Actions uses a temporary MongoDB service and executes both the backend checks and mobile static/export checks.

## Operational model

- MongoDB stores patients, medication schedules, occurrences, caregiver alert records, and shared rate-limit counters.
- The separate worker checks overdue occurrences and sends verified caregiver email/SMS alerts. Redis is not required.
- Caregiver contact verification and opt-out endpoints are public links/webhooks; caregiver recipients do not get an account or dashboard.
- API autoscaling is configured in the repository root `render.yaml`. The worker remains a separately deployed service.
