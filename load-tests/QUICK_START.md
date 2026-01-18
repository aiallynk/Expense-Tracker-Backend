# Quick Start Guide - k6 Load Testing

## ✅ Current Status

- ✅ k6 is installed and working (v1.5.0)
- ✅ API is accessible at http://localhost:4000
- ⚠️ Test users need to be seeded in the database

## Next Steps

### 1. Seed Test Users in Database

Before running load tests, you need to create test users in your database. You have several options:

#### Option A: Use Backend Seed Script (Recommended)
```bash
cd BACKEND
# If you have a seed script that accepts user data
npm run seed:users
```

#### Option B: Create Users via API
You can create users programmatically using the signup endpoint:
```bash
# Example: Create a few test users via curl or Postman
POST http://localhost:4000/api/v1/auth/signup
{
  "email": "loadtest0@test.nexpense.com",
  "password": "TestPassword0!",
  "name": "Load Test User 0"
}
```

#### Option C: Import via MongoDB
If you have MongoDB access, you can import the generated test-users.json file.

### 2. Verify Setup

Run the validation test again after seeding users:
```bash
cd BACKEND/load-tests
k6 run --env BASE_URL=http://localhost:4000 scenarios/00-validation-test.js
```

Expected: All checks should pass (login successful, access token present).

### 3. Run Load Tests

Once users are seeded, you can run the full load tests:

#### Small Scale Test (Recommended First)
```bash
# Modify scenarios to use fewer VUs for initial testing
# Edit the scenario files and reduce target VUs
k6 run --env BASE_URL=http://localhost:4000 scenarios/01-concurrent-logins.js
```

#### Full Scale Tests
```bash
# 100k concurrent logins (WARNING: Very intensive!)
k6 run --env BASE_URL=http://localhost:4000 scenarios/01-concurrent-logins.js

# 500k expense creation per minute
k6 run --env BASE_URL=http://localhost:4000 scenarios/02-expense-creation.js

# 1M report fetch requests
k6 run --env BASE_URL=http://localhost:4000 scenarios/03-report-fetch.js

# Spike test
k6 run --env BASE_URL=http://localhost:4000 scenarios/04-spike-test.js

# Soak test (24 hours - run during off-peak!)
k6 run --env BASE_URL=http://localhost:4000 --duration 24h scenarios/05-soak-test.js
```

## Test Results Summary

### Validation Test Results
- ✅ k6 execution: Working
- ✅ API connectivity: Working (http://localhost:4000)
- ✅ Health check: Passing
- ❌ Login: Failing (test users not in database)
- ⚠️ HTTP failure rate: 50% (expected until users are seeded)

### Performance Baseline
- Average response time: ~68ms
- p95 response time: ~651ms
- API is responsive and accessible

## Recommendations

1. **Start Small**: Before running full-scale tests, start with reduced VU counts:
   - Test with 10-100 VUs first
   - Gradually increase to target load
   - Monitor system resources (CPU, memory, DB connections)

2. **Monitor Resources**: 
   - Watch MongoDB connection pool
   - Monitor server CPU and memory
   - Check database query performance

3. **Use Staging First**: Always test on staging environment before production

4. **Schedule Soak Tests**: Run 24-hour soak tests during off-peak hours

## Troubleshooting

### Login Failures
- **Issue**: All logins failing
- **Solution**: Seed test users in database first

### High Error Rates
- **Issue**: Error rate > 0.1%
- **Solution**: Check backend logs, database connectivity, and server resources

### Memory Issues
- **Issue**: k6 or backend running out of memory
- **Solution**: Reduce VU count or use distributed testing

## Next Actions

1. ✅ k6 installed
2. ✅ Test scripts created
3. ⏳ **Seed test users in database** ← **YOU ARE HERE**
4. ⏳ Run validation test
5. ⏳ Run small-scale load test
6. ⏳ Run full-scale load tests
