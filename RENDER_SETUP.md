# Render Deployment Setup Guide

## Critical: Build Command Configuration

Render is currently **only running `npm install`** and skipping the build step. You need to configure the build command in Render Dashboard.

### Step 1: Go to Render Dashboard

1. Log in to https://render.com
2. Go to your **expense-tracker-backend** service
3. Click **Settings** → **Build & Deploy**

### Step 2: Set Build Command

In the **Build Command** field, set:

```bash
npm install && npm run build
```

**OR** (if you want to include memory limit):

```bash
NODE_OPTIONS="--max-old-space-size=1024" npm install && npm run build
```

### Step 3: Verify Start Command

Make sure **Start Command** is set to:

```bash
npm start
```

### Step 4: Verify Root Directory

**IMPORTANT**: Make sure **Root Directory** is set correctly:

- **If your GitHub repo root contains `package.json` directly**: Leave Root Directory **EMPTY** (or `.`)
- **If your GitHub repo has a `BACKEND` folder**: Set Root Directory to `BACKEND`

For `Expense-Tracker-Backend` repository, it's likely a dedicated backend repo, so **leave Root Directory EMPTY**.

### Step 5: Save and Redeploy

1. Click **Save Changes**
2. Go to **Manual Deploy** → **Deploy latest commit**

## Why This Happens

Render may not always read `render.yaml` correctly, especially if:
- The service was created manually (not via Blueprint)
- The render.yaml file wasn't detected
- Build command settings in dashboard override render.yaml

## Verification

After deploying, check the build logs. You should see:

```
==> Running build command 'npm install && npm run build'...
==> npm install
... (package installation)
==> npm run build
... (TypeScript compilation)
✓ Build verified: dist/server.js exists
```

If you see `dist/server.js` in the build logs, the build succeeded!

## Troubleshooting

### Build Still Not Running?

1. **Check Render Dashboard Settings**: Go to Settings → Build & Deploy and verify the build command is set
2. **Check render.yaml Location**: Make sure `render.yaml` is in the repository root (or BACKEND folder if using Root Directory)
3. **Use Blueprint**: If render.yaml isn't working, try creating a new service via Blueprint (New + → Blueprint)

### Build Fails with Memory Error?

Increase memory limit in build command:
```bash
NODE_OPTIONS="--max-old-space-size=2048" npm install && npm run build
```

### dist/server.js Still Not Found?

1. Check build logs for TypeScript compilation errors
2. Verify `tsconfig.json` has correct `outDir: "./dist"`
3. Check that `src/server.ts` exists and compiles without errors

