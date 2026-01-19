# Advance Cash Enhancement - Report-Level Deduction & Company Policy

## Overview
Enhance advance cash functionality with:
1. Company admin flag to control advance cash creation (self vs others)
2. Change deduction from expense-level to report-level (industry best practice)
3. Update both web and mobile applications

## Current State
- **Deduction**: Expense-level (each expense has `advanceAppliedAmount`)
- **Creation Policy**: Hardcoded - employees for self, admins for others
- **Storage**: `AdvanceCashTransaction` links to expenses via `expenseId`

## Industry Best Practices
- Report-level deduction is preferred (SAP Concur, Oracle PeopleSoft)
- Simpler user experience
- Easier reconciliation
- Better audit trail

## Implementation Plan

### Phase 1: Backend Schema Updates
1. Add `advanceCash` settings to CompanySettings
2. Add advance fields to ExpenseReport model
3. Update AdvanceCashTransaction for report-level

### Phase 2: Backend Service Updates
1. Update `applyAdvanceForReport()` for report-level deduction
2. Add policy enforcement in `createAdvance()`
3. Update ReportsService for advance handling

### Phase 3: Frontend Updates
1. Web: Update report forms, advance UI, company settings
2. Mobile: Update report screens, advance screen, remove from expenses

## Files to Modify
- Backend: Models, Services, Controllers
- Web: Report forms, Advance UI, Settings
- Mobile: Report screens, Advance screen
