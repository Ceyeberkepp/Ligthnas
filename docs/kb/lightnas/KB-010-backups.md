# KB-010 — Backups: configure, run and verify

## Backup job fields

The NAS backup page tracks:

- Enabled
- Node
- Schedule
- Next Run
- Storage
- Comment
- Retention
- Selection

Actions include Add, Remove, Edit, Job Detail, Run now and Schedule Simulator.

## Before relying on a job

Verify:

1. the destination exists and is writable
2. the selected data is correct
3. retention is appropriate
4. a manual run completes
5. the destination contains usable backup data
6. a recovery procedure has been tested

## Important

A scheduled job record is not proof that data has been successfully backed up.

Use the job/task result and inspect the actual destination before treating the backup as recoverable.
