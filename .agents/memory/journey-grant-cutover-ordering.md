---
name: Journey grant cutover ordering
description: Safe operational ordering when Journey migrations replace direct-table worker access with sealed RPCs
---

When a Journey migration revokes a worker's legacy direct-table privileges and
the replacement RPC-only code has not restarted yet, the old process can run one
retention cycle against the new grants and fail closed.

**Why:** A controlled default-off rollout observed exactly this deployment
overlap. No data was accepted or stranded, and the first cycle after restart
restored durable health, but the transient failure is expected unless code and
grant cutover are coordinated.

**How to apply:** Keep every Journey capability flag off during schema
deployment, restart the API immediately after the grant-changing migration,
then require a fresh `HEALTHY` retention row with zero retry, lag, backlog, and
consecutive failures before considering any stage activation.