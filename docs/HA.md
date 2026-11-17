# Warm standby

This page has two options. Warm standby is continuous verified backups. Streaming replication (further down) follows the database about once a second. Neither is high availability.

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

## Streaming replication (optional)

Warm standby loses everything since the last backup. Streaming replication cuts that to a couple of seconds. It uses [Litestream](https://litestream.io), a separate program that reads the database's write-ahead log and ships new changes to a replica about once a second. This repo doesn't reimplement that. It pins the Litestream image by digest, ships the config, and tests the recovery.

Turn it on with the override file:

```sh
docker compose -f compose.yaml -f compose.streaming.yaml up -d
```

Edit `deploy/litestream.yml` first. It ships with a file replica on a local volume so the drill runs anywhere. For real use, point it at object storage you control (S3, Azure Blob, GCS) on separate hardware, and put the credentials in the environment, not in the file.

**What was measured.** `npm run test:failover-stream` (needs Docker) runs a real server on a replicated database, writes an item and waits, writes a second item 2.5 seconds before the kill and a third one instantly before it, kills the server and Litestream together, deletes the primary's data, restores from the replica and starts a server on the result. Three runs out of three: the item written 2.5 seconds before the kill survived, the item written instantly before it was lost, and the server answered `/readyz` about 0.9 seconds after the failure. So the practical loss window is a couple of seconds, not zero. This is one laptop with a tiny database, with a local file replica. A big database restores slower, and object storage adds network time, so measure it on your own data.

**Restore by hand:**

```sh
docker run --rm -v replica-data:/replica -v restored:/restore litestream/litestream:0.3.13 \
  restore -o /restore/sss.db file:///replica/sss
node cli.js kill clear    # the restored copy may carry a stop latch from the failure
```

Stop the old primary first and never bring it back as another writer. That rule is the same as for warm standby. It's still a manual decision by a person, and failover is not automatic.

**Erasure and the replica.** The replica keeps older generations so you can restore to a point in the past. That means text you erased from the live database can still sit in the replica until the retention window passes. The shipped config keeps 72 hours. Set `retention` to the shortest period you can live with (the repo's check refuses anything over a week), and treat the replica location as a place erased text can survive, like any backup. See [PRIVACY_DATA_MAP.md](PRIVACY_DATA_MAP.md).

**What it still isn't.** It's one writer on one database with a copy that follows it. It is not two writers, not automatic failover, and not Postgres. A replicated database is still the answer when failover has to happen without a person.

## Decide deliberately

| Need | Warm standby is enough when | Use a replicated database instead when |
| --- | --- | --- |
| Availability | Minutes of operator-led recovery are acceptable | Failover must be automatic or near-continuous |
| Data loss | One backup interval of lost writes is acceptable | Losing recent committed writes is not acceptable |
| Writers | One writer, manually changed during an incident | More than one writer or coordinated failover is required |
| Operations | Someone can confirm the old primary is stopped | No one can safely make that decision during an outage |
