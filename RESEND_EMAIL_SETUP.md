# Resend Email Setup Guide

## Issue: Emails Not Being Received

If you're not receiving password reset emails, follow these steps:

## 1. Verify Environment Variables

Make sure these environment variables are set:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxx  # Your Resend API key
MAIL_FROM=no-reply@nexpense.aially.in  # Or RESEND_FROM_EMAIL
FRONTEND_URL=https://nexpense.aially.in
```

**Important:** The `MAIL_FROM` domain (`nexpense.aially.in`) must be verified in your Resend account.

## 2. Verify Domain in Resend

1. Go to [Resend Dashboard](https://resend.com/domains)
2. Add and verify the domain `nexpense.aially.in`
3. Add the required DNS records (SPF, DKIM, DMARC)
4. Wait for domain verification (usually takes a few minutes)

**Note:** You can also use Resend's test domain for development:
- Use `onboarding@resend.dev` as `MAIL_FROM` (no verification needed)
- This only works for testing, not production

## 3. Check Resend API Key

1. Go to [Resend API Keys](https://resend.com/api-keys)
2. Make sure your API key is active
3. Copy the full API key (starts with `re_`)
4. Set it as `RESEND_API_KEY` environment variable

## 4. Test Email Configuration

### Option A: Use Test Endpoint (Development Only)

```bash
POST http://localhost:4000/api/v1/test-email
Content-Type: application/json

{
  "to": "your-email@example.com"
}
```

This will:
- Show configuration status
- Attempt to send a test email
- Display any errors

### Option B: Check Server Logs

When you request a password reset, check the backend logs for:
- `Resend client initialized successfully` - Good!
- `RESEND_API_KEY not configured` - Bad, check env vars
- `Failed to send password reset email` - Check error details

## 5. Common Issues

### Issue: "Resend not configured"
**Solution:** Set `RESEND_API_KEY` environment variable

### Issue: "Domain not verified"
**Solution:** Verify `nexpense.aially.in` domain in Resend dashboard

### Issue: "Invalid API key"
**Solution:** Check that API key is correct and active in Resend

### Issue: Emails going to spam
**Solution:** 
- Verify domain with proper DNS records
- Use a verified domain (not `@resend.dev` in production)
- Check spam folder

## 6. Quick Test Setup (Development)

For quick testing without domain verification:

```bash
# In your .env file
RESEND_API_KEY=re_your_api_key_here
MAIL_FROM=onboarding@resend.dev  # Test domain, no verification needed
FRONTEND_URL=https://nexpense.aially.in
```

**Note:** `onboarding@resend.dev` only works for testing. For production, you must verify your domain.

## 7. Verify Installation

The `resend` package is already installed (version ^4.0.1). No additional installation needed.

## 8. Check Logs

After requesting a password reset, check your backend logs for:
- Email send attempts
- Configuration status
- Error messages

Look for log entries like:
```
Password reset email sent
Attempting to send email via Resend
Email send result from Resend
```

## Next Steps

1. Verify your Resend API key is set correctly
2. Verify the domain `nexpense.aially.in` in Resend dashboard
3. Test using the test endpoint or check logs
4. Check spam folder if emails still don't arrive
