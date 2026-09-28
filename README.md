# Synergy backend

## Natural-language reminder parsing

The optional reminder assistant calls Groq from this backend. Set `GROQ_API_KEY` in the backend environment (copy `.env.example` for local setup). For Render, add `GROQ_API_KEY` under the service's Environment settings and redeploy. Keep the key out of the Expo app and source control.

If the key is missing or Groq is unavailable, the API returns an error and the app keeps the manual reminder form available.
