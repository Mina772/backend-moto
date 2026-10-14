# Backend audit artifacts

This folder owns backend audit scripts, preserved source snapshots, backend verification evidence,
and the MongoDB tools and restore fixtures used by those checks. `layout-moves.json` records each
moved file's original path, new path and SHA-256 hash before relocation.

`originals*` hold historical source snapshots relative to the backend folder. They are excluded from
ESLint and Docker builds. Evidence logs and snapshots retain their contents; paths printed by past
executions describe the layout at the time of that execution.

Run backend audit tools from `erp-backend`, for example:

```bash
npx tsx audit/scripts/server.ts
node audit/scripts/performance.mjs
```

The server uses an isolated test database. The performance script expects that server on port 5410.
`historical-readonly.mjs` reads the configured application database and writes its evidence here;
the reproduction scripts temporarily swap source files and restore them in `finally`.

Combined ERP/POS audit reports and their report-generation scripts live in the repository's root
`audit/`. They use `audit/scripts/layout.mjs` to resolve evidence and snapshots across both locations.
