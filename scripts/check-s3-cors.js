require('dotenv').config();
const { S3Client, GetBucketCorsCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
});

const bucket = process.env.S3_BUCKET_NAME || 'expense-tracker-aially';

async function checkCurrentCORS() {
  console.log('========================================');
  console.log('  CHECKING CURRENT S3 CORS CONFIGURATION');
  console.log('========================================\n');
  console.log(`Bucket: ${bucket}`);
  console.log(`Region: ${process.env.AWS_REGION || 'ap-south-1'}\n`);

  try {
    const command = new GetBucketCorsCommand({ Bucket: bucket });
    const response = await s3Client.send(command);
    
    if (!response.CORSRules || response.CORSRules.length === 0) {
      console.log('❌ No CORS configuration found on bucket!\n');
      console.log('This is why uploads are failing.\n');
    } else {
      console.log('✅ Current CORS Configuration:\n');
      response.CORSRules.forEach((rule, index) => {
        console.log(`Rule ${index + 1}:`);
        console.log(`  Allowed Origins: ${rule.AllowedOrigins?.join(', ') || 'None'}`);
        console.log(`  Allowed Methods: ${rule.AllowedMethods?.join(', ') || 'None'}`);
        console.log(`  Allowed Headers: ${rule.AllowedHeaders?.join(', ') || 'None'}`);
        console.log(`  Expose Headers: ${rule.ExposeHeaders?.join(', ') || 'None'}`);
        console.log(`  Max Age: ${rule.MaxAgeSeconds || 'Not set'} seconds\n`);
      });
      
      // Check if production domain is included
      const hasProductionDomain = response.CORSRules.some(rule => 
        rule.AllowedOrigins?.includes('https://nexpense.aially.in')
      );
      
      if (!hasProductionDomain) {
        console.log('⚠️  WARNING: https://nexpense.aially.in is NOT in allowed origins!\n');
      } else {
        console.log('✅ https://nexpense.aially.in is in allowed origins\n');
      }
      
      // Check if OPTIONS method is included
      const hasOptions = response.CORSRules.some(rule => 
        rule.AllowedMethods?.includes('OPTIONS')
      );
      
      if (!hasOptions) {
        console.log('⚠️  WARNING: OPTIONS method is NOT in allowed methods!\n');
        console.log('   OPTIONS is required for CORS preflight requests.\n');
      } else {
        console.log('✅ OPTIONS method is in allowed methods\n');
      }
    }
    
    console.log('========================================\n');
    
  } catch (error) {
    if (error.name === 'NoSuchCORSConfiguration') {
      console.log('❌ No CORS configuration found on bucket!\n');
      console.log('This is why uploads are failing.\n');
    } else {
      console.error('❌ Error checking CORS:', error.message);
      console.error('\nFull error:', error);
    }
  }
}

checkCurrentCORS()
  .then(() => {
    console.log('\n📋 Next step: Update CORS configuration in AWS Console');
    console.log('   See: scripts/s3-cors-config.json for the correct configuration\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });
