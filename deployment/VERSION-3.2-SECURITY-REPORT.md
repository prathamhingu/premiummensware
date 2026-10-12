# Version 3.2 Security Report — Render Free Private Preview

## Preview access control

When `PREVIEW_GATE_ENABLED=true`, server-side Express middleware executes before static serving and application routes. It protects rendered pages, CSS/JavaScript assets, uploaded images, APIs, and sitemap handling. The allowlist is limited to the preview login/logout resources, the preview gate script, `/healthz` (which returns only `ok`), and `/robots.txt` (which disallows crawling but is not an access-control mechanism).

Protected responses use `Cache-Control: private, no-store, max-age=0` and `X-Robots-Tag: noindex, nofollow, noarchive`. These headers complement, but do not replace, route authentication.

## Password handling

The preview password is not hard-coded. `PREVIEW_PASSWORD_HASH` holds a salted scrypt encoding created by `npm --prefix backend run preview:hash`. Accepted scrypt parameters and decoded salt/key lengths are bounded; verification uses `crypto.timingSafeEqual`. The raw password is entered locally without echo and is not included in the package.

## Sessions

A successful preview login regenerates the session identifier and sets preview authorisation and an authentication timestamp. Cookies are HTTP-only, SameSite Lax, eight-hour expiry, and Secure in production. Preview authorisation is independent of administrator privilege. The included session store is file-backed and single-instance only.

## Rate limiting

The preview-login endpoint uses `express-rate-limit` with a 15-minute window and a limit of 10 attempts per limiter key. This limiter is process-local and is appropriate only for the intended small preview; it is not a multi-instance rate-limit architecture.

## Production fail-closed behaviour

When `NODE_ENV=production`, startup requires a sufficiently long `SESSION_SECRET`. It refuses to run with the gate disabled unless the explicit public-launch override is provided. With the gate enabled, a missing or malformed `PREVIEW_PASSWORD_HASH` prevents startup rather than accidentally exposing the site.

## Administrator isolation and free-tier bootstrap

The preview password grants preview access only. Administrator endpoints continue to require separate administrator authentication. The clean package excludes the local administrator record. Render Free's filesystem may reset, so `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_BCRYPT_HASH` should remain configured in the Render environment for this preview. The startup bootstrap recreates the administrator record if the ephemeral file is gone. When migrating to persistent storage, review bootstrap settings and remove them after the initial account is securely established.

## Data persistence and package contents

This Render Free variant deliberately has no persistent disk. The public seed is committed in `backend/data/seed-site-data.json`; runtime JSON records, admin edits, sessions, and uploaded images live on ephemeral storage and may be lost when the service spins down, restarts, or redeploys. Do not use this free preview to store real customer enquiries, appointments, orders, or permanent product content.

The package contains no real `.env`, local admin record, customer enquiries, appointment/order records, local sessions or private uploaded images.

## Remaining limitations

- A shared password cannot restrict access to named people; anyone who receives it can share it.
- Render Free services spin down after 15 minutes of inactivity and can take about a minute to start on the next request.
- File-backed storage/sessions require one instance and are not a multi-instance production database design.
- `/healthz` and `/robots.txt` are public, but contain no business information.
- Deployment and live verification must be performed in the user's GitHub and Render accounts; this package alone does not create a hosted URL.

## Folder layout

The Express server and operational modules live in `backend/`; the EJS templates and static assets live in `frontend/`; Render and deployment guidance live in `deployment/`. The Render Blueprint intentionally runs from the repository root so the backend can access both application folders.
