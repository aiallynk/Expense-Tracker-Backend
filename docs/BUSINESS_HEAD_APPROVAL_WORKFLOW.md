# Business Head Approval Workflow Documentation

## Overview

This document provides comprehensive documentation for the Business Head (Level 2) approval workflow in the expense management system. The Business Head approval is a mandatory step in the expense report approval process, and the system automatically assigns the Business Head based on department ownership.

## Key Principles

1. **Business Head is ALWAYS determined by department ownership**
2. **After Manager (L1) approval, system automatically assigns the Business Head**
3. **Manager does not choose the BH manually**
4. **Selection is centralized and follows a clear priority order**

---

## Section 1: Business Head Selection Rules

### Selection Priority Order

The system selects a Business Head using the following priority order (highest to lowest):

#### Priority 1: Custom Approver Mapping (L2 if defined)

If a custom approver mapping exists for the employee with a Level 2 approver defined, that approver is used.

**Example:**
- Employee X has a custom mapping configured
- Mapping specifies: `level2ApproverId = Business Head Y`
- Result: Business Head Y is assigned

**Implementation:**
- Checks `ApproverMapping` collection for active mapping
- Validates that the mapped approver is active
- If inactive, falls to next priority

#### Priority 2: Active BUSINESS_HEAD in Same Department as Employee

The system searches for an active Business Head in the same department as the employee.

**Example:**
- Employee X is in Sales Department
- Business Head Y is in Sales Department with role `BUSINESS_HEAD`
- Result: Business Head Y is assigned

**Implementation:**
```typescript
User.findOne({
  departmentId: employee.departmentId,
  companyId: employee.companyId,
  role: UserRole.BUSINESS_HEAD,
  status: UserStatus.ACTIVE
})
```

**Edge Case - Multiple BHs in Department:**
- If multiple Business Heads exist in the same department, the first active one found is assigned
- Future enhancement: Add priority field for explicit ordering

#### Priority 3: Manager's Manager (if role = BUSINESS_HEAD)

If the employee's manager has a manager, and that manager's manager has the role `BUSINESS_HEAD`, they are assigned.

**Example:**
- Employee X reports to Manager A
- Manager A reports to Business Head B
- Result: Business Head B is assigned

**Implementation:**
```typescript
const manager = await User.findById(employee.managerId);
if (manager?.managerId) {
  const managersManager = await User.findById(manager.managerId);
  if (managersManager?.role === UserRole.BUSINESS_HEAD && managersManager.status === UserStatus.ACTIVE) {
    return managersManager;
  }
}
```

#### Priority 4: Fallback to Any Active BUSINESS_HEAD or ADMIN in Company

As a last resort, the system searches for any active Business Head or Admin in the company.

**Priority within fallback:**
1. First: Any active `BUSINESS_HEAD` in company
2. Second: Any active `ADMIN` in company
3. Third: Any active `COMPANY_ADMIN` in company

**Example:**
- No department-specific BH found
- Company has Business Head Z (company-wide)
- Result: Business Head Z is assigned

---

## Section 2: Business Head Visibility Rules

A Business Head should see a report **ONLY IF** all of the following conditions are met:

### Rule 1: Report Status
- Report status must be `PENDING_APPROVAL_L2` OR `MANAGER_APPROVED` (legacy)

### Rule 2: BH is Assigned as Level 2 Approver
- Business Head must be assigned as Level 2 approver in the `report.approvers` array
- The approver entry must not have `decidedAt` set (not yet decided)

### Rule 3: Employee Belongs to BH's Department
- Employee's `departmentId` must match Business Head's `departmentId`
- **Exception:** If Business Head has no department (company-wide BH), they can see all reports
- **Exception:** If employee has no department, BH can still see if assigned

### Rule 4: All Level 1 Approvals are Completed
- All Level 1 (Manager) approvers must have `decidedAt` set
- All Level 1 approvers must have `action = 'approve'`

### Implementation

```typescript
static async shouldBusinessHeadSeeReport(
  report: IExpenseReport,
  businessHeadId: string
): Promise<boolean> {
  // Check all 4 rules
  // Returns true only if all conditions are met
}
```

---

## Section 3: Business Head Action Behaviors

### A. Approve

**Behavior:**
- Moves report to `APPROVED` (if last approver) or `PENDING_APPROVAL_L3` (if higher levels enabled)
- Records audit log entry
- Sends notification to employee
- Updates `approvers` array with decision

