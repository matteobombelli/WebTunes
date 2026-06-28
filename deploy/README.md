# Deploy units

## Nightly DB backup → R2

`scripts/backup-db-to-r2.mjs` dumps the Postgres database (via
`docker compose exec postgres pg_dump -Fc`) and uploads it to the existing R2
bucket under the `backups/` prefix, then prunes to the **7 newest** dumps. It
reuses the app's `S3_*` and `DATABASE_URL` env vars (R2 at-rest encryption; no
extra key to manage).

### Install (on the VPS, as `debian`)

```sh
sudo cp /home/debian/WebTunes/deploy/webtunes-backup.service /etc/systemd/system/
sudo cp /home/debian/WebTunes/deploy/webtunes-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webtunes-backup.timer
```

### Check

```sh
systemctl list-timers webtunes-backup          # next/last run
systemctl start webtunes-backup.service        # run once, now
journalctl -u webtunes-backup.service          # logs (dump size, uploaded key, pruning)
```

### Restore

Download the desired `webtunes-<ts>.dump` from R2 (`backups/` prefix), then:

```sh
docker compose exec -T postgres pg_restore -U webtunes -d webtunes \
  --clean --if-exists < webtunes-<ts>.dump
```

`--clean --if-exists` drops existing objects before recreating them, so this
restores in place over the current database.

## Daily purge of expired share links

`scripts/purge-expired-shares.mjs` deletes `track_shares` rows whose
`expires_at` has passed (public track-share links auto-expire after 7 days).
Expired rows are already inert — `lib/shares.ts` filters by expiry and the
create-upsert self-heals same-track collisions — so this timer is the guarantee
they don't linger in the table. Reuses `DATABASE_URL`.

### Install (on the VPS, as `debian`)

```sh
sudo cp /home/debian/WebTunes/deploy/webtunes-purge-shares.service /etc/systemd/system/
sudo cp /home/debian/WebTunes/deploy/webtunes-purge-shares.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webtunes-purge-shares.timer
```

### Check

```sh
systemctl list-timers webtunes-purge-shares     # next/last run
sudo systemctl start webtunes-purge-shares.service  # run once, now
journalctl -u webtunes-purge-shares.service     # logs (number of links purged)
```

## Daily purge of expired invite links

`scripts/purge-expired-invites.mjs` deletes `invites` rows that expired without
ever being used (`used_at IS NULL AND expires_at < now()`) — registration invite
links auto-expire after 7 days. REDEEMED invites are kept (the "used by <name>"
history on the Invite tab). Expired unused rows are already inert
(`lib/invites.ts` filters by `used_at` + expiry), so this timer is the guarantee
they don't linger. Reuses `DATABASE_URL`.

### Install (on the VPS, as `debian`)

```sh
sudo cp /home/debian/WebTunes/deploy/webtunes-purge-invites.service /etc/systemd/system/
sudo cp /home/debian/WebTunes/deploy/webtunes-purge-invites.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webtunes-purge-invites.timer
```

### Check

```sh
systemctl list-timers webtunes-purge-invites    # next/last run
sudo systemctl start webtunes-purge-invites.service  # run once, now
journalctl -u webtunes-purge-invites.service    # logs (number of links purged)
```
