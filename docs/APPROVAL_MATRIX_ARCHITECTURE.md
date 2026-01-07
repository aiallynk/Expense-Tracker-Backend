# Approval Matrix System Architecture

## 1. Database Schema (Mongoose)

### 1.1 Role Schema
Stores company-defined roles (e.g., "Finance Manager", "CTO").
```typescript
// models/Role.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IRole extends Document {
  companyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: Date;
}

const RoleSchema = new Schema<IRole>({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

RoleSchema.index({ companyId: 1, name: 1 }, { unique: true }); // Prevent duplicate role names per company
export const Role = mongoose.model<IRole>('Role', RoleSchema);
```

### 1.2 User-Role Mapping
Updated `User` schema to reference dynamic roles.
```typescript
// Update to User model
roles: [{ type: Schema.Types.ObjectId, ref: 'Role' }]
```

### 1.3 Approval Matrix Schema
Master configuration for an approval flow.
```typescript
// models/ApprovalMatrix.ts
import mongoose, { Schema, Document } from 'mongoose';

export enum ApprovalType {
  SEQUENTIAL = 'SEQUENTIAL',
  PARALLEL = 'PARALLEL'
}

export enum ParallelRule {
  ALL = 'ALL',
  ANY = 'ANY'
}

export enum ConditionType {
  AMOUNT = 'AMOUNT',
  BUDGET = 'BUDGET',
  POLICY = 'POLICY'
}

export enum ConditionOperator {
  GT = '>',
  LT = '<',
  GTE = '>=',
  LTE = '<=',
  EQ = '=='
}

export enum ActionType {
  ACTIVATE = 'ACTIVATE',
  SKIP = 'SKIP'
}

interface IApprovalCondition {
  type: ConditionType;
  operator: ConditionOperator;
  value: number | string;
  action: ActionType;
}

interface IApprovalLevel {
  levelNumber: number;
  enabled: boolean;
  approvalType: ApprovalType;
  parallelRule?: ParallelRule; // Required if PARALLEL
  approverRoleIds: mongoose.Types.ObjectId[];
  conditions: IApprovalCondition[];
}

export interface IApprovalMatrix extends Document {
  companyId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  levels: IApprovalLevel[];
}

const ApprovalMatrixSchema = new Schema<IApprovalMatrix>({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  levels: [{
    levelNumber: { type: Number, required: true },
    enabled: { type: Boolean, default: true },
    approvalType: { type: String, enum: Object.values(ApprovalType), required: true },
    parallelRule: { type: String, enum: Object.values(ParallelRule) },
    approverRoleIds: [{ type: Schema.Types.ObjectId, ref: 'Role' }],
    conditions: [{
      type: { type: String, enum: Object.values(ConditionType) },
      operator: { type: String, enum: Object.values(ConditionOperator) },
      value: { type: Schema.Types.Mixed },
      action: { type: String, enum: Object.values(ActionType) }
    }]
  }]
}, { timestamps: true });

export const ApprovalMatrix = mongoose.model<IApprovalMatrix>('ApprovalMatrix', ApprovalMatrixSchema);
```

### 1.4 Approval Instance Schema
Tracks the runtime execution of an approval process for a specific request.
```typescript
// models/ApprovalInstance.ts
export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SKIPPED = 'SKIPPED'
}

export interface IApprovalInstance extends Document {
  companyId: mongoose.Types.ObjectId;
  matrixId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // Reference to Expense/Trip request
  currentLevel: number;
  status: ApprovalStatus;
  history: Array<{
    levelNumber: number;
    status: ApprovalStatus;
    approverId?: mongoose.Types.ObjectId; // Who acted
    roleId?: mongoose.Types.ObjectId; // In what capacity
    timestamp: Date;
    comments?: string;
  }>
}

const ApprovalInstanceSchema = new Schema<IApprovalInstance>({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  matrixId: { type: Schema.Types.ObjectId, ref: 'ApprovalMatrix', required: true },
  requestId: { type: Schema.Types.ObjectId, required: true, index: true },
  currentLevel: { type: Number, default: 1 },
  status: { type: String, enum: Object.values(ApprovalStatus), default: ApprovalStatus.PENDING },
  history: [{
    levelNumber: Number,
    status: { type: String, enum: Object.values(ApprovalStatus) },
    approverId: { type: Schema.Types.ObjectId, ref: 'User' },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role' },
    timestamp: { type: Date, default: Date.now },
    comments: String
  }]
}, { timestamps: true });

export const ApprovalInstance = mongoose.model<IApprovalInstance>('ApprovalInstance', ApprovalInstanceSchema);
```

