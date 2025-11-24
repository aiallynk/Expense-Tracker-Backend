# Render Deployment Checklist

Complete step-by-step guide for deploying the Expense Tracker Backend to Render.

## 📋 Table of Contents
1. [Web Service Deployment](#web-service-deployment)
2. [Worker Service Deployment](#worker-service-deployment)
3. [Environment Variables](#environment-variables)
4. [Post-Deployment Verification](#post-deployment-verification)

---

## 🌐 Web Service Deployment

### Step 1: Create New Web Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **Web Service**
3. Connect your GitHub repository:
   - Select your repository: `Expense-Tracker-Backend` (or your repo name)
   - Click **Connect**

### Step 2: Configure Web Service Settings

#### Basic Settings

| Field | Value | Notes |
|-------|-------|-------|
| **Name** | `expense-tracker-backend` | Service name (can be changed) |
| **Region** | `Oregon (US West)` | Choose closest to your users |
| **Branch** | `main` or `master` | Your production branch |
| **Root Directory** | `BACKEND` | ⚠️ **IMPORTANT**: Only if backend is in a subdirectory. If `package.json` is in repo root, leave **EMPTY** |
| **Runtime** | `Node` | Auto-detected |
| **Node Version** | `18` or `20` | Check `package.json` engines.node |
| **Build Command** | `npm install && npm run build` | ⚠️ **CRITICAL**: Must include build step |
| **Start Command** | `npm start` | Runs `node start.js` → `node dist/server.js` |
| **Plan** | `Starter` ($7/month) | Or `Standard` for more resources |

#### Advanced Settings

| Field | Value | Notes |
|-------|-------|-------|
| **Health Check Path** | `/healthz` | ⚠️ **MUST BE**: `/healthz` (not `/health`) |
| **Health Check Interval** | `240` seconds | Default is fine |
| **Auto-Deploy** | `Yes` | Deploy on every push to main branch |
| **Docker** | `No` | We're using native Node.js deployment |

#### Environment Variables

See [Environment Variables](#environment-variables) section below.

### Step 3: Save and Deploy

1. Click **Create Web Service**
2. Render will start building immediately
3. Monitor build logs for errors

---

## ⚙️ Worker Service Deployment

### Step 1: Create New Worker Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **Background Worker**
3. Connect the same GitHub repository

### Step 2: Configure Worker Service Settings

#### Basic Settings

| Field | Value | Notes |
|-------|-------|-------|
| **Name** | `expense-tracker-ocr-worker` | Service name |
| **Region** | `Oregon (US West)` | Same as web service |
| **Branch** | `main` or `master` | Same as web service |
| **Root Directory** | `BACKEND` | ⚠️ **IMPORTANT**: Same as web service |
| **Runtime** | `Node` | Auto-detected |
| **Node Version** | `18` or `20` | Same as web service |
| **Build Command** | `npm install && npm run build` | Same as web service |
| **Start Command** | `npm run worker:prod` | ⚠️ **CRITICAL**: Must be `npm run worker:prod` |
| **Plan** | `Starter` ($7/month) | Or `Standard` for more resources |

#### Advanced Settings

| Field | Value | Notes |
|-------|-------|-------|
| **Auto-Deploy** | `Yes` | Deploy on every push to main branch |
| **Docker** | `No` | Native Node.js deployment |

#### Environment Variables

See [Environment Variables](#environment-variables) section below. Worker needs same vars as web service.

---

## 🔐 Environment Variables

### Required for Both Services

Add these in **Render Dashboard** → **Environment** tab for **both** web and worker services:

#### Application

| Variable | Value | Example |
|----------|-------|---------|
| `NODE_ENV` | `production` | `production` |
| `APP_ENV` | `production` | `production` |
| `PORT` | ⚠️ **Auto-set by Render** | Don't set manually |
| `APP_FRONTEND_URL_APP` | Your frontend app URL | `https://app.example.com` |
| `APP_FRONTEND_URL_ADMIN` | Your admin panel URL | `https://admin.example.com` |

#### Database (MongoDB)

| Variable | Value | Example |
|----------|-------|---------|
| `MONGODB_URI` | MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/` |
| `MONGODB_DB_NAME` | Database name | `expense_tracker` |

#### Authentication (JWT)

| Variable | Value | Notes |
|----------|-------|-------|
| `JWT_ACCESS_SECRET` | Random string (min 32 chars) | Generate: `openssl rand -base64 32` |
| `JWT_REFRESH_SECRET` | Random string (min 32 chars) | Generate: `openssl rand -base64 32` |
| `JWT_ACCESS_EXPIRES_IN` | Token expiration | `15m` (15 minutes) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token expiration | `30d` (30 days) |

#### AWS S3 (Required)

| Variable | Value | Example |
|----------|-------|---------|
| `AWS_REGION` | AWS region | `ap-south-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `S3_BUCKET_NAME` | S3 bucket name | `expense-tracker-aially` |

#### Redis (Required for Worker)

| Variable | Value | Notes |
|----------|-------|-------|
| `REDIS_HOST` | Redis host | Use Render Redis service URL or external Redis |
| `REDIS_PORT` | Redis port | `6379` (default) |
| `REDIS_PASSWORD` | Redis password | If required by your Redis service |
| `REDIS_DB` | Redis database number | `0` (default) |

**Option 1: Use Render Redis Service**
1. Create **Redis** service in Render Dashboard
2. Copy the **Internal Redis URL** (e.g., `redis://red-xxxxx:6379`)
3. Parse it:
   - `REDIS_HOST`: Extract hostname (e.g., `red-xxxxx.render.internal`)
   - `REDIS_PORT`: `6379`
   - `REDIS_PASSWORD`: Usually not needed for Render Redis

**Option 2: Use External Redis (Upstash, Redis Cloud)**
- Use the connection string provided by your Redis service
- Parse host, port, password from connection string

#### Together AI (Optional - for OCR)

| Variable | Value | Notes |
|----------|-------|-------|
| `TOGETHER_AI_API_KEY` | Together AI API key | Required for OCR functionality |
| `TOGETHER_AI_USER_KEY` | Together AI user key | Optional |
| `TOGETHER_AI_MODEL_VISION` | Vision model name | `Qwen/Qwen2.5-VL-72B-Instruct` (default) |

#### Firebase (Optional - for Push Notifications)

| Variable | Value | Notes |
|----------|-------|-------|
| `FIREBASE_PROJECT_ID` | Firebase project ID | Required for push notifications |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email | Required for push notifications |
| `FIREBASE_PRIVATE_KEY` | Firebase private key | Required for push notifications (escape newlines) |
| `FIREBASE_DATABASE_URL` | Firebase database URL | Optional |

#### Resend (Optional - for Email)

| Variable | Value | Notes |
|----------|-------|-------|
| `RESEND_API_KEY` | Resend API key | Required for email functionality |
| `RESEND_FROM_EMAIL` | Sender email | `no-reply@example.com` |

#### Logging (Optional)

| Variable | Value | Default | Notes |
|----------|-------|---------|-------|
| `LOG_LEVEL` | Log level | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_PRETTY` | Pretty logs | `false` | Set to `true` for human-readable logs (not recommended for production) |
| `REQUEST_ID_HEADER` | Request ID header | `X-Request-ID` | Header name for request correlation |

#### OCR Worker (Optional)

| Variable | Value | Default | Notes |
|----------|-------|---------|-------|
| `DISABLE_OCR` | Disable OCR | `false` | Set to `true` to disable OCR processing |
| `OCR_WORKER_CONCURRENCY` | Worker concurrency | `3` | Number of concurrent OCR jobs |

---

## ✅ Post-Deployment Verification

### 1. Check Build Logs

**Web Service:**
```
✓ Build verified: dist/server.js exists
```

**Worker Service:**
```
✓ Build verified: dist/server.js exists
```

### 2. Check Startup Logs

**Web Service should show:**
```
✅ Environment variables validated successfully
[INFO] Starting server
[INFO] MongoDB connected successfully
[INFO] Server listening on port 4000
[INFO] Server started successfully
```

**Worker Service should show:**
```
✅ Environment variables validated successfully
[INFO] MongoDB connected in worker
[INFO] Redis connected
[INFO] OCR worker started
```

### 3. Test Health Endpoint

```bash
curl https://your-service.onrender.com/healthz
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Server is healthy",
  "timestamp": "2024-11-24T18:00:00.000Z",
  "database": {
    "connected": true,
    "status": "connected"
  },
  "redis": {
    "connected": true,
    "status": "connected"
  }
}
```

### 4. Test API Endpoint

```bash
curl https://your-service.onrender.com/api/v1/auth/login \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

---

## 🚨 Common Issues & Solutions

### Issue 1: Build Fails - "dist/server.js not found"

**Solution:**
- Verify **Build Command** is set to: `npm install && npm run build`
- Check build logs for TypeScript errors
- Ensure `tsconfig.json` has `outDir: "./dist"`

### Issue 2: Server Not Starting - "Port already in use"

**Solution:**
- ⚠️ **DON'T** set `PORT` environment variable manually
- Render automatically sets `PORT` - your server should use `process.env.PORT`

### Issue 3: Health Check Failing

**Solution:**
- Verify **Health Check Path** is `/healthz` (not `/health`)
- Check MongoDB connection in logs
- Check Redis connection in logs
- Review startup logs for errors

### Issue 4: Worker Not Processing Jobs

**Solution:**
- Verify worker service is running
- Check Redis connection (worker requires Redis)
- Verify `REDIS_HOST` and `REDIS_PORT` are set correctly
- Check worker logs for errors

### Issue 5: CORS Errors

**Solution:**
- Set `APP_FRONTEND_URL_APP` to your frontend URL
- Set `APP_FRONTEND_URL_ADMIN` to your admin panel URL
- Ensure URLs include protocol (`https://`)

### Issue 6: MongoDB Connection Failed

**Solution:**
- Verify `MONGODB_URI` is correct
- Add Render IPs to MongoDB Atlas whitelist (or allow all IPs: `0.0.0.0/0`)
- Check database user has correct permissions
- Verify `MONGODB_DB_NAME` is correct

### Issue 7: Redis Connection Failed

**Solution:**
- If using Render Redis: Use internal Redis URL
- If using external Redis: Verify connection string
- Check `REDIS_PASSWORD` if required
- Verify Redis service is accessible from Render

### Issue 8: S3 Access Denied

**Solution:**
- Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are correct
- Check IAM user has permissions: `s3:PutObject`, `s3:GetObject`, `s3:CreateBucket`
- Verify `S3_BUCKET_NAME` is correct
- Check `AWS_REGION` matches bucket region

---

## 📊 Quick Reference

### Web Service Summary

```
Name: expense-tracker-backend
Type: Web Service
Build: npm install && npm run build
Start: npm start
Health: /healthz
Port: Auto (process.env.PORT)
```

### Worker Service Summary

```
Name: expense-tracker-ocr-worker
Type: Background Worker
Build: npm install && npm run build
Start: npm run worker:prod
Port: N/A (background worker)
```

### Required Services

1. **Web Service** - Main API server
2. **Worker Service** - OCR job processor
3. **Redis Service** (optional) - For job queue (or use external Redis)
4. **MongoDB** - Database (MongoDB Atlas recommended)
5. **AWS S3** - File storage
6. **Together AI** (optional) - OCR processing

---

## 🔗 Useful Links

- [Render Dashboard](https://dashboard.render.com)
- [Render Documentation](https://render.com/docs)
- [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
- [AWS S3](https://aws.amazon.com/s3/)
- [Together AI](https://together.ai/)
- [Upstash Redis](https://upstash.com/) (Alternative Redis service)

---

## 📝 Deployment Checklist

- [ ] Web service created and configured
- [ ] Worker service created and configured
- [ ] All environment variables set for web service
- [ ] All environment variables set for worker service
- [ ] MongoDB connection string configured
- [ ] Redis connection configured
- [ ] AWS S3 credentials configured
- [ ] CORS URLs configured (`APP_FRONTEND_URL_APP`, `APP_FRONTEND_URL_ADMIN`)
- [ ] Health check endpoint working (`/healthz`)
- [ ] Build succeeds without errors
- [ ] Server starts successfully
- [ ] Worker starts successfully
- [ ] API endpoints responding
- [ ] Database connection verified
- [ ] Redis connection verified (for worker)

---

**Last Updated:** November 24, 2024

