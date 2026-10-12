# Premium Menswear Website 3.2 — Render Free Private Preview

This package is prepared for **Render's Free Web Service plan**. It deploys the existing Node.js/Express website behind a password gate and uses Render's HTTPS `onrender.com` address. The service is **not deployed yet**; the URL will only exist after you connect the project to GitHub and create the Render service in your own accounts.

> **Important limitation:** Render Free's filesystem is ephemeral. This is suitable for previewing the design, not for running day-to-day business operations. Uploaded photos, admin changes, JSON records, sessions, and edits made through the admin dashboard can disappear when the service spins down, restarts, or redeploys. Render confirms free web services spin down after 15 minutes without traffic and take about a minute to start on the next request. See [Render's Free service limitations](https://render.com/docs/free).

## Included

- Premium Menswear website with EJS pages and Express server.
- Server-side preview gate protecting pages, CSS/JavaScript assets, uploaded images, content endpoints, APIs, and sitemap.
- Separate preview and administrator authentication.
- Preview-login rate limiting, HTTP-only cookies, secure cookies in production, session expiry, and logout.
- Render Blueprint configured with `plan: free`, HTTPS, health check, generated session secret, and private environment-variable prompts.
- Sanitised public site seed; no customer enquiries, appointments, tailoring orders, administrator record, local sessions, or uploaded business photos are included.
- Tests for the preview gate and appointment/order behaviour.

## Project structure

```text
premium-menswear-site/
├── frontend/
│   ├── public/        # CSS, browser JavaScript, favicon, uploads
│   └── views/         # EJS page templates and partials
├── backend/
│   ├── server.js      # Express application entry point
│   ├── lib/           # Storage, notifications, sessions, preview auth
│   ├── data/          # Safe seed and runtime JSON data
│   ├── scripts/       # Admin/password helpers and template checks
│   ├── tests/         # Automated tests
│   ├── package.json
│   ├── package-lock.json
│   └── .env.example
├── deployment/        # Render Blueprint and deployment/security docs
├── .gitignore
└── .node-version
```

`deployment/render.yaml` deliberately leaves Render's service root at the repository root. This is important because the Express backend must be able to read both `backend/` and the sibling `frontend/` directory at runtime.

## Before deploying

1. Use the clean package in a new folder. Do not overwrite your original working project.
2. Configure your real business information and any permanent preview content in `backend/data/seed-site-data.json` **before pushing to GitHub**. On Render Free, dashboard edits are temporary and can be lost.
3. Generate the preview password hash and production administrator hash using the commands below.
4. Keep the GitHub repository private and never commit `.env`, real customer data, hashes, uploaded photos, sessions, or backups.
5. Share the preview URL and raw password separately with invited viewers. A shared password can be forwarded by anyone who receives it.

## Requirements

- Node.js 22 recommended (also supports Node.js 20+).
- npm and Git.
- GitHub account and Render account.

## Local setup in VS Code (Windows)

Open the extracted repository root in VS Code and choose **Terminal → New Terminal**. The main source folders are `frontend/`, `backend/`, and `deployment/`. Run:

```powershell
npm --prefix backend ci
Copy-Item backend/.env.example backend/.env
npm --prefix backend run check
npm --prefix backend test
```

Generate the private-preview password hash:

```powershell
npm --prefix backend run preview:hash
```

The password is entered without echo. Copy the resulting `PREVIEW_PASSWORD_HASH=...` line into `backend/.env`. For local preview mode, set `PREVIEW_GATE_ENABLED=true` and paste the hash into `PREVIEW_PASSWORD_HASH`. Set `SESSION_SECRET` to a unique random value of at least 32 characters. Generate a secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Start locally with `npm --prefix backend run dev` and open `http://localhost:3000`. Use `Ctrl+C` to stop the server. The preview password is not the administrator password.

## Step 1 — Generate production credentials

Run both scripts from the project root:

```powershell
npm --prefix backend run preview:hash
npm --prefix backend run admin:bootstrap-hash
```

The first command prints `PREVIEW_PASSWORD_HASH`. The second prints `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_BCRYPT_HASH`. The raw passwords are not printed. Use different passwords for the preview gate and administrator account. Keep all generated values private; do not commit them or paste them into chat.

## Step 2 — Push the project to a private GitHub repository

1. Create a new **private** repository on GitHub. Do not add a README, license, or `.gitignore` from GitHub if the repository already contains the supplied package contents.
2. Open the extracted project root in VS Code. It must be the repository root containing `frontend`, `backend`, and `deployment`. The Node package is in `backend/`, and the Render Blueprint is `deployment/render.yaml`.
3. In the terminal, run:

```powershell
git init
git branch -M main
git status --short
git add .
git status --short
git diff --cached --name-only
```

Review the staged list. Only add the supplied source, templates, public assets, sanitised seed, tests, and documentation. If you see `backend/.env`, `backend/data/admin.json`, `backend/data/site-data.json`, appointment/order data, sessions, local uploads, password hashes, keys, or backups, stop and remove them from staging. The supplied `.gitignore` is intended to exclude these files, but reviewing staged files is still important.

Then commit and push, replacing the example URL with your own private repository URL:

```powershell
git commit -m "Prepare Premium Menswear private preview v3.2"
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-PRIVATE-REPOSITORY.git
git push -u origin main
```

Do not put a personal access token in the remote URL.

## Step 3 — Create the Render Free service

1. Open the [Render Dashboard](https://dashboard.render.com/).
2. Choose **New → Blueprint** (the exact label may vary).
3. Connect the private GitHub repository, then set the Blueprint Path to `deployment/render.yaml` (Render supports custom Blueprint paths).
4. Review the Blueprint. It must show the **Free** plan. The supplied config intentionally has **no persistent disk** and does not attach a paid database.
5. When prompted for environment variables, enter the values you generated locally:
   - `PREVIEW_PASSWORD_HASH`: full output value from `npm --prefix backend run preview:hash`.
   - `INITIAL_ADMIN_USERNAME`: username from `npm --prefix backend run admin:bootstrap-hash`.
   - `INITIAL_ADMIN_BCRYPT_HASH`: bcrypt hash from `npm --prefix backend run admin:bootstrap-hash`.
6. Confirm `NODE_ENV=production` and `PREVIEW_GATE_ENABLED=true`. Render generates `SESSION_SECRET` through the Blueprint. Do not set `ALLOW_PUBLIC_PRODUCTION=true`.
7. Start deployment and watch the build/runtime logs. The build command is `npm --prefix backend ci` and the start command is `npm --prefix backend start`.

If the Blueprint doesn't prompt for a secret value, open the service's **Environment** settings and add it there, then redeploy. Don't enter raw passwords into environment variables; enter only the generated hashes.

### Keep the bootstrap values for Render Free

For this Free deployment, **leave `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_BCRYPT_HASH` in Render's Environment settings**. The host filesystem can reset, so the administrator record may need to be recreated on a later startup. The application removes these values only from the running process after the first successful bootstrap; the saved Render environment values remain available for a future process start. If you later move to persistent storage, review the production bootstrap guidance before removing them.

## Step 4 — Verify the live preview

Once deployment succeeds, Render will display the actual HTTPS URL. It will resemble `https://your-service-name.onrender.com`, but the exact address is assigned by Render and cannot be known beforehand.

Test in a private/incognito browser window:

- The homepage and direct website pages show the password gate when not authenticated.
- A wrong preview password is rejected.
- The correct preview password opens the site.
- Direct image/upload paths and content routes do not bypass the gate.
- Preview access does not grant administrator access; the admin needs its own credentials.
- `/healthz` returns only `ok`.

Before you share the preview, check business name, contact numbers, address, opening hours, map and actual store photography. Avoid uploading important data through the dashboard because Render Free does not preserve uploaded files. Add information you want to persist through preview restarts to `backend/data/seed-site-data.json` before deployment, then commit and push the change to redeploy.

## Free plan behaviour you should expect

- **Cost:** Render lists a Free plan for web services. Stay on the Free plan when creating the service and check the dashboard's final resource summary before confirming. Included usage limits apply.
- **Cold starts:** the app spins down after 15 minutes without inbound traffic; the next visit can take about a minute to wake up.
- **Ephemeral filesystem:** uploaded images, admin changes, site settings, enquiries, appointments, orders and local sessions can be lost on spin-down, restart, or redeploy. The sanitized seed is used to initialise site content again when needed.
- **Usage cap:** Render provides 750 free instance hours per workspace per calendar month; usage across services counts toward the allowance. Exceeding included bandwidth or build usage may suspend service or cause charges depending on account settings. Review [Render's official Free plan details](https://render.com/docs/free) before deployment.
- **Not for live operations:** do not rely on this version to store real customer bookings, orders, enquiries or uploaded photographs. Use it to preview the website with a small invited audience.

## Security notes

- `PREVIEW_GATE_ENABLED=true` is mandatory for this private production preview. The server fails closed if the gate hash is missing or malformed.
- The preview password gives visitors preview access only; it does not grant administrator rights.
- Never set `ALLOW_PUBLIC_PRODUCTION=true` for the private preview.
- Keep the repository private and generated hashes/secrets out of source control.
- Change the preview password by regenerating its hash with `npm --prefix backend run preview:hash`, updating `PREVIEW_PASSWORD_HASH` in Render Environment settings, then redeploying. Test the new password in an incognito window.
- The rate limiter and file-backed session store are process-local/single-instance designs. Do not scale this package to multiple instances without migrating those components to shared services and reviewing the data-storage design.

## Troubleshooting

**The deploy fails at startup:** check Render logs and confirm all three secret values exist, `SESSION_SECRET` was generated, and `PREVIEW_GATE_ENABLED=true`. Do not solve the error by disabling the preview gate.

**The preview password is rejected:** regenerate the hash locally and replace the complete `PREVIEW_PASSWORD_HASH` value in Render Environment settings. Never use the raw password as the hash.

**The site is unexpectedly public without a password:** treat this as a security incident. Stop sharing the URL, check `PREVIEW_GATE_ENABLED=true`, and redeploy the correct package. Never enable `ALLOW_PUBLIC_PRODUCTION`.

**Changes/uploads disappear:** this is expected on Render Free because its filesystem is ephemeral. Restore desired showcase content in `backend/data/seed-site-data.json` and redeploy. Do not store real customer operations data on this deployment.

## Future business launch

Before using the website for real business enquiries, orders, appointments, permanent content or uploads, migrate JSON data and sessions to a persistent external service and move images to durable object storage, or use a host plan with suitable persistent storage. Re-test security and backup/restore procedures before making the site publicly available.
