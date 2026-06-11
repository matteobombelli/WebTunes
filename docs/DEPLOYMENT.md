# WebTunes — Production Setup (matteob.dev/projects/webtunes)

What you need to set up, in order:

1. An AWS S3 bucket + IAM credentials (file storage)
2. A Linux box reachable from the internet (runs the Next.js app + Postgres)
3. A reverse proxy with TLS serving `matteob.dev`, routing `/projects/webtunes` to the app

LRCLIB (lyrics) needs no setup — it's a free public API with no key.

---

## 1. AWS S3

### Create the bucket
1. AWS Console → S3 → **Create bucket**
   - Name: `webtunes-prod-<your-suffix>` (must be globally unique)
   - Region: pick one close to you, e.g. `ca-west-1` (Calgary) or `us-west-2` (Oregon)
   - Leave **Block all public access ON** — presigned URLs work regardless
   - Defaults for everything else
2. Bucket → Permissions → **CORS**, paste:

```json
[
  {
    "AllowedOrigins": ["https://matteob.dev"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Accept-Ranges", "Content-Range", "Content-Length"],
    "MaxAgeSeconds": 3000
  }
]
```
DONE
### Create scoped credentials
1. IAM → Policies → **Create policy** → JSON (replace `BUCKET`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::BUCKET"
    }
  ]
}
```

2. IAM → Users → **Create user** `webtunes-app` (no console access) → attach the policy
3. User → Security credentials → **Create access key** (type: "Application running outside AWS") → save both values
DONE — real values live in `.env.production` (gitignored). **Never put the
actual keys in this file: it is committed to git.**
### Production env vars

```
S3_ENDPOINT=            # empty = real AWS
S3_REGION=ca-west-1
S3_ACCESS_KEY_ID=<in .env.production>
S3_SECRET_ACCESS_KEY=<in .env.production>
S3_BUCKET=webtunes-prod-matteobombelli
S3_FORCE_PATH_STYLE=false
```

**Cost note:** S3 charges ~$0.023/GB-month storage and ~$0.09/GB egress — every song streamed is egress. If the library grows large, Cloudflare R2 is S3-compatible with **zero egress fees** ($0.015/GB-month storage); it works with this codebase unchanged by setting `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` and R2 credentials.

---

## 2. The server — OVHcloud VPS-1 (Hillsboro, OR)

### DNS
In your domain registrar's DNS panel for `matteob.dev`:
- Set the `A` record for `matteob.dev` (apex/`@`) to the VPS's public IPv4 (shown in the OVH control panel)
- Optional: `AAAA` record for the VPS's IPv6, and a `www` CNAME → `matteob.dev`
- `.dev` is an HSTS-preloaded TLD: browsers force HTTPS, so the site only works once Caddy/certbot has a certificate — that's automatic once DNS points here

### First login + hardening (Debian 13)
```bash
ssh debian@<VPS_IP>
sudo apt update && sudo apt -y full-upgrade

# Firewall: SSH + web only (ufw isn't preinstalled on Debian)
sudo apt -y install ufw
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable

# Auto security updates
sudo apt -y install unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

# SSH keys only — run ONLY if you log in with an SSH key, not a password
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

### Install the stack
```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt -y install nodejs

# Docker
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER

# Caddy (reverse proxy + automatic TLS)
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
```

### Deploy WebTunes
On the box:

```bash
# prerequisites: Node 22+, Docker
git clone git@github.com:matteobombelli/WebTunes.git && cd WebTunes
cp .env.example .env.local        # then edit with prod values (below)
docker compose up -d postgres     # Postgres only; MinIO not needed in prod
npm ci
npx drizzle-kit migrate
npm run build
npm start                          # serves on :3000 under /projects/webtunes
```

Prod `.env.local`:

```
DATABASE_URL=postgres://webtunes:<strong-password>@localhost:5432/webtunes
AUTH_SECRET=<openssl rand -base64 32>
AUTH_URL=https://matteob.dev/projects/webtunes/api/auth
# + the S3 block from section 1
```

(Change the Postgres password in `docker-compose.yml` too, or use a managed Postgres like Neon's free tier and skip local Postgres entirely.)

Keep it running with a systemd unit:

```ini
# /etc/systemd/system/webtunes.service
[Unit]
Description=WebTunes
After=network.target docker.service

[Service]
WorkingDirectory=/path/to/WebTunes
ExecStart=/usr/bin/npm start
Restart=always
User=mbombelli

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now webtunes`

---

## 3. Reverse proxy at /projects/webtunes

The app is built with `basePath: "/projects/webtunes"`, so the proxy just passes the path through — no rewriting.

**Caddy** (simplest — automatic TLS):

```caddy
matteob.dev {
    handle /projects/webtunes* {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        # placeholder until the personal site exists; later: root + file_server
        respond "matteob.dev — coming soon" 200
    }
}
```

**nginx** (with certbot for TLS):

```nginx
location /projects/webtunes {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 200m;   # audio uploads go through the app
}
```

With Caddy, put the site config in `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy`. Certificates are fetched automatically once DNS resolves to the box.

---

## Checklist

- [x] S3 bucket created, CORS set, IAM user + access key saved
- [ ] DNS A record → VPS IP; server reachable on 80/443
- [ ] Postgres running, `drizzle-kit migrate` applied
- [ ] `.env.local` has prod `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, S3 vars
- [ ] `npm run build && npm start` behind the proxy
- [ ] Visit https://matteob.dev/projects/webtunes → register → upload → play
