#!/usr/bin/env node

/**
 * Test script for signup and login endpoints
 * Usage: node test-auth.js [baseUrl]
 */

const http = require('http');

const baseUrl = process.argv[2] || 'http://localhost:4000';
const apiUrl = `${baseUrl}/api/v1`;

// Test user credentials
const testUser = {
  email: `test${Date.now()}@example.com`,
  password: 'test123456',
  name: 'Test Employee',
};

console.log('🧪 Testing Authentication Endpoints\n');
console.log(`Base URL: ${baseUrl}`);
console.log(`API URL: ${apiUrl}\n`);

// Helper function to make HTTP requests
function makeRequest(method, path, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}${path}`);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Test signup
async function testSignup() {
  console.log('📝 Testing SIGNUP endpoint...');
  console.log(`   Email: ${testUser.email}`);
  console.log(`   Name: ${testUser.name}`);
  console.log(`   Password: ${testUser.password}\n`);

  try {
    const response = await makeRequest('POST', '/auth/signup', {
      email: testUser.email,
      password: testUser.password,
      name: testUser.name,
    });

    if (response.status === 201 && response.data.success) {
      console.log('✅ SIGNUP SUCCESSFUL!');
      console.log(`   User ID: ${response.data.data.user.id}`);
      console.log(`   Email: ${response.data.data.user.email}`);
      console.log(`   Name: ${response.data.data.user.name}`);
      console.log(`   Role: ${response.data.data.user.role}`);
      console.log(`   Access Token: ${response.data.data.tokens.accessToken.substring(0, 20)}...`);
      console.log(`   Refresh Token: ${response.data.data.tokens.refreshToken.substring(0, 20)}...\n`);
      
      // Verify role is EMPLOYEE
      if (response.data.data.user.role === 'EMPLOYEE') {
        console.log('✅ Role is correctly set to EMPLOYEE\n');
      } else {
        console.log(`⚠️  Warning: Role is ${response.data.data.user.role}, expected EMPLOYEE\n`);
      }

      return response.data.data.tokens.accessToken;
    } else {
      console.log('❌ SIGNUP FAILED!');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));
      return null;
    }
  } catch (error) {
    console.log('❌ SIGNUP ERROR!');
    console.log(`   Error: ${error.message}`);
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n   💡 Make sure the server is running:');
      console.log('      cd BACKEND && npm run dev');
    }
    return null;
  }
}

// Test login
async function testLogin() {
  console.log('🔐 Testing LOGIN endpoint...');
  console.log(`   Email: ${testUser.email}`);
  console.log(`   Password: ${testUser.password}\n`);

  try {
    const response = await makeRequest('POST', '/auth/login', {
      email: testUser.email,
      password: testUser.password,
    });

    if (response.status === 200 && response.data.success) {
      console.log('✅ LOGIN SUCCESSFUL!');
      console.log(`   User ID: ${response.data.data.user.id}`);
      console.log(`   Email: ${response.data.data.user.email}`);
      console.log(`   Name: ${response.data.data.user.name}`);
      console.log(`   Role: ${response.data.data.user.role}`);
      console.log(`   Access Token: ${response.data.data.tokens.accessToken.substring(0, 20)}...`);
      console.log(`   Refresh Token: ${response.data.data.tokens.refreshToken.substring(0, 20)}...\n`);
      
      // Verify role is EMPLOYEE
      if (response.data.data.user.role === 'EMPLOYEE') {
        console.log('✅ Role is correctly set to EMPLOYEE\n');
      } else {
        console.log(`⚠️  Warning: Role is ${response.data.data.user.role}, expected EMPLOYEE\n`);
      }

      return response.data.data.tokens.accessToken;
    } else {
      console.log('❌ LOGIN FAILED!');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));
      return null;
    }
  } catch (error) {
    console.log('❌ LOGIN ERROR!');
    console.log(`   Error: ${error.message}`);
    return null;
  }
}

// Test login with wrong password
async function testLoginWrongPassword() {
  console.log('🔐 Testing LOGIN with wrong password...\n');

  try {
    const response = await makeRequest('POST', '/auth/login', {
      email: testUser.email,
      password: 'wrongpassword',
    });

    if (response.status === 401 || response.status === 400) {
      console.log('✅ Correctly rejected wrong password');
      console.log(`   Status: ${response.status}`);
      console.log(`   Message: ${response.data.message || 'Invalid credentials'}\n`);
      return true;
    } else {
      console.log('❌ Should have rejected wrong password!');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response:`, JSON.stringify(response.data, null, 2));
      return false;
    }
  } catch (error) {
    console.log('❌ LOGIN ERROR!');
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

// Main test function
async function runTests() {
  console.log('='.repeat(60));
  console.log('AUTHENTICATION API TEST');
  console.log('='.repeat(60));
  console.log('');

  // Test 1: Signup
  const signupToken = await testSignup();
  
  if (!signupToken) {
    console.log('❌ Signup failed. Cannot continue with login test.');
    process.exit(1);
  }

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 500));

  // Test 2: Login
  const loginToken = await testLogin();

  if (!loginToken) {
    console.log('❌ Login failed.');
    process.exit(1);
  }

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 500));

  // Test 3: Wrong password
  await testLoginWrongPassword();

  console.log('='.repeat(60));
  console.log('✅ ALL TESTS COMPLETED!');
  console.log('='.repeat(60));
  console.log('\n💡 You can now use these credentials in your Flutter app:');
  console.log(`   Email: ${testUser.email}`);
  console.log(`   Password: ${testUser.password}`);
  console.log(`   Role: EMPLOYEE\n`);
}

// Run tests
runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

