# k6 Load Testing Suite for Nexpense Backend

This directory contains a comprehensive k6 load testing suite to validate the Nexpense Backend's performance and scalability under various load conditions.

## Prerequisites

1. **Install k6**: Follow the [k6 installation guide](https://k6.io/docs/getting-started/installation/)
2. **Node.js**: Required for test data generation scripts
3. **Test Users**: Pre-seed test users in your database (see Setup section)

## Directory Structure

```
load-tests/
├── scenarios/          # Test scenario files
├── lib/                # Shared utility libraries
├── config/             # Configuration files
├── data/               # Test data files
├── scripts/            # Helper scripts
└── README.md          # This file
```

## Test Scenarios

### 1. Concurrent Logins (100k concurrent)
- **File**: `scenarios/01-concurrent-logins.js`
- **Target**: 100,000 concurrent virtual users
- **Duration**: Ramp-up to 100k VUs over 5 minutes, hold for 2 minutes
- **Command**: `k6 run --env BASE_URL=http://localhost:4000 scenarios/01-concurrent-logins.js`

### 2. Expense Creation (500k per minute)
- **File**: `scenarios/02-expense-creation.js`
- **Target**: 500,000 requests per minute (8,333 RPS)
- **Duration**: 1 minute constant rate
- **Command**: `k6 run --env BASE_URL=http://localhost:4000 scenarios/02-expense-creation.js`

### 3. Report Fetch (1M requests)
- **File**: `scenarios/03-report-fetch.js`
- **Target**: 1,000,000 total requests
- **Duration**: Distributed over 10 minutes (10k RPS average)
- **Command**: `k6 run --env BASE_URL=http://localhost:4000 scenarios/03-report-fetch.js`

### 4. Spike Test (10x traffic suddenly)
- **File**: `scenarios/04-spike-test.js`
- **Target**: Sudden 10x increase in traffic
- **Duration**: Baseline (1k VUs) → Spike (10k VUs) → Recovery (1k VUs)
- **Command**: `k6 run --env BASE_URL=http://localhost:4000 scenarios/04-spike-test.js`

### 5. Soak Test (24 hours constant load)
- **File**: `scenarios/05-soak-test.js`
- **Target**: Sustained moderate load for 24 hours
- **Duration**: 24 hours at 500 constant VUs
- **Command**: `k6 run --env BASE_URL=http://localhost:4000 --duration 24h scenarios/05-soak-test.js`

## Setup

### 1. Generate Test Users

Generate test user credentials:

```bash
cd BACKEND/load-tests
node scripts/generate-test-users.js 100000 data/test-users.json
```

This creates a JSON file with 100,000 test users.

### 2. Seed Test Users in Database

Before running load tests, you must seed these users in your database. You can:

- Use the backend's seed script: `npm run seed:users` (if configured)
- Create users via the signup API endpoint
- Import users directly into MongoDB

**Important**: Test users must exist in the database before running load tests.

### 3. Create Test Reports (for expense/report tests)

For expense creation and report fetch tests, users need existing expense reports. You can:

- Pre-create reports via the API
- Use the test setup functions (they create reports automatically)
- Seed reports using backend scripts

## Running Tests

### Individual Test Execution

```bash
# Login test
k6 run --env BASE_URL=http://localhost:4000 scenarios/01-concurrent-logins.js

# Expense creation test
k6 run --env BASE_URL=http://localhost:4000 scenarios/02-expense-creation.js

# Report fetch test
k6 run --env BASE_URL=http://localhost:4000 scenarios/03-report-fetch.js

# Spike test
k6 run --env BASE_URL=http://localhost:4000 scenarios/04-spike-test.js

# Soak test (24 hours)
k6 run --env BASE_URL=http://localhost:4000 --duration 24h scenarios/05-soak-test.js
```

### Using npm scripts

```bash
npm run test:login
npm run test:expense
npm run test:report
npm run test:spike
npm run test:soak
```

### Environment Configuration

Set the base URL via environment variable:

```bash
# Local
k6 run --env BASE_URL=http://localhost:4000 scenarios/01-concurrent-logins.js

# Staging
k6 run --env BASE_URL=https://staging.nexpense.com scenarios/01-concurrent-logins.js

# Production (use with caution!)
k6 run --env BASE_URL=https://api.nexpense.com scenarios/01-concurrent-logins.js
```

## Distributed Testing

### Using k6 Cloud

For distributed execution across multiple load zones:

```bash
k6 cloud scenarios/01-concurrent-logins.js
```

Requires k6 Cloud account setup.

### Local Distributed Testing

Run multiple k6 instances with execution segments:

```bash
# Terminal 1
k6 run --out influxdb=http://localhost:8086/k6 --execution-segment 0:1/3 scenarios/01-concurrent-logins.js

# Terminal 2
k6 run --out influxdb=http://localhost:8086/k6 --execution-segment 1/3:2/3 scenarios/01-concurrent-logins.js

# Terminal 3
k6 run --out influxdb=http://localhost:8086/k6 --execution-segment 2/3:1 scenarios/01-concurrent-logins.js
```

This splits the load across 3 instances.

### Using Docker Compose (Monitoring Stack)

Start InfluxDB and Grafana for metrics visualization:

```bash
docker-compose up -d
```

Then run tests with InfluxDB output:

```bash
k6 run --out influxdb=http://localhost:8086/k6 scenarios/01-concurrent-logins.js
```

View metrics in Grafana at http://localhost:3000

## Thresholds & Assertions

All tests enforce the following thresholds:

- **Error rate**: < 0.1% (`http_req_failed < 0.001`)
- **Response time p95**: < 300ms (`http_req_duration p(95) < 300`)
- **Response time p99**: < 500ms (`http_req_duration p(99) < 500`)
- **Status codes**: 200/201 responses should be fast

Spike tests use relaxed thresholds (p95 < 500ms) to account for traffic surges.

## Monitoring

### Built-in k6 Metrics

k6 automatically tracks:
- HTTP request duration
- HTTP request failure rate
- Virtual user count
- Iteration count
- Data sent/received

### Custom Metrics

Tests track custom metrics:
- `auth_success_rate`: Authentication success rate
- `expense_creation_success_rate`: Expense creation success rate
- `report_fetch_success_rate`: Report fetch success rate

### External Monitoring

For comprehensive monitoring, track:

1. **MongoDB Connection Pool**: Monitor connection pool usage via application logs
2. **Memory Usage**: Use system monitoring tools (e.g., `htop`, `docker stats`)
3. **CPU Usage**: Monitor CPU utilization during tests
4. **Database Performance**: Enable MongoDB profiler to track slow queries

## Output & Results

k6 outputs results to the console. For detailed analysis:

### JSON Output

```bash
k6 run --out json=results.json scenarios/01-concurrent-logins.js
```

### CSV Output

```bash
k6 run --out csv=results.csv scenarios/01-concurrent-logins.js
```

### InfluxDB Output (for Grafana)

```bash
k6 run --out influxdb=http://localhost:8086/k6 scenarios/01-concurrent-logins.js
```

## Troubleshooting

### Test Users Not Found

**Error**: "Test users file not found"

**Solution**: Generate test users first:
```bash
node scripts/generate-test-users.js 100000 data/test-users.json
```

### Authentication Failures

**Error**: High authentication failure rate

**Solutions**:
1. Ensure test users are seeded in the database
2. Verify user credentials match the generated test data
3. Check database connection and authentication service

### No Reports Available

**Error**: "No users with reports available" (expense/report tests)

**Solution**: Pre-create expense reports for test users or let the setup function create them automatically.

### Memory Issues

**Error**: k6 runs out of memory

**Solutions**:
1. Reduce the number of VUs
2. Use distributed testing
3. Increase system memory
4. Use k6 Cloud for large-scale tests

## Best Practices

1. **Start Small**: Begin with lower VU counts and gradually increase
2. **Monitor Resources**: Watch CPU, memory, and database connections
3. **Use Staging First**: Always test on staging before production
4. **Schedule Tests**: Run soak tests during off-peak hours
5. **Document Results**: Save test results for comparison over time
6. **Set Alerts**: Configure alerts for threshold violations

## Additional Resources

- [k6 Documentation](https://k6.io/docs/)
- [k6 Cloud](https://app.k6.io/)
- [k6 Examples](https://github.com/grafana/k6-examples)
- [Performance Testing Best Practices](https://k6.io/docs/test-authoring/best-practices/)

## Support

For issues or questions:
1. Check k6 documentation
2. Review test logs and error messages
3. Verify database and API connectivity
4. Consult the backend team for API changes
