import mongoose, { Document, Schema } from 'mongoose';

export interface ITeamMember {
  userId: mongoose.Types.ObjectId;
  addedAt: Date;
  addedBy: mongoose.Types.ObjectId;
}

export interface ITeam extends Document {
  companyId: mongoose.Types.ObjectId;
  name: string;
  projectId?: mongoose.Types.ObjectId;
  managerId: mongoose.Types.ObjectId;
  members: ITeamMember[];
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: Date;
  updatedAt: Date;
}

const teamMemberSchema = new Schema<ITeamMember>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
    addedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { _id: false }
);

const teamSchema = new Schema<ITeam>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    members: {
      type: [teamMemberSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
teamSchema.index({ companyId: 1, name: 1 }, { unique: true });
teamSchema.index({ managerId: 1 });
teamSchema.index({ projectId: 1 });
teamSchema.index({ 'members.userId': 1 });

export const Team = mongoose.model<ITeam>('Team', teamSchema);

