require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

/**
 * Simple connection test script
 * Use this to verify PostgreSQL connection before running migrations
 */
async function testConnection() {
  console.log('Testing PostgreSQL Connection...\n');
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'Not Set');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is not set');
    process.exit(1);
  }
  
  // Mask password in URL for display
  const maskedUrl = process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@');
  console.log('Connection String:', maskedUrl);
  console.log('');
  
  const prisma = new PrismaClient();
  
  try {
    console.log('Attempting to connect...');
    await prisma.$connect();
    console.log('✅ Successfully connected to PostgreSQL!');
    
    // Test a simple query
    const result = await prisma.$queryRaw`SELECT version() as version`;
    console.log('✅ Database version:', result[0].version);
    
    // Test table access
    const tables = await prisma.$queryRaw`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `;
    console.log('✅ Tables found:', parseInt(tables[0].count));
    
    console.log('\n✅ Connection test passed! Ready for migration.');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Connection failed:', error.message);
    console.error('\nTroubleshooting:');
    console.error('  1. Verify RDS instance is running in AWS Console');
    console.error('  2. Check security group allows inbound on port 5432');
    console.error('  3. Verify DATABASE_URL format is correct');
    console.error('  4. Test connection with: psql "postgresql://..."');
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();
