# PatientCareAI

**AI-assisted medication reminders for patients, with optional caregiver alerts.**

PatientCareAI is a mobile medication reminder application backed by an API and an asynchronous notification worker. Patients can create reminders manually or draft them with natural language, review and confirm the details, receive reminders, record adherence, and view a weekly adherence summary. A patient may optionally configure a verified caregiver contact for one-way email or SMS alerts.

> PatientCareAI records patient-entered medication instructions. It does not prescribe medicines, determine dosage, or replace advice from a licensed clinician. Users should enter dosage only as directed by their clinician or pharmacy.

## Product capabilities

- **Medication reminders:** Create and manage one-time and repeating medication schedules, with an optional dosage label entered by the patient.
- **Natural-language schedule drafting:** Describe a medication and schedule in text, review the extracted fields, answer clarification prompts, and confirm before saving.
- **Conversational and voice-assisted drafting:** Continue a schedule-drafting conversation by text or voice. Initial voice and conversation language support is English and Hindi. Always review the transcription and generated schedule before saving.
- **Notifications and adherence:** Receive reminders, record a dose as taken or skipped, and review a weekly adherence summary.
- **Optional caregiver alerts:** Verify one caregiver email address or phone number. Patients control alert timing and whether an explicitly skipped dose should notify the caregiver. Caregivers receive simple one-way alerts and do not need an account or dashboard.
- **Patient account and data protection:** Authenticated patient accounts, API-side validation, rate limiting, timezone-aware schedules, and protected storage of account and medication data.
- **Scalable backend:** The API and background escalation worker are separate processes. Dockerfiles and Compose configuration are in `synergy-backend/`; the API is designed to run behind a hosting provider’s load balancer and scale horizontally when the hosting plan supports it.

## Repository layout

```text
.
├── Oauth_final/                 # Expo / React Native patient application
├── synergy-backend/             # Express API, MongoDB models, worker, tests
├── .github/workflows/ci.yml     # Backend and mobile validation pipeline
├── render.yaml                  # Render API/worker deployment blueprint
├── Dockerfile                   # Root-compatible container entrypoint
├── Dockerfile.worker            # Root-compatible worker container entrypoint
├── app.js                       # Root launch shim for the Render API service
├── worker.js                    # Root launch shim for a separately run worker
├── package.json                 # Root compatibility scripts and backend deps
├── package-lock.json
├── .gitignore
└── README.md
```

The root launch files and Dockerfiles preserve existing root-based Render build/start configurations while keeping backend implementation files grouped in `synergy-backend/`. The Render Blueprint points the API and worker at their Dockerfiles in that folder. The worker can be started separately with `npm run start:worker`.

## End-to-end workflow

1. A patient signs in and creates a medication reminder manually or starts a natural-language/voice-assisted draft.
2. The app sends the patient-provided text to the API for schedule extraction and clarification. The patient reviews the medication name, optional prescribed dosage, time, recurrence, and timezone, then confirms the schedule.
3. The API validates and stores the schedule and its occurrence records in MongoDB. Reminders are presented in the app; adherence actions are sent to the API and recorded against the matching occurrence.
4. The patient can view the weekly adherence summary generated from recorded occurrences.
5. If caregiver alerts are enabled, the patient verifies a single email or phone recipient and configures alert timing. The backend worker checks durable occurrence state and sends the configured one-way notification when the patient has not confirmed a dose within the configured window.

## Technology

- **Mobile:** Expo, React Native, TypeScript, Expo Router, native Google Sign-In, local notification and speech-recognition integrations.
- **API:** Node.js, Express, MongoDB/Mongoose, JWT-protected patient routes, email/SMS providers, and schedule parsing services.
- **Background processing:** A separate Node worker evaluates overdue occurrences and sends caregiver alerts.
- **Deployment:** The API and worker have separate Dockerfiles; local container orchestration is defined in `synergy-backend/docker-compose.yml`. Root-level Dockerfiles remain for services whose Docker settings still point at the repository root. Production secrets belong in Render environment variables or a secret group, never in source control.

## Getting started

### Mobile application

```bash
cd Oauth_final
npm ci
npm start
```

Use an Android development build for native Google Sign-In, speech recognition, and device notification behavior. Expo Go does not provide every native module used by this application.

### Backend API and worker

Create a private environment file from the template and fill it with local development values:

```bash
cd synergy-backend
Copy-Item .env.example .env   # PowerShell
npm ci
npm test
npm start
```

Run the worker separately with `npm run start:worker`. For containers, configure `synergy-backend/.env` and run `docker compose up --build` from `synergy-backend/`. The API and worker require a reachable MongoDB database. The integration smoke tests run against a deployment when `API_BASE_URL` is set.

## Production configuration

Configure secrets in the hosting provider’s secret store. Do not place production values in `.env.example`, `eas.json`, mobile `EXPO_PUBLIC_*` variables, or this README. The backend requires a MongoDB connection, a strong JWT signing secret, exact production CORS origins, and provider settings for whichever email, SMS, and AI features are enabled. Contact verification links require the public HTTPS API base URL.

The existing Render API service can retain its root-level `npm start` command: the root shim forwards startup to the backend implementation. Existing root-based Docker deployments can use the compatibility Dockerfiles. The included Render Blueprint targets `synergy-backend/` for the API and worker and references the `synergy-secrets` environment group; keep that group populated with production secrets. Render autoscaling requires a workspace plan that supports it; the blueprint configures API instance scaling and Render supplies the service load balancer.

For Android EAS builds, run EAS commands from `Oauth_final/`. OAuth client IDs and public API URLs may be embedded in the app; private provider credentials must remain server-side.

## Verification

GitHub Actions runs backend unit and API integration checks against a temporary MongoDB service, mobile type checks/lint/export, and a Gitleaks scan. Local checks:

```bash
cd synergy-backend
npm test

cd ../Oauth_final
npx tsc --noEmit
npm run lint
npx expo export --platform android
```

## Privacy and safety

- Never commit `.env` files, API keys, provider passwords, database credentials, private keys, signing files, or production JWT secrets.
- The root `.gitignore` excludes environment files, credentials, local builds, package installs, and generated documents. Only `.env.example` templates are allowed.
- Review speech transcriptions and AI-drafted schedules before saving. The AI is a data-entry aid, not a medical decision-maker.
- Protect caregiver contact information and send alerts only after recipient verification and patient consent.
