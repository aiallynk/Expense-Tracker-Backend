require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

/**
 * Prisma PostgreSQL Connection Test
 * Tests connection to AWS RDS PostgreSQL database
 */

async function testPrismaConnection() {
  console.log('========================================');
  console.log('  PRISMA POSTGRESQL CONNECTION TEST');
  console.log('========================================\n');
  
  // Step 1: Check DATABASE_URL exists
  console.log('STEP 1: Checking environment variables...');
  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL environment variable is not set');
    console.error('   Please ensure .env file exists in project root');
    console.error('   Expected format: DATABASE_URL="postgresql://user:password@host:port/database?sslmode=require"');
    process.exit(1);
  }
  console.log('✅ DATABASE_URL is set');
  
  // Step 2: Validate DATABASE_URL format
  console.log('\nSTEP 2: Validating DATABASE_URL format...');
  const dbUrl = process.env.DATABASE_URL;
  const maskedUrl = dbUrl.replace(/:[^:@]+@/, ':****@');
  console.log('   Connection String:', maskedUrl);
  
  // Check for required components
  const urlPattern = /^postgresql:\/\//;
  if (!urlPattern.test(dbUrl)) {
    console.error('❌ ERROR: DATABASE_URL must start with "postgresql://"');
    process.exit(1);
  }
  console.log('✅ URL format is valid');
  
  // Check for database name
  const dbNameMatch = dbUrl.match(/\/([^?]+)/);
  const dbName = dbNameMatch ? dbNameMatch[1] : null;
  if (!dbName) {
    console.error('❌ ERROR: Database name not found in DATABASE_URL');
    process.exit(1);
  }
  console.log(`   Database name: ${dbName}`);
  
  // Check for sslmode
  const hasSslMode = dbUrl.includes('sslmode=');
  if (!hasSslMode) {
    console.warn('⚠️  WARNING: sslmode parameter not found in DATABASE_URL');
    console.warn('   AWS RDS typically requires SSL. Consider adding: ?sslmode=require');
  } else {
    console.log('✅ SSL mode parameter found');
  }
  
  // Step 3: Attempt Prisma connection
  console.log('\nSTEP 3: Attempting Prisma connection...');
  const prisma = new PrismaClient({
    log: ['error', 'warn'],
  });
  
  let connectionResult = {
    success: false,
    errorType: null,
    errorMessage: null,
    details: {},
  };
  
  try {
    console.log('   Connecting to PostgreSQL...');
    const startTime = Date.now();
    
    await prisma.$connect();
    
    const connectTime = Date.now() - startTime;
    console.log(`✅ Connection established in ${connectTime}ms`);
    connectionResult.success = true;
    
    // Step 4: Test database queries
    console.log('\nSTEP 4: Testing database queries...');
    
    // Test 1: Get PostgreSQL version
    try {
      const versionResult = await prisma.$queryRaw`SELECT version() as version`;
      const version = versionResult[0].version;
      console.log('✅ PostgreSQL version query successful');
      console.log(`   Version: ${version.split(',')[0]}`);
      connectionResult.details.version = version;
    } catch (error) {
      console.error('❌ Version query failed:', error.message);
      connectionResult.details.versionError = error.message;
    }
    
    // Test 2: Count tables
    try {
      const tablesResult = await prisma.$queryRaw`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      `;
      const tableCount = parseInt(tablesResult[0].count);
      console.log(`✅ Table count query successful`);
      console.log(`   Tables found: ${tableCount}`);
      connectionResult.details.tableCount = tableCount;
    } catch (error) {
      console.error('❌ Table count query failed:', error.message);
      connectionResult.details.tableCountError = error.message;
    }
    
    // Test 3: Test Prisma model access (if Company table exists)
    try {
      const companyCount = await prisma.company.count();
      console.log(`✅ Prisma model access successful`);
      console.log(`   Company records: ${companyCount}`);
      connectionResult.details.companyCount = companyCount;
    } catch (error) {
      if (error.message.includes('does not exist')) {
        console.log('ℹ️  Company table does not exist yet (expected before migration)');
      } else {
        console.error('❌ Prisma model access failed:', error.message);
        connectionResult.details.modelError = error.message;
      }
    }
    
    console.log('\n========================================');
    console.log('  ✅ CONNECTION TEST PASSED');
    console.log('========================================');
    console.log('\nSystem is ready for data migration!');
    console.log('Next step: Run migration script');
    console.log('   Command: node scripts/migrate/run_all_migrations.js\n');
    
    connectionResult.success = true;
    
  } catch (error) {
    console.error('\n========================================');
    console.error('  ❌ CONNECTION TEST FAILED');
    console.error('========================================\n');
    
    connectionResult.success = false;
    connectionResult.errorMessage = error.message;
    
    // Determine error type
    const errorMsg = error.message.toLowerCase();
    
    if (errorMsg.includes('timeout') || errorMsg.includes('timed out') || errorMsg.includes('etimedout')) {
      connectionResult.errorType = 'NETWORK_TIMEOUT';
      console.error('ERROR TYPE: Network Timeout');
      console.error('   The database server did not respond within the timeout period.');
      console.error('\nPOSSIBLE CAUSES:');
      console.error('   1. AWS RDS instance is stopped or not running');
      console.error('   2. Security group is blocking inbound connections on port 5432');
      console.error('   3. Network firewall blocking the connection');
      console.error('   4. RDS instance is in a private subnet without VPN/bastion access');
      console.error('\nFIX GUIDANCE:');
      console.error('   1. Check AWS RDS Console:');
      console.error('      - Go to AWS RDS Console → Databases');
      console.error('      - Find instance: nexpense-postgres-db');
      console.error('      - Verify Status is "Available"');
      console.error('   2. Check Security Group:');
      console.error('      - Go to RDS instance → Connectivity & security → Security groups');
      console.error('      - Click on the security group');
      console.error('      - Check Inbound rules → Add rule if needed:');
      console.error('        Type: PostgreSQL');
      console.error('        Port: 5432');
      console.error('        Source: Your IP address (or 0.0.0.0/0 for testing)');
      console.error('   3. Check Public Accessibility:');
      console.error('      - Go to RDS instance → Connectivity & security');
      console.error('      - Verify "Publicly accessible" is "Yes"');
      console.error('   4. Test from command line:');
      console.error(`      psql "${maskedUrl}"`);
      
    } else if (errorMsg.includes('authentication') || errorMsg.includes('password') || errorMsg.includes('password_required')) {
      connectionResult.errorType = 'AUTHENTICATION';
      console.error('ERROR TYPE: Authentication Failed');
      console.error('   Invalid username or password.');
      console.error('\nFIX GUIDANCE:');
      console.error('   1. Verify credentials in .env file:');
      console.error('      - Check username: postgres');
      console.error('      - Check password: aially-2026');
      console.error('   2. Test connection manually:');
      console.error(`      psql "${maskedUrl}"`);
      console.error('   3. If password is incorrect, update .env file:');
      console.error('      DATABASE_URL="postgresql://postgres:CORRECT_PASSWORD@..."');
      
    } else if (errorMsg.includes('does not exist') || errorMsg.includes('database') && errorMsg.includes('not found')) {
      connectionResult.errorType = 'DATABASE_NOT_FOUND';
      console.error('ERROR TYPE: Database Not Found');
      console.error(`   Database "${dbName}" does not exist on the server.`);
      console.error('\nFIX GUIDANCE:');
      console.error('   1. Verify database name in DATABASE_URL:');
      console.error(`      Current: ${dbName}`);
      console.error('   2. Check available databases on RDS instance');
      console.error('   3. Update .env file with correct database name if needed');
      
    } else if (errorMsg.includes('refused') || errorMsg.includes('econnrefused')) {
      connectionResult.errorType = 'CONNECTION_REFUSED';
      console.error('ERROR TYPE: Connection Refused');
      console.error('   The server actively refused the connection.');
      console.error('\nPOSSIBLE CAUSES:');
      console.error('   1. RDS instance is not running');
      console.error('   2. Wrong port number (should be 5432)');
      console.error('   3. Security group blocking connection');
      console.error('\nFIX GUIDANCE:');
      console.error('   1. Verify RDS instance status in AWS Console');
      console.error('   2. Check port 5432 is correct');
      console.error('   3. Verify security group allows inbound on port 5432');
      
    } else if (errorMsg.includes('ssl') || errorMsg.includes('tls')) {
      connectionResult.errorType = 'SSL_ERROR';
      console.error('ERROR TYPE: SSL/TLS Error');
      console.error('   SSL connection requirement not met.');
      console.error('\nFIX GUIDANCE:');
      console.error('   1. Add sslmode parameter to DATABASE_URL:');
      console.error('      DATABASE_URL="postgresql://...?sslmode=require"');
      console.error('   2. Or use: ?sslmode=no-verify (not recommended for production)');
      
    } else {
      connectionResult.errorType = 'UNKNOWN';
      console.error('ERROR TYPE: Unknown Error');
      console.error(`   Message: ${error.message}`);
      console.error('\nFULL ERROR DETAILS:');
      console.error(error);
    }
    
    console.error('\n========================================\n');
  } finally {
    try {
      await prisma.$disconnect();
      console.log('✅ Prisma client disconnected');
    } catch (disconnectError) {
      // Ignore disconnect errors
    }
  }
  
  // Return result for programmatic use
  return connectionResult;
}

// Run if called directly
if (require.main === module) {
  testPrismaConnection()
    .then((result) => {
      if (result.success) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error('Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = { testPrismaConnection };
