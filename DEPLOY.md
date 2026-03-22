# Deployment Instructions

Run these commands from your local terminal (replace password if needed):

## 1. Copy files to VPS
```bash
scp -r /path/to/this/folder root@165.245.189.200:/tmp/poly-deploy
# OR clone from git and scp that
```

## 2. SSH in and run deploy script
```bash
ssh root@165.245.189.200
bash /tmp/poly-deploy/deploy.sh
```

That's it. The deploy script:
- Installs Node.js 20 + PM2
- Copies files to /opt/polymarket-scanner
- Starts web server on port 3000 via PM2
- Sets up cron job (8am UTC daily)
- Runs first scan in background
