# Multi-App Deployment

This repository contains three Node.js applications deployed with pm2 and PostgreSQL:

1. **luo2english** - Luo to English Dictionary (port 3000)
2. **mumamaler** - Application (port 3002)
3. **wendenyasaye** - Application (port 3001)

## Quick Start (Local Development)

### Prerequisites
- Node.js (v22+)
- npm
- PostgreSQL with databases: `luo2english`, `mumamaler`, `dunga` (for wendenyasaye)

### Local Setup

```bash
# Clone repository
git clone <repo-url>
cd s

# Install dependencies for each app
cd luo2english && npm install
cd ../mumamaler && npm install
cd ../wendenyasaye && npm install

# Copy env files and configure
cd ../luo2english && cp .env.example .env
# Edit .env with DATABASE_URL and SESSION_SECRET

# Start with pm2
pm2 start ecosystem.config.js  # or use individual pm2 start commands
```

---

## Production Deployment

### Server Requirements
- Ubuntu/Debian Linux
- Node.js v22+ (install via nvm or NodeSource)
- npm
- PostgreSQL 14+
- pm2 (`npm install -g pm2`)
- nginx (for reverse proxy + SSL)

### 1. Server Initial Setup

```bash
# Create deploy user
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG sudo deploy

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pm2 globally
sudo npm install -g pm2

# Install PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# Setup PostgreSQL databases
sudo -u postgres psql <<'EOF'
CREATE USER dunga WITH PASSWORD 'your_password';
CREATE DATABASE luo2english OWNER dunga;
CREATE DATABASE mumamaler OWNER dunga;
CREATE DATABASE dunga OWNER dunga;
GRANT ALL PRIVILEGES ON DATABASE luo2english TO dunga;
GRANT ALL PRIVILEGES ON DATABASE mumamaler TO dunga;
GRANT ALL PRIVILEGES ON DATABASE dunga TO dunga;
EOF
```

### 2. Clone Repository

```bash
sudo -u deploy -i
cd /home/deploy
git clone <repo-url> s
cd s
```

### 3. Install Dependencies

```bash
cd /home/deploy/s/luo2english && npm ci --omit=dev
cd /home/deploy/s/mumamaler && npm ci --omit=dev
cd /home/deploy/s/wendenyasaye && npm ci --omit=dev
```

### 4. Configure Environment Files

Create `/etc/deploy/apps/` directory and add env files:

```bash
sudo mkdir -p /etc/deploy/apps
sudo chown deploy:deploy /etc/deploy/apps
```

**`/etc/deploy/apps/luo2english.env`**
```bash
DATABASE_URL=postgresql://dunga@/luo2english?host=/var/run/postgresql
SESSION_SECRET=your_very_long_random_string_here
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=loopback
PORT=3000
# Optional: SMTP for password reset
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user
# SMTP_PASS=pass
# MAIL_FROM=noreply@example.com
# APP_URL=https://yourdomain.com
```

**`/etc/deploy/apps/mumamaler.env`**
```bash
DATABASE_URL=postgresql://dunga@/mumamaler?host=/var/run/postgresql
SESSION_SECRET=your_very_long_random_string_here
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=loopback
PORT=3002
```

**`/etc/deploy/apps/wendenyasaye.env`**
```bash
DATABASE_URL=postgresql://dunga@/dunga?host=/var/run/postgresql
SESSION_SECRET=your_very_long_random_string_here
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=loopback
PORT=3001
```

### 5. Initialize Databases

For luo2english (run from app directory):
```bash
cd /home/deploy/s/luo2english
# Run migrations or schema initialization
# See postgres-migration/README.md for details
```

### 6. Create Admin User (luo2english)

```bash
cd /home/deploy/s/luo2english
read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
printf '%s' "$ADMIN_PASSWORD" | npm run create-admin -- admin admin@example.com
unset ADMIN_PASSWORD
```

### 7. Configure nginx

```bash
sudo cp /home/deploy/s/deploy/nginx-luo2english.conf /etc/nginx/sites-available/luo2english
sudo ln -s /etc/nginx/sites-available/luo2english /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Install SSL certificate (Let's Encrypt):
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

### 8. Start Applications with pm2

```bash
# Start each app
cd /home/deploy/s/luo2english && pm2 start npm --name luo2english -- start
cd /home/deploy/s/mumamaler && pm2 start npm --name mumamaler -- start
cd /home/deploy/s/wendenyasaye && pm2 start npm --name wendenyasaye -- start