**Status Transitions:**
- `PENDING_APPROVAL_L2` → `APPROVED` (if no higher levels)
- `PENDING_APPROVAL_L2` → `PENDING_APPROVAL_L3` (if L3 enabled)
- `MANAGER_APPROVED` → `APPROVED` or `PENDING_APPROVAL_L3` (legacy status)

**Implementation:**
```typescript
await ReportsService.handleReportAction(reportId, businessHeadId, 'approve', comment);
```

### B. Reject

**Behavior:**
- **Final action** - cannot be undone
- Report status becomes `REJECTED`
- Sets `rejectedAt` timestamp
- Records audit log
- Sends notification to employee
- Employee must create a new report (cannot resubmit rejected report)

**Status Transition:**
- `PENDING_APPROVAL_L2` → `REJECTED`
- `MANAGER_APPROVED` → `REJECTED`

**Implementation:**
```typescript
await ReportsService.handleReportAction(reportId, businessHeadId, 'reject', comment);
```

### C. Request Changes

**Behavior:**
- **Comment is mandatory** - system enforces this requirement
- Report status moves to `CHANGES_REQUESTED` (not `DRAFT`)
- **Approval chain resets** - `report.approvers` array is cleared
- Records audit log explaining approval chain reset
- Sends notification to employee
- Employee edits and resubmits
- On resubmission, approval chain is recomputed:
  - Manager → Business Head → higher levels
  - New approvers assigned based on current employee structure

**Status Transition:**
- `PENDING_APPROVAL_L2` → `CHANGES_REQUESTED`
- `MANAGER_APPROVED` → `CHANGES_REQUESTED`

**Implementation:**
```typescript
// In handleReportAction:
if (action === 'request_changes') {
  if (!comment || !comment.trim()) {
    throw new Error('Comment is required when requesting changes');
  }
  
  // Reset approval chain
  report.approvers = [];
  report.status = ExpenseReportStatus.CHANGES_REQUESTED;
}
```

**Why Reset Approval Chain?**
- Employee structure may have changed (new manager, department change)
- Ensures approvers are current and valid
- Prevents approval chain inconsistencies

---

## Section 4: Edge Cases and Handling

### Edge Case 1: Multiple Business Heads in Same Department

**Scenario:** Department has 2+ active Business Heads

**Handling:**
- First active Business Head found is assigned
- Selection is deterministic (based on database query order)
- **Future Enhancement:** Add `priority` field to User model for explicit ordering

**Code:**
```typescript
const businessHead = await User.findOne({
  departmentId: departmentId,
  role: UserRole.BUSINESS_HEAD,
  status: UserStatus.ACTIVE
}).exec(); // Returns first match
```

### Edge Case 2: No Business Head in Department

**Scenario:** Employee's department has no Business Head

