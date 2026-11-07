# Cal.diy local evaluation

This isolated stack is an experimental integration target, not a production system.
The upstream project recommends Cal.diy for personal, non-production use and omits
the Teams and Organizations functionality needed to assess multi-clinic isolation.

The intended upstream checkout is `../cal-engine-upstream`, at commit
`2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`. It is deliberately ignored by Git.
The stack has separate database and Redis volumes and loopback-only ports. It is not
connected to Hoomana's API, and does not yet have a scheduling adapter.

On this machine, the dedicated database and Redis started successfully. The web
and API builds are not yet proven: the official published image could not be
downloaded due to a Docker Hub HTTP 403, and the API source build stalled during
dependency fetching. A successful Compose configuration check does not prove
that the application is running.

Rechecked on 2026-11-04: both Docker and direct requests to Docker Hub's registry
and token service returned HTTP 403. Retrying the API build with reduced download
concurrency also stalled, so the API and web containers are not running. Restore
access to Docker Hub and dependency downloads before retrying the build.

After VPN was enabled, the token service and registry became reachable, but Docker
Hub returned no published tags for `calcom/cal.diy`, and downloading the Node base
image timed out at Docker's distribution host. A further source build again stalled
while fetching dependencies. The separate database and Redis remain running.

After restoring Docker registry access or successfully completing source builds:

```powershell
docker compose --env-file infra/cal-engine/.env -f infra/cal-engine/docker-compose.yml up -d --build
docker compose --env-file infra/cal-engine/.env -f infra/cal-engine/docker-compose.yml ps
```

The local `.env` contains generated credentials; retain it with the corresponding
volumes and do not commit it. The source build requires significant RAM, disk space
and dependency downloads. Do not put real patient data into this evaluation setup
or expose it to the network.
