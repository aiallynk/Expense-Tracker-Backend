// Using fetch instead of axios

const testLogin = async () => {
  try {
    const testData = {
      email: 'example@employee.com',
      password: 'password123',
    };

    console.log('Testing login API...');
    console.log('Request data:', testData);
    console.log('URL: http://localhost:4000/api/v1/auth/login\n');

    const response = await fetch('http://localhost:4000/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testData),
    });

    const responseData = await response.json();

    if (response.ok) {
      console.log('✅ Success!');
      console.log('Response status:', response.status);
      console.log('Response data:', JSON.stringify(responseData, null, 2));
    } else {
      console.error('❌ Error!');
      console.error('Status:', response.status);
      console.error('Status text:', response.statusText);
      console.error('Response data:', JSON.stringify(responseData, null, 2));
      
      if (responseData?.details) {
        console.error('\nValidation errors:');
        responseData.details.forEach((detail: any) => {
          console.error(`  - ${detail.path}: ${detail.message}`);
        });
      }
    }
  } catch (error: any) {
    console.error('❌ Network Error!');
    console.error('Error:', error.message);
  }
};

testLogin();

