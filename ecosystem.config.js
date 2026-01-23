/**
 * PM2 Ecosystem Configuration
 * 
 * Log rotation is handled by PM2 via pm2-logrotate module:
 * - Max file size: 10MB
 * - Keep 3 rotated files
 * - Logs stored in ~/.pm2/logs/ directory (or logs/ if specified)
 * 
 * Setup log rotation:
 *   1. Install pm2-logrotate: pm2 install pm2-logrotate
 *   2. Configure: pm2 set pm2-logrotate:max_size 10M
 *   3. Configure: pm2 set pm2-logrotate:retain 3
 *   4. Configure: pm2 set pm2-logrotate:compress true
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 logs expense-tracker-backend
 *   pm2 stop ecosystem.config.js
 *   pm2 delete ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name: 'expense-tracker-backend',
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      // Log file configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      merge_logs: true,
      // Memory limit
      max_memory_restart: '1G',
      // Enable PM2 monitoring
      pmx: true,
      // Auto-restart on crash
      autorestart: true,
      // Watch mode disabled in production
      watch: false,
      // Max restarts within 1 minute
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
