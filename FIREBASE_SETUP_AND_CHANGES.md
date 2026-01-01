# Firebase Push Notifications Setup & TypeScript Fixes

## 📋 Table of Contents
1. [Changes Made](#changes-made)
2. [Firebase Setup on Render](#firebase-setup-on-render)
3. [Environment Variables](#environment-variables)
4. [Testing](#testing)

---

## 🔧 Changes Made

### 1. TypeScript Compilation Fixes

#### **auth.service.ts**
- **Fixed type errors** related to `UserRole` enum vs `string` type mismatches
- Added explicit type annotations (`string[]`) for `allRoles` arrays
- Updated `AuthResult` interface to include optional `roles` and `requiresRoleSelection` properties
- Fixed type casting for `roleToUse` variables

**Key Changes:**
```typescript
// Before: const allRoles = [user.role];
// After:
const allRoles: string[] = [user.role];

// Before: let roleToUse = selectedRole;
// After:
let roleToUse: string = selectedRole;
```

#### **notification.service.ts**
- **Removed unused import**: Removed `mongoose` import that was causing TS6133 error
- Note: `mongoose` is still used via `mongoose.Types.ObjectId` in type annotations, but the direct import was unnecessary

#### **Notification.ts (Model)**
- **Added missing enum value**: Added `REPORT_CHANGES_REQUESTED` to `NotificationType` enum
- This was needed for report change request notifications

```typescript
export enum NotificationType {
  REPORT_SUBMITTED = 'report_submitted',
  REPORT_APPROVED = 'report_approved',
  REPORT_REJECTED = 'report_rejected',
  REPORT_CHANGES_REQUESTED = 'report_changes_requested', // ✅ Added
  // ... other types
}
```

#### **businessHead.service.ts**
- **Fixed enum reference**: Changed from `NotificationType.REPORT_CHANGES_REQUESTED || NotificationType.REPORT_REJECTED` to just `NotificationType.REPORT_CHANGES_REQUESTED`
- Removed incorrect logical OR operator in enum assignment

#### **reports.service.ts**
- **Removed unused imports**: Removed `getUserCompanyId` and `validateCompanyAccess` from imports
- Kept only `buildCompanyQuery` which is actually used
- **Fixed type casting**: Added proper type cast for `reportUser._id` to `mongoose.Types.ObjectId`

#### **expenses.service.ts**
- **Fixed type error**: Added proper type casting for `id` parameter in `reportIds.some()` callback
- Changed from `(id: mongoose.Types.ObjectId)` to `(id: unknown)` with proper casting

#### **export.service.ts**
- **Removed unused variable**: Removed unused `companySettings` variable declaration
- **Fixed type errors**: Added `as any` type casting for `costCentre` variables to handle populated Mongoose documents
- **Removed unused variable**: Removed unused `titleRow` variable

---

## 🔥 Firebase Setup on Render

### Prerequisites
1. Firebase Project created in [Firebase Console](https://console.firebase.google.com/)
2. Firebase Admin SDK service account key downloaded
3. Render account with backend service deployed

### Step-by-Step Guide

#### 1. **Get Firebase Service Account Credentials**

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to **Project Settings** (gear icon) → **Service Accounts** tab
4. Click **Generate New Private Key**
5. Download the JSON file (e.g., `firebase-service-account.json`)

#### 2. **Extract Required Values from Service Account JSON**

Open the downloaded JSON file and extract these values:

```json
{
  "project_id": "your-project-id",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com"
}
```

**Important Notes:**
- The `private_key` contains newline characters (`\n`) - keep them as-is
- The private key should start with `-----BEGIN PRIVATE KEY-----`
- Do NOT commit this JSON file to version control

#### 3. **Set Environment Variables on Render**

1. Go to your Render dashboard
2. Navigate to your **Backend Service**
3. Click on **Environment** tab
4. Click **Add Environment Variable** for each of the following:

##### **Required Firebase Environment Variables:**

| Variable Name | Description | Example Value |
|--------------|-------------|---------------|
| `FIREBASE_PROJECT_ID` | Your Firebase project ID | `nexpense-production` |
| `FIREBASE_CLIENT_EMAIL` | Service account client email | `firebase-adminsdk-xxxxx@nexpense.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | Service account private key (with `\n` preserved) | `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n` |
| `FIREBASE_DATABASE_URL` | (Optional) Firebase Realtime Database URL | `https://nexpense-default-rtdb.firebaseio.com` |

##### **How to Add the Private Key on Render:**

**Option 1: Single Line (Recommended)**
- Copy the entire private key from the JSON file
- Paste it directly into the Render environment variable field
- Render will preserve the newline characters (`\n`)

**Option 2: Escaped Format**
If Option 1 doesn't work, escape the newlines:
```
-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n
```

**Option 3: Base64 Encoding (Alternative)**
If you prefer, you can base64 encode the entire private key:
```bash
# On your local machine
cat firebase-service-account.json | jq -r '.private_key' | base64
```
Then set `FIREBASE_PRIVATE_KEY_BASE64` and decode it in your code (requires code changes).

#### 4. **Verify Environment Variables**

After setting the variables:
1. Click **Save Changes**
2. Render will automatically redeploy your service
3. Check the deployment logs to verify Firebase initialization

**Expected Log Output:**
```
[INFO] Firebase Admin initialized successfully
```

If you see:
```
[INFO] Firebase not configured - push notifications disabled
```
This means one or more environment variables are missing or incorrect.

#### 5. **Test Firebase Connection**

After deployment, check your application logs for:
- ✅ `Firebase Admin initialized successfully` - Firebase is working
- ❌ `Firebase not configured - push notifications disabled` - Check environment variables
- ❌ `Failed to initialize Firebase Admin: ...` - Check private key format

---

## 📝 Environment Variables Summary

### Backend (.env or Render Environment Variables)

```bash
# Firebase Configuration
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com  # Optional

# Other required variables (existing)
MONGODB_URI=mongodb://...
JWT_SECRET=...
# ... etc
```

### Web App (.env or Vite Environment Variables)

```bash
# Firebase Web Configuration
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef123456
VITE_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX  # Optional
VITE_FIREBASE_VAPID_KEY=BG...  # Web Push VAPID key
```

### Flutter App

- `google-services.json` should be placed in `android/app/`
- No additional environment variables needed (uses `google-services.json`)

---

## 🔍 Verification Checklist

### Backend Verification
- [ ] All environment variables set on Render
- [ ] Backend logs show "Firebase Admin initialized successfully"
- [ ] `/notifications/register-token` endpoint accepts POST requests
- [ ] FCM tokens are stored in `NotificationToken` collection

### Web App Verification
- [ ] All `VITE_FIREBASE_*` variables set
- [ ] Browser console shows "FCM token: ..." after login
- [ ] Notifications appear when app is in foreground
- [ ] Token is registered with backend

### Flutter App Verification
- [ ] `google-services.json` is in `android/app/`
- [ ] App requests notification permission on first launch
- [ ] FCM token is generated and logged
- [ ] Token is registered with backend
- [ ] Notifications appear in all states (foreground, background, terminated)

---

## 🚨 Common Issues & Solutions

### Issue 1: "Firebase not configured" in logs
**Solution:**
- Verify all three required variables are set: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- Check that private key includes `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
- Ensure private key newlines are preserved

### Issue 2: "Invalid private key format"
**Solution:**
- Private key must start with `-----BEGIN PRIVATE KEY-----`
- Ensure newline characters (`\n`) are preserved
- Don't remove or modify the key format

### Issue 3: "Failed to initialize Firebase Admin"
**Solution:**
- Verify project ID matches your Firebase project
- Check client email is correct (should end with `.iam.gserviceaccount.com`)
- Ensure service account has proper permissions in Firebase Console

### Issue 4: Notifications not sending
**Solution:**
- Check backend logs for FCM token registration
- Verify tokens exist in `NotificationToken` collection
- Check that `sendPushToUser` is being called with correct `userId`
- Verify company isolation is working (user has `companyId`)

---

## 📚 Additional Resources

- [Firebase Admin SDK Setup](https://firebase.google.com/docs/admin/setup)
- [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging)
- [Render Environment Variables](https://render.com/docs/environment-variables)
- [FCM Token Management](https://firebase.google.com/docs/cloud-messaging/manage-tokens)

---

## ✅ Summary

All TypeScript compilation errors have been fixed:
- ✅ Fixed 10 errors in `auth.service.ts`
- ✅ Fixed 1 error in `businessHead.service.ts`
- ✅ Fixed 1 error in `expenses.service.ts`
- ✅ Fixed 4 errors in `export.service.ts`
- ✅ Fixed 1 error in `notification.service.ts`
- ✅ Fixed 3 errors in `reports.service.ts`
- ✅ Added missing `REPORT_CHANGES_REQUESTED` enum value

**Total: 20 errors fixed across 6 files**

The backend now compiles successfully and is ready for deployment with Firebase push notifications enabled.

---

**Last Updated:** $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

