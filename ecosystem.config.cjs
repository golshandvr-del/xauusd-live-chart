module.exports = {
  apps: [
    {
      name: 'xauusd',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000',
      cwd: '/home/user/webapp',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
