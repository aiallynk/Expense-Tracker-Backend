# Super Admin Metrics - Data Source Documentation

Every metric in the Super Admin analytics system must be strictly real-time and verifiable. This document lists each metric with its exact data source, aggregation pipeline, and validation metadata.

## Validation Metadata Schema

Every analytics API response includes:

```json
{
  "_meta": {
    "fetchedAt": "ISO8601 timestamp",
    "source": "db_aggregation" | "redis_counter" | "live_metric",
    "validated": true,
    "cacheUsed": false
  }
}
```

- **fetchedAt**: When the data was fetched from source
- **source**: How the data was obtained
- **validated**: Whether all values passed validation (no placeholders)
- **cacheUsed**: Always `false` (no caching for Super Admin analytics)

---

## Dashboard Metrics (`GET /super-admin/dashboard/stats`)

| Metric | Data Source | Aggregation / Query | Validation |
|--------|-------------|---------------------|------------|
| totalCompanies | Company | `Company.countDocuments()` | OK |
| activeCompanies | Company | `Company.countDocuments({ status: ACTIVE })` | OK |
| mrr | ExpenseReport (approved) | Aggregate approved reports by month, sum totalAmount | OK if derivable; else N/A |
| arr | Derived | mrr × 12 | OK |
| totalUsers | User | `User.countDocuments()` | OK |
| activeUsers | User | `User.countDocuments({ status: ACTIVE })` | OK |
| storageUsed | Receipt | `Receipt.aggregate([{ $group: { _id: null, total: { $sum: '$sizeBytes' } } }])` → bytes to GB | OK |
| ocrUsage | OcrJob | `OcrJob.countDocuments({ status: COMPLETED })` | OK |
| reportsCreated | ExpenseReport | `ExpenseReport.countDocuments()` | OK |
| expensesCreated | Expense | `Expense.countDocuments()` | OK |
| receiptsUploaded | Receipt | `Receipt.countDocuments()` | OK |
| userTrend | User | `((newUsersThisMonth - newUsersLastMonth) / newUsersLastMonth) * 100` | OK |
| reportTrend | ExpenseReport | `((reportsThisMonth - reportsLastMonth) / reportsLastMonth) * 100` | OK |
| storageTrend | Receipt | `((storageThisMonth - storageLastMonth) / storageLastMonth) * 100` | OK |
| totalAmountApproved | ExpenseReport | `$match APPROVED`, `$group { $sum: '$totalAmount' }` | OK |
| approvedReports | ExpenseReport | `countDocuments({ status: APPROVED })` | OK |
| approvedExpenses | Expense | `countDocuments({ status: APPROVED })` | OK |

---

## System Analytics Metrics (`GET /super-admin/system-analytics/detailed`)

| Metric | Data Source | Aggregation / Counter Key | Validation |
|--------|-------------|---------------------------|------------|
| apiRequestsLastHour | ApiRequestLog or Redis | `sa:api:hour:{YYYYMMDDHH}` or `ApiRequestLog.countDocuments({ createdAt: { $gte: oneHourAgo } })` | OK |
| errorRate | ApiRequestLog or Redis | `sa:api:errors:hour:{YYYYMMDDHH}` / apiRequests or DB count 4xx/5xx | OK |
| peakConcurrentUsers | User | `User.countDocuments({ status: ACTIVE })` (renamed: activeUsersCount) | OK |
| ocrQueueSize | OcrJob | `OcrJob.countDocuments({ status: { $in: [QUEUED, PROCESSING] } })` | OK |
| avgResponseLatency | ApiRequestLog | `$group { $avg: '$responseTime' }` | OK |
| avgApprovalTime | ExpenseReport | `$match APPROVED`, `$project { diff: approvedAt - submittedAt }`, `$group { $avg: '$diff' }` (hours) | OK |
| storage growthRate | Receipt | Aggregate by month, compute `((thisMonth - lastMonth) / lastMonth) * 100` | OK |
| systemStatus | Live checks | S3/DB/Queue health checks; return `source: 'unavailable'` if not implemented | OK |

---

## Company Analytics Metrics (`GET /super-admin/companies/:id/analytics`)

| Metric | Data Source | Aggregation | Validation |
|--------|-------------|-------------|------------|
| ocr.* | OcrJob + Receipt | Filter by company receipts; count/aggregate | OK |
| reports.* | ExpenseReport | Filter by company userIds; live aggregation | OK |
| apiUsage.* | ApiRequestLog | Filter by company userIds | OK |
| storage.* | Receipt | `$sum: '$sizeBytes'` for company expenses | OK |
| financial.* | ExpenseReport | Approved reports aggregation | OK |
| receipts.* | Receipt | Filter by company expenseIds | OK |
| avgApprovalTime | ExpenseReport | Same as system analytics, company-filtered | OK |
| storage growthRate | Receipt | Same as system analytics, company-filtered | OK |

---

## Company Signups Chart

| Metric | Data Source | Aggregation | Validation |
|--------|-------------|-------------|------------|
| companySignups | Company | `Company.aggregate([{ $match: { createdAt: { $gte: startDate } } }, { $group: { _id: { year, month, day }, signups: { $sum: 1 } } }])` | OK |

**Note**: Do NOT use `CompanyAdmin.aggregate` - that counts admin records, not company signups.

---

## Redis Counter Keys (when Redis available)

| Key | Increment On | TTL |
|-----|--------------|-----|
| `sa:api:hour:{YYYYMMDDHH}` | Every API request | 2 hours |
| `sa:api:errors:hour:{YYYYMMDDHH}` | API 4xx/5xx response | 2 hours |

---

## Removed / Deprecated

- **companyAnalyticsSnapshot**: Replaced with live DB aggregation
- **cacheService** for system analytics: Removed; always fresh
- **allocatedGB** hardcoded 10: Removed or derived from plan
- **ApiRequestLog fallback** (totalReports × 5): Removed; return 0 or fail
- **systemStatus** fake uptime: Replaced with health checks or `unavailable`
