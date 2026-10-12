# Version 3.2 Implementation Report

## Scope

Prepared the supplied Premium Menswear project for a password-protected private preview deployment. This implementation is source-code and deployment preparation; it has **not** been deployed to the user's hosting account, and no real public URL has been created by this work.

## Implemented

- Server-side preview login page in `frontend/views/preview-login.ejs` with premium styling, accessible form messaging, a show/hide password control, CSRF field, and no business details disclosed before login.
- Preview password generation and verification using salted `crypto.scrypt` hashes with bounded accepted parameters and timing-safe comparison (`backend/lib/preview-auth.js`, `backend/scripts/generate-preview-hash.js`).
- Password hash/config validation that fails startup safely if production preview settings are missing or invalid.
- Preview-specific login rate limiting.
- Server-side gate runs before static assets, image uploads, page routes, API routes, and sitemap handling. Only password-gate resources, `robots.txt`, and a data-free `healthz` endpoint are exempt.
- Protected-response no-store and noindex headers while preview is enabled.
- Preview session regeneration on login, explicit logout, expiry checking, secure production cookies, and separation from administrator privilege.
- Local production administrator bootstrap hash generator and first-start bootstrap path that saves the admin record to the configured data directory; bootstrap-variable guidance now distinguishes ephemeral Render Free from persistent storage (`backend/scripts/generate-admin-bootstrap.js`, `server.js`).
- Configurable external upload path via `MENSWEAR_UPLOAD_DIR`; data/session paths are driven by `MENSWEAR_DATA_DIR`.
- A sanitised `backend/data/seed-site-data.json` is used to initialise public site settings/categories and deliberately starts with no customer enquiries. It does not include local administrator records, appointments, orders, or sessions.
- `deployment/render.yaml` Blueprint for Render Free (`plan: free`) with no persistent disk, production preview gate forced on, generated session secret, and secret-only prompts for preview/admin bootstrap.
- root `.gitignore` tightened to exclude `.env`, local data JSON, sessions, uploads, archives, backups, and dependencies while allowing the safe seed.
- Added automated preview-gate tests.
- `backend/package.json` versioned to `3.2.0`; `.node-version` set to Node 22.

## Data handling

The uploaded development archive contained local administrator, site-data, appointment, order, and session records. These were **not included** in this clean deployment package. The project archive includes only the sanitised public site seed and `.gitkeep` placeholders. The first deployment intentionally starts with no private customer enquiries/appointments/orders and requires a new production administrator, so verify and configure the new production instance accordingly. Existing local project data is not modified by this packaged project; keep the original folder and backups.

The public seed preserves the current public content setup/categories while leaving address and regular opening hours to be configured if absent. No local uploaded images were found in the supplied archive. On Render Free, uploaded images and admin changes are temporary; add stable preview content to the seed before deployment.

## Hosting decision

Render Free is the selected target for this variant because it supports Node/Express services, environment variables, HTTPS provider URLs and Blueprints at no service cost within its limits. It has no persistent disk: local data, sessions, edits and uploads may be lost at spin-down/restart/redeploy. This configuration is for a password-protected preview only, not live business operations. See https://render.com/docs/free.

## Verification notes

- The original Version 3.2 project passed 12 automated tests before the Render Free hosting-profile change.
- JavaScript syntax checks passed for the modified `server.js` and bootstrap script.
- The complete `npm --prefix backend run check` / `npm --prefix backend test` suite could not be rerun against this final working copy because dependency installation did not complete in this environment. Re-run `npm --prefix backend ci`, `npm --prefix backend run check`, and `npm --prefix backend test` locally before deploying.
- The final ZIP must be checked for archive integrity and private-file exclusions before release.

## Not completed here

- No connection to the user's GitHub/Render accounts was available.
- No Render service was created; no public URL exists yet.
- The PowerShell workflow was not executed on a native Windows host.
- No real email provider was tested.
- Full deployed-browser/manual verification remains necessary.

## Required manual verification

1. Create a private Git repository containing the clean package only.
2. Generate and privately configure `PREVIEW_PASSWORD_HASH`.
3. Generate and privately configure initial administrator bootstrap values.
4. Create the Render Blueprint and verify the Free plan is selected.
5. Verify unauthenticated page, image, API and sitemap requests cannot bypass the gate.
6. Log in to the preview and separately to the administrator dashboard.
7. Keep the initial administrator bootstrap environment variables configured on Render Free so the account can be recreated after ephemeral storage resets.
8. Put stable store address/opening-hours/collection information in the seed before deployment; avoid relying on uploaded files for anything permanent.
9. Verify the preview gate and understand that runtime settings/uploads are ephemeral on Render Free.

## Version 3.2 folder reorganisation

The existing templates, browser assets, Express application, storage modules, admin/password scripts, tests, and seed were moved into `frontend/`, `backend/`, and `deployment/`. Code edits in this reorganisation are limited to path/configuration wiring needed for the new locations; business logic, page content, routes, and visual design were not intentionally changed.
