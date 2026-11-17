# Warm standby

This is warm standby by continuous verified backups. It is not high availability.

`replicate` makes a SQLite snapshot, independently restores and verifies it, then atomically updates `latest.json`. The recovery point objective is the configured replication interval, plus any failed runs. `standby` is a manual promotion and fences a stale copy or a copy fresh enough that the old primary might still be writing. The failover drill measures recovery time on the machine where it runs. This repository has not measured that drill in this sandbox because loopback ports are unavailable here.

What it does not give: automatic failover, two writers, zero data loss, or a safe stale replica. Writes since the last verified backup are lost. Keep replica storage on separate hardware. Stop the old primary before promotion and never bring it back as another writer.

## What was measured

`npm run test:failover` starts a real primary, writes an item, runs one replication, writes a second item, kills the primary with SIGKILL, promotes the standby and starts a server on it. On one laptop with a tiny database that took about one second from the `standby` command to a server answering `/readyz`, and the second item (written after the backup) was lost, which is the recovery point loss this design accepts. Real recovery time is **detecting the failure, deciding, and confirming the old primary is stopped**, plus that second. The database size, disk speed and your decision process dominate; measure it on your own data.

## Run the replicator

Compose service (mount `/replica` from separate storage):

```yaml
replicator:
  image: see-spec-send
  command: ["node", "cli.js", "replicate", "--to", "/replica/sss", "--every", "5m", "--keep", "12"]
  volumes: ["sss-data:/data", "replica-data:/replica"]   # the data volume must be writable: a live SQLite database needs its -shm file even to be read
  environment: ["SSS_DB=/data/sss.db"]
```

For systemd, use the same command in `ExecStart=` with `Restart=on-failure`; the process lock prevents two copies in one replica directory. A cron alternative is:

```cron
*/5 * * * * /usr/bin/node /srv/see-spec-send/cli.js replicate --to /srv/replica/sss --once --keep 12 >>/var/log/sss-replicate.log 2>&1
```

## Decide deliberately

| Need | Warm standby is enough when | Use a replicated database instead when |
| --- | --- | --- |
| Availability | Minutes of operator-led recovery are acceptable | Failover must be automatic or near-continuous |
| Data loss | One backup interval of lost writes is acceptable | Losing recent committed writes is not acceptable |
| Writers | One writer, manually changed during an incident | More than one writer or coordinated failover is required |
| Operations | Someone can confirm the old primary is stopped | No one can safely make that decision during an outage |
