import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { ProjectsService } from '../services/projects.service';
import { CostCentre } from '../models/CostCentre';

let mongo: MongoMemoryServer;

describe('ProjectsService (cost centre requirement)', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'test' });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  it('rejects new project creation without costCentreId', async () => {
    const companyId = new mongoose.Types.ObjectId().toString();
    await expect(
      ProjectsService.createProject({
        name: 'P1',
        companyId,
        costCentreId: '', // Empty string should be rejected
      })
    ).rejects.toThrow(/Cost centre is required/i);
  });

  it('accepts new project creation with valid costCentreId', async () => {
    const companyId = new mongoose.Types.ObjectId().toString();
    const costCentreId = new mongoose.Types.ObjectId().toString();

    const project = await ProjectsService.createProject({
      name: 'P1',
      companyId,
      costCentreId,
    });

    expect(project.name).toBe('P1');
    expect(project.costCentreId.toString()).toBe(costCentreId);
  });
});