---

## 2. API Contracts

### 2.1 Role Management
- `POST /api/v1/roles`: Create a new role.
- `GET /api/v1/roles`: List all active roles for the company.
- `PATCH /api/v1/roles/:id`: Update role details.
- `DELETE /api/v1/roles/:id`: Soft delete role (check usage first).

### 2.2 User-Role Assignment
- `POST /api/v1/users/:userId/roles`: Assign roles to a user.
- `DELETE /api/v1/users/:userId/roles/:roleId`: Remove role.

### 2.3 Matrix Configuration
- `POST /api/v1/approval-matrices`: Create a new matrix.
- `GET /api/v1/approval-matrices`: List matrices.
- `PUT /api/v1/approval-matrices/:id`: Update matrix (versioning recommended).

### 2.4 Approval Execution
- `POST /api/v1/approvals/:instanceId/action`: Approve/Reject.
  - Body: `{ action: 'APPROVE' | 'REJECT', comments: string }`

---

## 3. Backend Logic & Services

### `ApprovalService`
- **initiateApproval(requestId, context)**:
  1. Fetch active matrix for company.
  2. Create `ApprovalInstance`.
  3. Evaluate Level 1 conditions.
  4. If skipped, move to Level 2.
  5. If active, determine required approvers (User IDs based on Roles).
  6. Send notifications.

- **processAction(instanceId, userId, action)**:
  1. Validate if `userId` has the required role for `currentLevel`.
  2. Update `history`.
  3. Check Level Completion Rule:
     - If `REJECT` -> Instance Status = REJECTED. Stop.
     - If `APPROVE`:
       - **SEQUENTIAL**: Move to next role in level (if intra-level logic exists) or next level.
       - **PARALLEL (ALL)**: Check if all required roles approved.
       - **PARALLEL (ANY)**: Mark level complete immediately.
  4. If Level Complete -> Increment `currentLevel`.
  5. Evaluate Next Level Conditions.
  6. If no more levels -> Instance Status = APPROVED.

---

## 4. Frontend Component Structure

```
src/
  features/
    approval-matrix/
      components/
        RoleManager/
          RoleList.tsx
          RoleForm.tsx
        MatrixBuilder/
          MatrixEditor.tsx
          LevelNode.tsx
          ConditionBuilder.tsx
          RoleSelector.tsx
        ApprovalInbox/
          PendingRequests.tsx
          ActionModal.tsx
```

---

## 5. Validation Rules
1. **At least one active role** in the system before creating a matrix.
2. **Approval Level** must have >= 1 role.
3. If `approvalType` is `PARALLEL`, `parallelRule` is mandatory.
4. **Circular Dependency Check**: Ensure levels usually flow 1 -> N.
5. **Orphan Role Check**: Warn if adding a role that has 0 assigned users.

---

## 6. Sample Approval Flow (JSON)
```json
{
  "name": "Travel Request Approval",
  "levels": [
    {
      "levelNumber": 1,
      "approvalType": "SEQUENTIAL",
      "approverRoleIds": ["role_manager__id"],
      "conditions": [] 
    },
    {
      "levelNumber": 2,
      "approvalType": "PARALLEL",
      "parallelRule": "ANY",
      "approverRoleIds": ["role_finance_id", "role_cfo_id"],
      "conditions": [
        { "type": "AMOUNT", "operator": ">", "value": 1000, "action": "ACTIVATE" }
      ]
    }
  ]
}
```
