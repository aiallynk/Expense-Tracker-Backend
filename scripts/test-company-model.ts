import mongoose from 'mongoose';
import { config } from '../src/config/index';
import { Company } from '../src/models/Company';

const testCompanyModel = async () => {
  try {
    const uri = config.mongodb.uri.endsWith('/')
      ? `${config.mongodb.uri}${config.mongodb.dbName}`
      : `${config.mongodb.uri}/${config.mongodb.dbName}`;

    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');

    // Test creating a company
    const testCompany = new Company({
      name: 'Test Company ' + Date.now(),
      location: 'Test Location',
      type: 'IT',
      status: 'active',
      plan: 'basic',
    });

    const saved = await testCompany.save();
    console.log('✅ Company saved successfully!');
    console.log('   Collection name: companies');
    console.log('   Company ID:', saved._id);
    console.log('   Company name:', saved.name);

    // Check if it exists in the database
    const found = await Company.findById(saved._id);
    if (found) {
      console.log('✅ Company found in database!');
      console.log('   Full document:', JSON.stringify(found.toObject(), null, 2));
    } else {
      console.error('❌ Company not found in database!');
    }

    // Clean up test data
    await Company.deleteOne({ _id: saved._id });
    console.log('✅ Test company deleted');

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

testCompanyModel();

