-- Migration: Add notification_key for idempotency and unique constraints
-- Purpose: Prevent duplicate notifications and approval logs
-- Date: 2026-01-30

-- Step 1: Add notification_key column to notifications table
ALTER TABLE notifications 
ADD COLUMN notification_key VARCHAR(255);

-- Step 2: Create unique index on notification_key (prevents duplicates)
CREATE UNIQUE INDEX idx_notifications_key 
ON notifications(notification_key) 
WHERE notification_key IS NOT NULL;

-- Step 3: Add unique constraint to approval_logs to prevent duplicate logs
-- This prevents the same approver from having duplicate log entries for the same action
CREATE UNIQUE INDEX idx_approval_logs_unique 
ON approval_logs(report_id, approver_id, action);

-- Step 4: Add index on notifications for faster lookups
CREATE INDEX idx_notifications_user_report 
ON notifications(user_id, report_id, type);

-- Step 5: Add index on approval_logs for faster queries
CREATE INDEX idx_approval_logs_report 
ON approval_logs(report_id, created_at DESC);

-- Note: notification_key format: {companyId}:{reportId}:{approverId}:{type}
-- Example: "123:456:789:APPROVAL_REQUIRED"
