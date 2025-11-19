# Deploying Backend to Render

This guide will help you deploy your Expense Tracker Backend to Render.

## Prerequisites

1. A Render account (sign up at https://render.com)
2. Your backend code pushed to a Git repository (GitHub, GitLab, or Bitbucket)
3. MongoDB database URI (you can use MongoDB Atlas or Render's MongoDB service)
4. All required API keys and secrets

## Step 1: Prepare Your Repository

Make sure your backend code is in a Git repository and pushed to GitHub/GitLab/Bitbucket.

## Step 2: Create a New Web Service on Render

1. Log in to your Render dashboard
2. Click **"New +"** → **"Web Service"**
3. Connect your repository (GitHub/GitLab/Bitbucket)
4. Select the repository containing your backend

## Step 3: Configure the Service

### Basic Settings

- **Name**: `expense-tracker-backend` (or your preferred name)
- **Environment**: `Node`
- **Region**: Choose closest to your users (e.g., `Oregon`)
- **Branch**: `main` (or your default branch)
- **Root Directory**: **IMPORTANT**: Set this to `BACKEND` (not `/opt/render/project/src/npm install`)
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`

### Root Directory Fix

The error you're seeing (`Service Root Directory "/opt/render/project/src/npm install" is missing`) happens because Render is looking in the wrong directory. 

**Solution**: In the Render dashboard, under "Settings" → "Build & Deploy", set:
- **Root Directory**: `BACKEND`

This tells Render that your backend code is in the `BACKEND` folder, not at the root of your repository.

## Step 4: Set Environment Variables

Go to **"Environment"** tab in Render dashboard and add all required variables:

### Required Environment Variables

```bash
# Application
APP_ENV=production
NODE_ENV=production

# MongoDB (use MongoDB Atlas or Render MongoDB)
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
MONGODB_DB_NAME=expense_tracker

# JWT Secrets (generate strong random strings)
JWT_ACCESS_SECRET=your_access_secret_key_min_32_chars
JWT_REFRESH_SECRET=your_refresh_secret_key_min_32_chars
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d

# AWS S3
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
S3_BUCKET_NAME=expense-tracker-aially

# Together AI
TOGETHER_AI_API_KEY=your_together_ai_api_key
TOGETHER_AI_USER_KEY=your_together_ai_user_key
TOGETHER_AI_MODEL_VISION=Qwen/Qwen2.5-VL-72B-Instruct

# Firebase (if using)
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-project.firebaseio.com

# Resend (for emails)
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=no-reply@aially.in

# Frontend URLs (update with your actual frontend URLs)
APP_FRONTEND_URL_APP=https://your-frontend-app.com
APP_FRONTEND_URL_ADMIN=https://your-admin-app.com

# Logging
LOG_LEVEL=info
```

**Note**: 
- `PORT` is automatically provided by Render - **DO NOT** set it manually
- For `FIREBASE_PRIVATE_KEY`, paste the entire key including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
- Make sure all secrets are strong and secure

## Step 5: Deploy

1. Click **"Create Web Service"**
2. Render will automatically:
   - Clone your repository
   - Install dependencies (`npm install`)
   - Build TypeScript (`npm run build`)
   - Start the server (`npm start`)

3. Monitor the build logs to ensure everything builds successfully
4. Once deployed, your API will be available at: `https://your-service-name.onrender.com`

## Step 6: Verify Deployment

1. Check the health endpoint: `https://your-service-name.onrender.com/health`
2. Test your API endpoints
3. Check logs in Render dashboard for any errors

## Troubleshooting

### Error: "Service Root Directory is missing"

**Solution**: Set the Root Directory to `BACKEND` in Render dashboard settings.

### Build Fails

- Check build logs in Render dashboard
- Ensure all dependencies are in `package.json`
- Verify Node.js version compatibility (your app requires Node >= 18)

### Server Won't Start

- Check start logs in Render dashboard
- Verify all environment variables are set correctly
- Ensure MongoDB connection string is valid
- Check that `PORT` environment variable is not manually set (Render provides it automatically)

### Database Connection Issues

- Verify MongoDB URI is correct
- Check if MongoDB Atlas IP whitelist includes Render's IPs (or use 0.0.0.0/0 for testing)
- Ensure database credentials are correct

### CORS Issues

- Update `APP_FRONTEND_URL_APP` and `APP_FRONTEND_URL_ADMIN` with your actual frontend URLs
- Check CORS configuration in `src/app.ts`

## Using render.yaml (Alternative Method)

If you prefer using `render.yaml`:

1. The `render.yaml` file is already created in the `BACKEND` folder
2. In Render dashboard, go to **"New +"** → **"Blueprint"**
3. Connect your repository
4. Render will automatically detect and use `render.yaml`
5. Still set Root Directory to `BACKEND` if prompted
6. Add environment variables in the dashboard (render.yaml doesn't store secrets)

## Environment-Specific Notes

- **Production**: Set `APP_ENV=production` for production deployments
- **Staging**: You can create a separate service with `APP_ENV=staging`
- **Health Checks**: Render will automatically check `/health` endpoint

## Next Steps

After successful deployment:

1. Update your frontend to use the new backend URL
2. Set up custom domain (optional) in Render dashboard
3. Configure auto-deploy from your main branch
4. Set up monitoring and alerts

## Support

If you encounter issues:
1. Check Render logs in the dashboard
2. Verify all environment variables are set
3. Test locally with the same environment variables
4. Check Render status page: https://status.render.com

