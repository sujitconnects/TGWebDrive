# Installation & Deployment Guide

This guide takes you from a fresh Linux server to a live, HTTPS-secured TGWebDrive instance.

> In a hurry? See **Quick start** in the [README](README.md).

---

## 1. Prerequisites

- A Linux server (Ubuntu/Debian, AlmaLinux/RHEL, etc.) with root or `sudo` access
- **Node.js >= 20** — install via [NodeSource](https://github.com/nodesource/distributions) or `nvm`:
  ```bash
  # Example (Ubuntu/Debian)
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs build-essential python3
  ```
- **A Telegram account**
- A domain name pointing at your server (for HTTPS)

---

## 2. Get your Telegram API credentials

TGWebDrive talks to Telegram through the official API.

1. Go to <https://my.telegram.org> → **API development tools**
2. Fill in any app name/short name (they can be anything)
3. Copy your **`api_id`** (a number) and **`api_hash`** (a long string)

You'll paste these into the app the first time you connect a Telegram account. You can also pre-configure them via `API_PRESETS` in `.env` (see [Configuration](README.md#configuration)).

> **Tip:** prefer storing files in a **private channel** rather than Saved Messages — channels give you clean, dedicated folders and better organization.

---

## 3. Clone & install

```bash
git clone https://github.com/Sam8r/TGWebDrive.git
cd TGWebDrive
npm install
```

> `npm install` will compile `sharp`, so it needs `build-essential` / `python3` available.

---

## 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```ini
PORT=3001
HOST=127.0.0.1            # keep 127.0.0.1 if you'll use a reverse proxy

# Generate with:  openssl rand -hex 32
SECRET=CHANGE_ME_to_a_long_random_hex_string

# Your public URL (no trailing slash) — used to build share links
PUBLIC_URL=https://drive.example.com

# Optional: pre-fill the api_id:api_hash presets on the login screen
API_PRESETS=

# Required: Postgres connection string. All accounts, folders, shares, API
# keys and sessions live here — nothing is re-fetched from Telegram
# automatically, so this is the single source of truth for your data.
DATABASE_URL=postgres://user:password@host:5432/tgdrive
# Set to true if your provider requires SSL with a self-signed cert (most
# managed Postgres hosts — Railway, Render, Supabase, Neon, RDS — do).
DATABASE_SSL=true

# Optional: point uploads/thumbnails/branding assets at a persistent
# volume/path. Defaults to ./data next to the app.
DATA_DIR=
```

Then generate a strong secret:

```bash
openssl rand -hex 32
# paste the output as SECRET in .env
```

Create the database once (any Postgres 13+ works — a managed instance or your own):

```bash
createdb tgdrive
# or: psql -c "CREATE DATABASE tgdrive"
```

The app creates its own tables on first start — no manual migration needed.

> **Important — don't lose your data on redeploy:** every folder/channel you create and your logged-in Telegram session live in the Postgres database pointed to by `DATABASE_URL`. As long as that database is a real, persistent Postgres instance (not a local file), your data survives rebuilds/redeploys even on platforms that give you a fresh, ephemeral filesystem each time (Docker, Nixpacks-based PaaS, Kubernetes, etc.). If you previously ran an older version of TGWebDrive backed by SQLite and lost data to an ephemeral filesystem, log in again and use **New → Import existing channel** to reattach the channels Telegram still has — they aren't deleted, just no longer linked in the app.

---

## 5. Run it

### Option A — plain Node (for testing)

```bash
npm start
# → tgdrive listening on http://127.0.0.1:3001
```

### Option B — PM2 (recommended for production)

Install PM2:

```bash
sudo npm install -g pm2
```

The repo ships an [`ecosystem.config.cjs`](ecosystem.config.cjs). Edit the `cwd` path inside it to match where you cloned the repo, then:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # follow the printed instruction to start PM2 on boot
```

Check it's running:

```bash
pm2 logs tgdrive
```

---

## 6. Put it behind a reverse proxy + HTTPS

Keep TGWebDrive bound to `127.0.0.1:3001` and expose it to the world through a reverse proxy with TLS.

### Apache (httpd)

Enable the proxy modules:

```bash
sudo a2enmod proxy proxy_http ssl rewrite headers   # Debian/Ubuntu
# or on RHEL/AlmaLinux: modules are loaded by default in /etc/httpd/conf.modules.d/
```

Create a vhost (e.g. `/etc/httpd/conf.d/drive.example.com.conf`):

```apache
<VirtualHost *:80>
    ServerName drive.example.com
    RewriteEngine On
    RewriteRule ^/?(.*)$ https://%{SERVER_NAME}/$1 [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName drive.example.com

    SSLEngine on
    SSLCertificateFile     /etc/letsencrypt/live/drive.example.com/fullchain.pem
    SSLCertificateKeyFile  /etc/letsencrypt/live/drive.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/

    # Allow large uploads (up to 2 GB)
    LimitRequestBody 2147483648

    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```

### Nginx

```nginx
server {
    listen 80;
    server_name drive.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name drive.example.com;

    ssl_certificate     /etc/letsencrypt/live/drive.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/drive.example.com/privkey.pem;

    client_max_body_size 2147483648;   # 2 GB uploads

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # allow long-lived streaming & big downloads
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }
}
```

### Get a free SSL certificate (Let's Encrypt)

```bash
sudo dnf install -y certbot python3-certbot-apache    # or python3-certbot-nginx
sudo certbot --apache -d drive.example.com            # or --nginx
```

Reload the proxy and you're live:

```bash
sudo systemctl reload httpd        # Apache
# or:  sudo systemctl reload nginx
```

Open `https://drive.example.com`, create your admin account, and connect Telegram.

---

## 7. Post-install setup

1. **Create the admin account** on first visit.
2. **Connect Telegram** — enter your `api_id` + `api_hash` + phone, then the login code (and 2FA password if enabled).
3. **Create a folder** (Saved Messages, or a private channel you own).
4. **Brand it** — Settings → Branding → set your name, accent color, and logo.
5. *(Optional)* **Add users** under Settings, and **issue API keys** under API keys.

---

## 8. Updating

```bash
cd TGWebDrive
git pull
npm install            # in case dependencies changed
pm2 restart tgdrive
```

---

## 9. Backups

The only stateful things are the Postgres database (set via `DATABASE_URL`) and the `data/` folder (uploads-in-progress, thumbnails, branding logo). Back up Postgres with your provider's tooling, or manually:

```bash
pg_dump "$DATABASE_URL" > /backups/tgdrive-$(date +%F).sql
```

Files themselves are in your Telegram account, so they're as safe as your Telegram account is.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| **`better-sqlite3` build fails** | This shouldn't happen — the app uses Postgres (`pg`), which has no native build step |
| **Login code never arrives** | Use the Telegram app to check your login attempts; retry. Make sure `api_id`/`api_hash` are correct. |
| **Upload fails at ~2 GB** | That's Telegram's per-file limit. Use a Premium account for ~4 GB, or split the file. |
| **Share link shows 404** | Ensure `PUBLIC_URL` in `.env` matches your real public URL, and the proxy forwards `X-Forwarded-Proto`. |
| **Video won't seek** | Confirm your reverse proxy doesn't buffer responses (Nginx: `proxy_buffering off;`) and forwards Range headers. |
| **Can't reach the site** | Check the proxy, firewall (80/443), and that PM2 is running (`pm2 status`). |

---

Need help? Open an issue at <https://github.com/Sam8r/TGWebDrive/issues>.