**Handling:**
- System falls back to Priority 3 (Manager's Manager)
- If that fails, falls to Priority 4 (Company-wide BH or Admin)
- Logs warning if no BH found at any level

**Code:**
```typescript
// Priority 2 fails → try Priority 3
// Priority 3 fails → try Priority 4
const fallbackBH = await findCompanyFallbackBusinessHead(companyId);
```

### Edge Case 3: No Business Head in Company

**Scenario:** Company has no Business Heads at all

**Handling:**
- System logs warning
- Assigns to `ADMIN` or `COMPANY_ADMIN` as last resort
- Report can still proceed through approval

**Code:**
```typescript
// Try ADMIN
const admin = await User.findOne({
  companyId: companyId,
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE
});

// If no ADMIN, try COMPANY_ADMIN
if (!admin) {
  const companyAdmin = await User.findOne({
    companyId: companyId,
    role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE
  });
}
```

### Edge Case 4: Inactive Business Head

**Scenario:** Business Head exists but status is `INACTIVE`

**Handling:**
- Inactive Business Heads are skipped
- System moves to next priority level
- Only `ACTIVE` users are considered

**Code:**
```typescript
if (businessHead && businessHead.status === UserStatus.ACTIVE) {
  return businessHead;
}
// Otherwise, continue to next priority
```

### Edge Case 5: Employee Has No Department

**Scenario:** Employee's `departmentId` is null/undefined

**Handling:**
- Priority 2 (Department BH) is skipped
- System tries Priority 3 (Manager's Manager)
- Falls to Priority 4 (Company-wide) if needed

**Code:**
```typescript
if (employee.departmentId) {
  // Try department-based selection
} else {
  // Skip to next priority
}
```

### Edge Case 6: Custom Mapping with Inactive Approver

**Scenario:** Custom mapping exists but mapped approver is inactive

**Handling:**
- Inactive approver is skipped
- System moves to Priority 2 (Department-based selection)
- Custom mapping is not used if approver is inactive

**Code:**
```typescript
const customBH = await User.findById(mapping.level2ApproverId);
if (customBH && customBH.status === UserStatus.ACTIVE) {
  return customBH;
}
// Falls to next priority
```

### Edge Case 7: Manager Has No Manager

**Scenario:** Employee's manager has no `managerId`

**Handling:**
- Priority 3 (Manager's Manager) is skipped
- System moves to Priority 4 (Company fallback)

---

## Section 5: API Contracts

### Get Pending Reports

**Endpoint:** `GET /api/v1/business-head/reports/pending`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "report_id",
      "reportName": "Q1 Travel Expenses",
      "employeeName": "John Doe",
      "department": "Sales",
      "totalAmount": 5000,
      "status": "pending"
    }
  ]
}
```

**Filters Applied:**
- Only reports with status `PENDING_APPROVAL_L2` or `MANAGER_APPROVED`
- Only reports where BH is assigned as Level 2 approver
- Only reports from employees in BH's department (or company-wide BH)
- Only reports where all L1 approvals are complete

### Approve Report

**Endpoint:** `POST /api/v1/business-head/reports/:id/approve`

**Request Body:**
```json
{
  "comment": "Approved - within budget"
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated report */ },
  "message": "Report approved successfully"
}
```

### Reject Report

**Endpoint:** `POST /api/v1/business-head/reports/:id/reject`

**Request Body:**
```json
{
  "comment": "Rejected - expenses not justified"
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated report */ },
  "message": "Report rejected successfully"
}
```

### Request Changes

**Endpoint:** `POST /api/v1/business-head/reports/:id/request-changes`

**Request Body:**
```json
{
  "comment": "Please provide receipts for expenses above ₹1000" // REQUIRED
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated report */ },
  "message": "Changes requested successfully. The approval chain will be reset when the employee resubmits."
}
```

**Validation:**
- `comment` field is required and cannot be empty
- Returns 400 error if comment is missing

---

## Section 6: Examples

### Example 1: Standard Department-Based Assignment

**Scenario:**
- Employee: John (Sales Department)
- Manager: Alice (Sales Department, Manager role)
- Business Head: Bob (Sales Department, BUSINESS_HEAD role)

**Flow:**
1. John submits report → Status: `PENDING_APPROVAL_L1`
2. Alice approves → Status: `PENDING_APPROVAL_L2`
3. System automatically assigns Bob (Priority 2: Department BH)
4. Bob sees report in pending list
5. Bob approves → Status: `APPROVED`

### Example 2: Custom Mapping Override

**Scenario:**
- Employee: John (Sales Department)
- Custom Mapping: `level2ApproverId = Business Head Charlie`
- Department BH: Bob (Sales Department)

**Flow:**
1. John submits report
2. Manager approves
3. System assigns Charlie (Priority 1: Custom Mapping) - **not Bob**
4. Charlie sees report

### Example 3: Manager's Manager as BH

**Scenario:**
- Employee: John (Sales Department)
- Manager: Alice (Sales Department)
- Alice's Manager: Bob (BUSINESS_HEAD role, no department)

**Flow:**
1. John submits report
2. Alice approves
3. System assigns Bob (Priority 3: Manager's Manager)
4. Bob sees report

### Example 4: Request Changes Flow

**Scenario:**
- Report is at `PENDING_APPROVAL_L2`
- Business Head: Bob

**Flow:**
1. Bob requests changes with comment: "Add receipts"
2. Report status → `CHANGES_REQUESTED`
3. Approval chain is reset (`approvers = []`)
4. John edits report and resubmits
5. System recomputes approval chain:
   - Manager → Business Head (based on current structure)
6. Report goes through approval again

---

## Section 7: Implementation Details

### Service: BusinessHeadSelectionService

**Location:** `BACKEND/src/services/businessHeadSelection.service.ts`

**Key Methods:**
- `selectBusinessHead(employeeId, companyId, customMapping?, managerId?)` - Main selection logic
- `findBusinessHeadByDepartment(departmentId, companyId)` - Department-based lookup
- `findCompanyFallbackBusinessHead(companyId)` - Company-wide fallback
- `validateBusinessHeadAssignment(bhId, employeeId)` - Validation helper
- `getSelectionExplanation(employeeId, companyId?)` - Admin UI explanation

### Service: BusinessHeadService

**Location:** `BACKEND/src/services/businessHead.service.ts`

**Key Methods:**
- `shouldBusinessHeadSeeReport(report, businessHeadId)` - Visibility validation
- `getPendingReports(businessHeadId)` - Get visible reports
- `approveReport(reportId, businessHeadId, comment?)` - Approve action
- `rejectReport(reportId, businessHeadId, comment?)` - Reject action
- `requestReportChanges(reportId, businessHeadId, comment)` - Request changes

### Controller: BusinessHeadController

**Location:** `BACKEND/src/controllers/businessHead.controller.ts`

**Endpoints:**
- `GET /api/v1/business-head/reports/pending` - Get pending reports
- `POST /api/v1/business-head/reports/:id/approve` - Approve report
- `POST /api/v1/business-head/reports/:id/reject` - Reject report
- `POST /api/v1/business-head/reports/:id/request-changes` - Request changes

---

## Section 8: Admin UI Documentation

### Approval Matrix Page

**Location:** `expense-tracker-web/src/pages/company-admin/ApprovalMatrix.jsx`

**Features:**
- Visual flow diagram showing Level 2 as "Business Head Approval"
- Business Head Selection Rules section with expandable details
- Tooltips explaining selection priority
- Examples showing department-based assignment

### BusinessHeadTooltip Component

**Location:** `expense-tracker-web/src/components/tooltips/BusinessHeadTooltip.jsx`

**Variants:**
- `tooltip` - Hover tooltip with quick info
- `expanded` - Expandable card with full details

**Content:**
- Selection rules with priority order
- Visibility rules
- Action behaviors
- Examples
- Edge case explanations

### Helper Functions

**Location:** `expense-tracker-web/src/utils/approvalHelpers.js`

**Functions:**
- `getBusinessHeadSelectionExplanation()` - Returns selection rules
- `formatApprovalFlowExample(...)` - Generates example text
- `getBusinessHeadVisibilityRules()` - Returns visibility rules
- `getBusinessHeadActionBehaviors()` - Returns action behaviors
- `getEdgeCaseExplanations()` - Returns edge case handling

---

## Section 9: Testing Scenarios

### Test Case 1: Custom Mapping Priority
- Create employee with custom mapping (L2 = BH A)
- Employee has department with BH B
- Submit report → Verify BH A is assigned (not BH B)

### Test Case 2: Department-Based Selection
- Create employee in Sales Department
- Create BH in Sales Department
- Submit report → Verify Sales BH is assigned

### Test Case 3: Manager's Manager
- Create employee → Manager → Manager's Manager (BH role)
- Submit report → Verify Manager's Manager is assigned

### Test Case 4: Company Fallback
- Create employee with no department BH
- Create company-wide BH
- Submit report → Verify company-wide BH is assigned

### Test Case 5: Request Changes Reset
- Submit report and get to L2
- BH requests changes
- Verify `approvers` array is cleared
- Verify status is `CHANGES_REQUESTED`
- Resubmit → Verify new approvers assigned

### Test Case 6: Visibility Rules
- Create report assigned to BH A
- Try to view as BH B → Should not see
- Verify as BH A → Should see

### Test Case 7: Multiple BHs in Department
- Create 2 BHs in same department
- Submit report → Verify first BH found is assigned

### Test Case 8: Inactive BH Skip
- Create inactive BH in department
- Submit report → Verify system skips inactive BH and uses fallback

---

## Section 10: Troubleshooting

### Issue: BH Not Seeing Reports

**Check:**
1. Is report status `PENDING_APPROVAL_L2` or `MANAGER_APPROVED`?
2. Is BH assigned as Level 2 approver in `report.approvers`?
3. Does employee belong to BH's department?
4. Are all L1 approvals complete?

### Issue: Wrong BH Assigned

**Check:**
1. Is there a custom mapping overriding department selection?
2. Is the department correct for the employee?
3. Are there multiple BHs in the department? (First found is used)

### Issue: Request Changes Not Resetting Chain

**Check:**
1. Is status set to `CHANGES_REQUESTED` (not `DRAFT`)?
2. Is `report.approvers` array cleared?
3. Is approval chain recomputed on resubmission?

---

## Conclusion

The Business Head approval workflow is designed to be:
- **Explicit:** Clear priority order and rules
- **Predictable:** Consistent behavior across all scenarios
- **Easy to Understand:** Comprehensive documentation and UI explanations
- **Robust:** Handles edge cases gracefully

For questions or issues, refer to this documentation or contact the development team.

