# Premium Menswear Website 3.2

This repository is organised into separate frontend, backend, and deployment folders. The existing website functionality and design are retained; path references were updated only where needed to support the new layout.

## Folder map

- `frontend/`: EJS views and public CSS/JavaScript/assets.
- `backend/`: Express server, application modules, data seed/runtime data, helper scripts, tests, and Node package files.
- `deployment/`: Render Free Blueprint, deployment steps, checklist, and security/implementation reports.

## Quick commands (run from the repository root)

```powershell
npm --prefix backend ci
npm --prefix backend run check
npm --prefix backend test
npm --prefix backend run dev
```

For local setup and Render deployment, read [`deployment/README.md`](deployment/README.md). Set the Render Blueprint Path to `deployment/render.yaml`. The project is not hosted until it is connected to GitHub and deployed from your Render account.
