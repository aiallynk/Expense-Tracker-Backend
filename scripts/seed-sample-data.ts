import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { connectDB } from '../src/config/db';
import { User } from '../src/models/User';
import { Category } from '../src/models/Category';
import { Project } from '../src/models/Project';
import { ExpenseReport } from '../src/models/ExpenseReport';
import { Expense } from '../src/models/Expense';
import { Receipt } from '../src/models/Receipt';
import { OcrJob } from '../src/models/OcrJob';
import { UserRole, UserStatus, ExpenseReportStatus, ExpenseStatus, ExpenseSource, OcrJobStatus } from '../src/utils/enums';
import { logger } from '../src/utils/logger';

dotenv.config();

async function seedSampleData() {
  try {
    console.log('Connecting to MongoDB...');
    await connectDB();
    console.log('Connected to MongoDB');

    // Clear existing data (optional - comment out if you want to keep existing data)
    // await User.deleteMany({});
    // await Category.deleteMany({});
    // await Project.deleteMany({});
    // await ExpenseReport.deleteMany({});
    // await Expense.deleteMany({});
    // await Receipt.deleteMany({});
    // await OcrJob.deleteMany({});

    const defaultPassword = 'password123';
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    // Create Users
    console.log('\n=== Creating Users ===');
    const employee = await User.findOneAndUpdate(
      { email: 'employee@example.com' },
      {
        email: 'employee@example.com',
        passwordHash,
        name: 'John Employee',
        role: UserRole.EMPLOYEE,
        status: UserStatus.ACTIVE,
        roles: [],
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Created/Updated employee: ${employee.email}`);

    const manager = await User.findOneAndUpdate(
      { email: 'manager@example.com' },
      {
        email: 'manager@example.com',
        passwordHash,
        name: 'Jane Manager',
        role: UserRole.MANAGER,
        status: UserStatus.ACTIVE,
        roles: [],
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Created/Updated manager: ${manager.email}`);

    const businessHead = await User.findOneAndUpdate(
      { email: 'bh@example.com' },
      {
        email: 'bh@example.com',
        passwordHash,
        name: 'Bob Business Head',
        role: UserRole.BUSINESS_HEAD,
        status: UserStatus.ACTIVE,
        roles: [],
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Created/Updated business head: ${businessHead.email}`);

    // Set manager relationships
    employee.managerId = manager._id as mongoose.Types.ObjectId;
    await employee.save();
    manager.managerId = businessHead._id as mongoose.Types.ObjectId;
    await manager.save();

    // Create Categories
    console.log('\n=== Creating Categories ===');
    const categories = [
      { name: 'Travel', code: 'TRAVEL' },
      { name: 'Food', code: 'FOOD' },
      { name: 'Office Supplies', code: 'OFFICE' },
      { name: 'Others', code: 'OTHERS' },
    ];

    const createdCategories = [];
    for (const catData of categories) {
      const category = await Category.findOneAndUpdate(
        { name: catData.name },
        catData,
        { upsert: true, new: true }
      );
      createdCategories.push(category);
      console.log(`✓ Created/Updated category: ${category.name}`);
    }

    // Create Projects
    console.log('\n=== Creating Projects ===');
    const projects = [
      { name: 'Project Alpha', code: 'ALPHA' },
      { name: 'Project Beta', code: 'BETA' },
    ];

    const createdProjects = [];
    for (const projData of projects) {
      const project = await Project.findOneAndUpdate(
        { name: projData.name },
        projData,
        { upsert: true, new: true }
      );
      createdProjects.push(project);
      console.log(`✓ Created/Updated project: ${project.name}`);
    }

    // Create Expense Reports
    console.log('\n=== Creating Expense Reports ===');
    const report1 = await ExpenseReport.findOneAndUpdate(
      { name: 'Q1 2024 Expenses' },
      {
        userId: employee._id,
        projectId: createdProjects[0]._id,
        name: 'Q1 2024 Expenses',
        notes: 'Quarterly expense report',
        fromDate: new Date('2024-01-01'),
        toDate: new Date('2024-03-31'),
        status: ExpenseReportStatus.DRAFT,
        totalAmount: 0,
        currency: 'INR',
        approvers: [],
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Created/Updated report: ${report1.name}`);

    const report2 = await ExpenseReport.findOneAndUpdate(
      { name: 'April 2024 Expenses' },
      {
        userId: employee._id,
        projectId: createdProjects[1]._id,
        name: 'April 2024 Expenses',
        notes: 'Monthly expense report',
        fromDate: new Date('2024-04-01'),
        toDate: new Date('2024-04-30'),
        status: ExpenseReportStatus.SUBMITTED,
        totalAmount: 0,
        currency: 'INR',
        approvers: [
          {
            level: 1,
            userId: manager._id as mongoose.Types.ObjectId,
            role: manager.role,
          },
        ],
        submittedAt: new Date(),
      },
      { upsert: true, new: true }
    );
    console.log(`✓ Created/Updated report: ${report2.name}`);

    // Create Expenses
    console.log('\n=== Creating Expenses ===');
    const expenses = [
      {
        reportId: report1._id,
        userId: employee._id,
        vendor: 'Uber',
        categoryId: createdCategories[0]._id,
        projectId: createdProjects[0]._id,
        amount: 500,
        currency: 'INR',
        expenseDate: new Date('2024-01-15'),
        status: ExpenseStatus.DRAFT,
        source: ExpenseSource.MANUAL,
        notes: 'Taxi to client meeting',
        receiptIds: [],
      },
      {
        reportId: report1._id,
        userId: employee._id,
        vendor: 'Restaurant ABC',
        categoryId: createdCategories[1]._id,
        projectId: createdProjects[0]._id,
        amount: 1200,
        currency: 'INR',
        expenseDate: new Date('2024-01-20'),
        status: ExpenseStatus.DRAFT,
        source: ExpenseSource.MANUAL,
        notes: 'Team lunch',
        receiptIds: [],
      },
      {
        reportId: report2._id,
        userId: employee._id,
        vendor: 'Office Depot',
        categoryId: createdCategories[2]._id,
        projectId: createdProjects[1]._id,
        amount: 2500,
        currency: 'INR',
        expenseDate: new Date('2024-04-10'),
        status: ExpenseStatus.PENDING,
        source: ExpenseSource.SCANNED,
        notes: 'Office supplies',
        receiptIds: [],
      },
    ];

    const createdExpenses = [];
    for (const expData of expenses) {
      const expense = await Expense.findOneAndUpdate(
        { reportId: expData.reportId, vendor: expData.vendor, expenseDate: expData.expenseDate },
        expData,
        { upsert: true, new: true }
      );
      createdExpenses.push(expense);
      console.log(`✓ Created/Updated expense: ${expense.vendor} - ₹${expense.amount}`);

      // Update report total
      const report = await ExpenseReport.findById(expense.reportId);
      if (report) {
        const reportExpenses = await Expense.find({ reportId: report._id });
        report.totalAmount = reportExpenses.reduce((sum, e) => sum + e.amount, 0);
        await report.save();
      }
    }

    // Create Receipts (with example S3 keys)
    console.log('\n=== Creating Receipts ===');
    const receipts = [
      {
        expenseId: createdExpenses[2]._id,
        storageKey: `receipts/${createdExpenses[2]._id}/sample-receipt-1.jpg`,
        storageUrl: `https://s3.amazonaws.com/expense-tracker-bucket/receipts/${createdExpenses[2]._id}/sample-receipt-1.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 245678,
        uploadConfirmed: true,
        parsedData: {
          vendor: 'Office Depot',
          date: '2024-04-10',
          totalAmount: 2500,
          currency: 'INR',
          categorySuggestion: 'Office',
        },
      },
    ];

    const createdReceipts = [];
    for (const receiptData of receipts) {
      const receipt = await Receipt.findOneAndUpdate(
        { storageKey: receiptData.storageKey },
        receiptData,
        { upsert: true, new: true }
      );
      createdReceipts.push(receipt);
      console.log(`✓ Created/Updated receipt: ${receipt.storageKey}`);

      // Link receipt to expense
      const expense = await Expense.findById(receipt.expenseId);
      if (expense) {
        if (!expense.receiptIds) {
          expense.receiptIds = [];
        }
        expense.receiptIds.push(receipt._id as mongoose.Types.ObjectId);
        if (!expense.receiptPrimaryId) {
          expense.receiptPrimaryId = receipt._id as mongoose.Types.ObjectId;
        }
        await expense.save();
      }
    }

    // Create OCR Jobs
    console.log('\n=== Creating OCR Jobs ===');
    if (createdReceipts.length > 0) {
      const ocrJob = await OcrJob.findOneAndUpdate(
        { receiptId: createdReceipts[0]._id },
        {
          receiptId: createdReceipts[0]._id,
          status: OcrJobStatus.COMPLETED,
          result: createdReceipts[0].parsedData,
          attempts: 1,
          completedAt: new Date(),
        },
        { upsert: true, new: true }
      );
      console.log(`✓ Created/Updated OCR job: ${ocrJob._id}`);

      // Link OCR job to receipt
      createdReceipts[0].ocrJobId = ocrJob._id as mongoose.Types.ObjectId;
      await createdReceipts[0].save();
    }

    console.log('\n=== Seed Summary ===');
    console.log(`✓ Users: ${await User.countDocuments()}`);
    console.log(`✓ Categories: ${await Category.countDocuments()}`);
    console.log(`✓ Projects: ${await Project.countDocuments()}`);
    console.log(`✓ Reports: ${await ExpenseReport.countDocuments()}`);
    console.log(`✓ Expenses: ${await Expense.countDocuments()}`);
    console.log(`✓ Receipts: ${await Receipt.countDocuments()}`);
    console.log(`✓ OCR Jobs: ${await OcrJob.countDocuments()}`);

    console.log('\n✓ Sample data seeded successfully!');
    console.log('\nLogin credentials:');
    console.log('  Employee: employee@example.com / password123');
    console.log('  Manager: manager@example.com / password123');
    console.log('  Business Head: bh@example.com / password123');
  } catch (error: any) {
    console.error('Seed failed:', error);
    logger.error('Seed error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed');
    process.exit(0);
  }
}

// Run seed
seedSampleData();

