# 🚀 Render Quick Deploy Reference

Quick reference card for deploying to Render. For detailed instructions, see [RENDER_DEPLOYMENT_CHECKLIST.md](./RENDER_DEPLOYMENT_CHECKLIST.md).

---

## 🌐 Web Service Settings

| Setting | Value |
|---------|-------|
| **Type** | Web Service |
| **Name** | `expense-tracker-backend` |
| **Region** | `Oregon (US West)` |
| **Branch** | `main` |
| **Root Directory** | `BACKEND` (or empty if package.json in root) |
| **Runtime** | `Node` |
| **Node Version** | `18` or `20` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |
| **Health Check Path** | `/healthz` |
| **Plan** | `Starter` ($7/month) |

---

## ⚙️ Worker Service Settings

| Setting | Value |
|---------|-------|
| **Type** | Background Worker |
| **Name** | `expense-tracker-ocr-worker` |
| **Region** | `Oregon (US West)` |
| **Branch** | `main` |
| **Root Directory** | `BACKEND` (same as web service) |
| **Runtime** | `Node` |
| **Node Version** | `18` or `20` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm run worker:prod` |
| **Plan** | `Starter` ($7/month) |

---

## 🔐 Required Environment Variables

### Both Services Need:

```bash
# Application
NODE_ENV=production
APP_ENV=production
APP_FRONTEND_URL_APP=https://your-frontend.com
APP_FRONTEND_URL_ADMIN=https://your-admin.com

# MongoDB
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/
MONGODB_DB_NAME=expense_tracker

# JWT (generate with: openssl rand -base64 32)
JWT_ACCESS_SECRET=your-32-char-secret-minimum
JWT_REFRESH_SECRET=your-32-char-secret-minimum
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d

# AWS S3
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET_NAME=expense-tracker-aially

# Redis (for worker)
REDIS_HOST=red-xxxxx.render.internal  # or external Redis host
REDIS_PORT=6379
REDIS_PASSWORD=  # if required
REDIS_DB=0
```

### Optional:

```bash
# Together AI (for OCR)
TOGETHER_AI_API_KEY=your-api-key
TOGETHER_AI_USER_KEY=your-user-key
TOGETHER_AI_MODEL_VISION=Qwen/Qwen2.5-VL-72B-Instruct

# Firebase (for push notifications)
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-project.firebaseio.com

# Resend (for email)
RESEND_API_KEY=your-api-key
RESEND_FROM_EMAIL=no-reply@example.com

# Logging
LOG_LEVEL=info
LOG_PRETTY=false
REQUEST_ID_HEADER=X-Request-ID

# OCR Worker
DISABLE_OCR=false
OCR_WORKER_CONCURRENCY=3
```

---

## ✅ Quick Verification

### 1. Build Success
Check logs for:
```
✓ Build verified: dist/server.js exists
```

### 2. Server Started
Check logs for:
```
[INFO] Server listening on port 4000
[INFO] Server started successfully
```

### 3. Health Check
```bash
curl https://your-service.onrender.com/healthz
```

Should return:
```json
{
  "success": true,
  "message": "Server is healthy",
  "database": { "connected": true },
  "redis": { "connected": true }
}
```

---

## 🚨 Common Fixes

| Problem | Solution |
|---------|----------|
| Build fails | Set Build Command: `npm install && npm run build` |
| Port error | Don't set `PORT` env var - Render sets it automatically |
| Health check fails | Set Health Check Path to `/healthz` |
| CORS errors | Set `APP_FRONTEND_URL_APP` and `APP_FRONTEND_URL_ADMIN` |
| MongoDB error | Add Render IPs to MongoDB Atlas whitelist |
| Redis error | Use Render Redis internal URL or external Redis connection string |
| Worker not working | Verify Redis connection and `npm run worker:prod` command |

---

## 📋 Deployment Steps

1. **Create Web Service**
   - New + → Web Service
   - Connect GitHub repo
   - Fill settings from table above
   - Add environment variables
   - Deploy

2. **Create Worker Service**
   - New + → Background Worker
   - Connect same GitHub repo
   - Fill settings from table above
   - Add same environment variables
   - Deploy

3. **Verify**
   - Check build logs
   - Check startup logs
   - Test `/healthz` endpoint
   - Test API endpoints

---

**Need more details?** See [RENDER_DEPLOYMENT_CHECKLIST.md](./RENDER_DEPLOYMENT_CHECKLIST.md)