# Save pm2 process list for auto-restart on reboot
pm2 save
pm2 startup
# Follow the printed command to enable startup
```

---

## Automated Deployment Script

Use the provided deploy script for zero-downtime deployments with rollback.

### Script: `/home/deploy/s/deploy/deploy.sh`

**Features:**
- Git-based deployment with SHA tracking
- Detects changed apps only
- Runs `npm ci --omit=dev` for each changed app
- pm2 restart with `--update-env`
- Health checks with retries
- Automatic rollback on failure

### Configuration

Set environment variables:
```bash
export DEPLOY_PATH=/home/deploy/s
export DEPLOY_BRANCH=cursor/automated-deploy  # or main
export DEPLOY_ENV_DIR=/etc/deploy/apps
export HEALTH_RETRIES=30
export HEALTH_DELAY=1
```

### App Configuration: `deploy/apps.conf`

```
luo2english|luo2english|3000|/
mumamaler|mumamaler|3002|/
wendenyasaye|wendenyasaye|3001|/
```

Format: `folder|pm2_name|port|health_path`

### Running Deployment

```bash
cd /home/deploy/s
./deploy/deploy.sh
```

### Manual Deployment (Alternative)

If not using the deploy script:

```bash
# Pull latest
cd /home/deploy/s
git fetch origin
git reset --hard origin/cursor/automated-deploy

# Install deps for changed apps
cd luo2english && npm ci --omit=dev
cd ../mumamaler && npm ci --omit=dev
cd ../wendenyasaye && npm ci --omit=dev

# Restart with updated env
pm2 restart luo2english --update-env
pm2 restart mumamaler --update-env
pm2 restart wendenyasaye --update-env
```

---

## Monitoring & Maintenance

### pm2 Commands
```bash
pm2 status              # Check app status
pm2 logs luo2english    # View logs
pm2 monit               # Real-time monitoring
pm2 restart all         # Restart all apps
pm2 reload all          # Zero-downtime reload (cluster mode)
```

### Health Checks
```bash
curl -f http://localhost:3000/  # luo2english
curl -f http://localhost:3001/  # wendenyasaye
curl -f http://localhost:3002/  # mumamaler
```

### Database Backups
```bash
# Daily backup cron
0 2 * * * pg_dump -U dunga luo2english | gzip > /backup/luo2english_$(date +\%F).sql.gz
0 3 * * * pg_dump -U dunga mumamaler | gzip > /backup/mumamaler_$(date +\%F).sql.gz
0 4 * * * pg_dump -U dunga dunga | gzip > /backup/wendenyasaye_$(date +\%F).sql.gz
```

### Log Rotation
pm2 handles log rotation. Configure in `~/.pm2/pm2.log` or use `pm2 install pm2-logrotate`.

---

## Security Checklist

- [ ] Strong `SESSION_SECRET` (64+ random chars)
- [ ] PostgreSQL: `pg_hba.conf` uses peer/md5 auth, not trust
- [ ] Firewall: Only ports 22, 80, 443 open
- [ ] nginx: HTTPS only, HSTS, secure headers
- [ ] Env files: `chmod 600 /etc/deploy/apps/*.env`
- [ ] Regular security updates: `apt update && apt upgrade`
- [ ] pm2: Run as non-root user (deploy)

---

## Troubleshooting

### App won't start
```bash
pm2 logs luo2english --lines 100
# Check DATABASE_URL, SESSION_SECRET, PORT
```

### Database connection failed
```bash
# Test connection
psql "postgresql://dunga@/luo2english?host=/var/run/postgresql" -c "SELECT 1"
# Check PostgreSQL is running: systemctl status postgresql
```

### Health check fails
```bash
# Check if app binds to correct host/port
ss -tlnp | grep :3000
# Check NODE_ENV=production and TRUST_PROXY=loopback
```

### Rollback manually
```bash
cd /home/deploy/s
git log --oneline -5
git reset --hard <previous_sha>
pm2 restart all --update-env
```

---

## Project Structure

```
s/
├── deploy/
│   ├── deploy.sh              # Automated deployment script
│   ├── apps.conf              # App configuration (folder|name|port|health)
│   └── nginx-luo2english.conf # nginx template
├── luo2english/               # Dictionary app
│   ├── app.js
│   ├── package.json
│   ├── .env.example
│   └── ...
├── mumamaler/                 # App 2
├── wendenyasaye/              # App 3
└── postgres-migration/        # Database migration scripts
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | 64+ char random string for session signing |
| `NODE_ENV` | Yes | `production` enables security headers |
| `HOST` | Yes | `127.0.0.1` for local binding |
| `TRUST_PROXY` | Yes | `loopback` for nginx proxy |
| `PORT` | Yes | App port (3000, 3001, 3002) |
| `SMTP_HOST` | No | SMTP server for password reset emails |
| `SMTP_PORT` | No | SMTP port (587) |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `MAIL_FROM` | No | From email address |
| `APP_URL` | No | Public URL for email links |

---

## License

MIT