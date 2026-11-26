# Kristallball

Kristallball is an enterprise-style military asset management system for
synthetic demonstration data. It includes a secured backend API and a
responsive React operations workspace.

## Project Structure
```text
backend/
  config/
  controllers/
  middlewares/
  models/
  routes/
  .env.example
  package.json
  server.js
frontend/
  public/
  src/
    components/
    context/
    hooks/
    pages/
    services/
    App.jsx
    index.css
    main.jsx
  .env.example
  package.json
  tailwind.config.js
  vite.config.js
README.md
.gitignore
```

## Phase 1 Setup

Backend and frontend dependencies are intentionally installed and configured
separately. Configure `backend/.env` from `backend/.env.example` and
`frontend/.env` from `frontend/.env.example` before local development. From
the workspace root, run these commands in separate PowerShell terminals:

```powershell
Set-Location .\backend
npm run dev
```

```powershell
Set-Location .\frontend
npm run dev
```

Create and verify the frontend production bundle with:

```powershell
Set-Location .\frontend
npm run build
```

## Production Deployment Architecture

The production platform will use:

- Vercel for the React frontend
- Render for the Node.js and Express backend
- Neon for the PostgreSQL database

Deployment is intentionally deferred until all development, testing, security,
and production-build verification phases are complete.

### Required Environment Variables

Backend settings for Render:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Set to `production` |
| `PORT` | Render supplies this value |
| `DATABASE_URL` | Restricted runtime database connection only |
| `MIGRATION_DATABASE_URL` | Separate migration-owner connection for maintenance commands only |
| `CORS_ORIGIN` | Exact comma-separated Vercel frontend origins |
| `JWT_SECRET` | Base64url secret generated from at least 32 random bytes; never commit it |

Frontend settings for Vercel:

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Deployed Render API origin, for example `https://project-api.onrender.com/api` |

Never commit real environment values. The committed files [.env.example](/C:/Users/madhu/OneDrive/Desktop/military-management/backend/.env.example)
and [frontend/.env.example](/C:/Users/madhu/OneDrive/Desktop/military-management/frontend/.env.example)
contain placeholders only.

Generate or rotate the backend JWT secret from a PowerShell terminal in the
`backend` directory. This writes 48 cryptographically random bytes as
unpadded Base64URL directly to the existing `.env` file and does not print the
secret. Run it only when intentionally rotating the key; it replaces the
current `JWT_SECRET` while preserving other environment settings.

```powershell
$envPath = Join-Path (Get-Location) ".env"
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw "Create backend/.env from backend/.env.example first."
}

$content = [System.IO.File]::ReadAllText($envPath)
$secretLines = [regex]::Matches($content, "(?m)^[ \t]*JWT_SECRET[ \t]*=.*$")
if ($secretLines.Count -ne 1) {
  throw "Expected exactly one JWT_SECRET setting in backend/.env."
}

$bytes = New-Object byte[] 48
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($bytes)
}
finally {
  $random.Dispose()
}

$secret = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$line = $secretLines[0]
$equalsIndex = $line.Value.IndexOf("=")
$prefix = $line.Value.Substring(0, $equalsIndex + 1)
$replacement = $prefix + $secret
$updated = $content.Substring(0, $line.Index) + $replacement +
  $content.Substring($line.Index + $line.Length)
[System.IO.File]::WriteAllText(
  $envPath,
  $updated,
  [System.Text.UTF8Encoding]::new($false)
)
[Array]::Clear($bytes, 0, $bytes.Length)
Remove-Variable secret
```

### Planned Deployment Steps

1. Create a Neon PostgreSQL project and synthetic database.
2. Apply TypeORM migrations; do not use destructive schema synchronization.
3. Create a Render Web Service from the `backend` directory.
4. Configure Render environment variables with the Neon connection URL and deployed frontend origin.
5. Deploy and verify `https://<render-service>/api/health`.
6. Create a Vercel project from the `frontend` directory.
7. Set `VITE_API_BASE_URL` to the Render API origin.
8. Deploy and verify frontend-to-backend communication.
9. Verify authentication, role permissions, base isolation, inventory workflows, and the production build.

### Deployment Troubleshooting

- **CORS blocked:** The exact Vercel origin must be included in `CORS_ORIGIN`,
  without a trailing slash.
- **Frontend cannot reach the API:** Confirm `VITE_API_BASE_URL` includes `/api`
  and begins with `https://`.
- **Database TLS or connection failure:** Confirm the Neon connection string,
  SSL configuration, database credentials, and Render environment variables.
- **Render service does not start:** Confirm the service root is `backend`,
  the start command is `npm start`, and dependencies are installed.
- **Vercel route refresh returns 404:** Configure the Vite SPA rewrite in
  `frontend/vercel.json` before deploying React Router pages.
- **Vercel rebuild is missing environment settings:** Redeploy after changing
  `VITE_*` variables because Vite embeds them at build time.

## Backend JWT Authentication

The backend exposes `POST /api/auth/login` and `GET /api/auth/me`. Login
normalizes email by trimming and lowercasing it, verifies the bcrypt password
hash, and returns a generic invalid-credentials response for unknown,
incorrect-password, and inactive-account cases. Login is limited to 10 attempts
per client IP in a 15-minute window.

Set `JWT_SECRET` to the base64url-encoded output of at least 32
cryptographically random bytes. Use the PowerShell instructions in
[Required Environment Variables](#required-environment-variables) to write a
48-byte Base64URL secret directly to the existing backend `.env` without
printing it.

The committed `.env.example` intentionally leaves `JWT_SECRET` empty so copying
it without configuration fails startup. Never put the generated value in
source control or logs. Access tokens use HS256, issuer `kristallball-api`,
audience `kristallball-client`, and a 15-minute expiration. The token contains
only the user's UUID subject and standard issuer, audience, issued-at, and
expiration claims; it contains no password hash, role, base, or active status.

Every `/api/auth/me` request verifies the token and looks the subject up again
through the restricted runtime database connection. The current user's role,
base ID, and active state therefore come from PostgreSQL, not from token claims.
The core APIs below use the same database-loaded user for authorization.

JWTs are stateless: there is no server-side logout or refresh-token endpoint.
When logging out, a client must discard its access token from memory. The
frontend must not persist authentication tokens in `localStorage` or
`sessionStorage`.

Run the authentication tests with `node --test config/authentication.test.js`
from `backend/`. The ordinary `npm test` command is useful for local feedback,
but PostgreSQL integration tests skip when the isolated test URL is unset.
Use `npm run test:release` as the fail-closed verification gate before release.
In production the Express app trusts one reverse-proxy hop for client IP
rate-limiting; keep the service behind the configured Render proxy.

## Phase 3 Step 4 Core APIs

All new routes apply authentication, backend authorization, and request
validation before controller execution. Collection endpoints use bounded
pagination (`limit` 1-100, default 50). User responses are safe DTOs and never
include password hashes. There are no hard-delete endpoints.

| Method | Endpoint | Access |
|---|---|---|
| `GET`, `POST` | `/api/users` | `ADMIN` |
| `GET`, `PATCH` | `/api/users/:id` | `ADMIN` |
| `PATCH` | `/api/users/:id/status` | `ADMIN` |
| `GET` | `/api/bases`, `/api/bases/:id` | `ADMIN` global; `BASE_COMMANDER` and `LOGISTICS_OFFICER` assigned base only |
| `GET` | `/api/bases/transfer-destinations` | `ADMIN` active bases; `LOGISTICS_OFFICER` active bases except own base; `BASE_COMMANDER` denied |
| `POST`, `PATCH` | `/api/bases`, `/api/bases/:id`, `/api/bases/:id/status` | `ADMIN` |
| `GET`, `POST` | `/api/equipment-types` | All three roles, global catalog |
| `GET`, `PATCH` | `/api/equipment-types/:id` | All three roles, global catalog |
| `PATCH` | `/api/equipment-types/:id/status` | All three roles, global catalog |
| `GET` | `/api/inventory`, `/api/inventory/:id`, `/api/inventory/summary` | `ADMIN` global; other roles assigned base only |
| `GET` | `/api/inventory/bases/:baseId`, `/api/inventory/equipment-types/:equipmentTypeId` | `ADMIN` global; other roles assigned base only |
| `POST` | `/api/inventory/opening-stock` | `ADMIN` only |

Equipment-type catalog access and management are global for `ADMIN`,
`BASE_COMMANDER`, and `LOGISTICS_OFFICER`, as approved for this phase. Base and
inventory access is derived from the authenticated user record; a request
parameter cannot grant access to another base. Base deactivation is rejected
when dependent records exist.

User, base, and equipment-type collections support bounded search and status
filters; users can also be filtered by role. Inventory listing supports base
and equipment-type filters, while base-scoped users remain restricted to their
assigned base.

Inventory quantities use `inventory_movement` as the single movement ledger.
Only completed purchases and transfers contribute to movement totals. The API
calculates `Closing Balance = Opening Balance + Purchases + Transfers In -
Transfers Out - Assigned - Expended`; returns reduce net assigned quantities.
The inventory-movement database trigger serializes writes on the affected asset
and rejects any movement that would make its current-time balance negative;
future opening stock and future-dated movements do not make stock available to
current operations. User base
assignments lock and validate the active base inside the same transaction;
base deactivation locks the base and checks its references before updating it.
Base-scoped mutation APIs follow the same transactional locking rules.

Opening stock is initialized once per base and equipment type by an `ADMIN`.
`POST /api/inventory/opening-stock` inserts the asset position with a positive
opening balance and a server-generated `opening_at` timestamp, using the
existing unique base/equipment constraint. The insert and
`OPENING_STOCK_CREATED` audit event share one transaction. Opening stock is
not represented by a fabricated inventory movement; there are no edit, delete,
or correction endpoints for the opening balance.

Run the isolated API route tests from `backend/` with
`node --test config/coreApi.test.js`. They use synthetic users, an in-memory
controlled DataSource, and a loopback HTTP server; they do not connect to a
database. The complete `npm test` suite includes PostgreSQL integration tests,
which skip when `KRISTALLBALL_ISOLATED_TEST_DATABASE_URL` is unset; use the
fail-closed release gate before release.

## Phase 3 Step 5 Business Operations

The mutation API is mounted under `/api`. Each route applies authentication,
policy/resource authorization, strict body and idempotency-key validation, and
controller-level database rechecks. Client-supplied actor IDs, roles, statuses,
timestamps, and derived inventory values are not accepted.

| Method and endpoint | Authorization |
|---|---|
| `POST /api/purchases` | ADMIN global; LOGISTICS_OFFICER own base; BASE_COMMANDER denied |
| `POST /api/transfers` | ADMIN global; LOGISTICS_OFFICER own source base; BASE_COMMANDER denied |
| `POST /api/transfers/:transferId/approve` | BASE_COMMANDER at destination base; ADMIN and LOGISTICS_OFFICER denied |
| `POST /api/transfers/:transferId/reject` | BASE_COMMANDER at destination base; ADMIN and LOGISTICS_OFFICER denied |
| `POST /api/transfers/:transferId/complete` | LOGISTICS_OFFICER at destination base; ADMIN and BASE_COMMANDER denied |
| `POST /api/assignments` | ADMIN global; BASE_COMMANDER own base; LOGISTICS_OFFICER denied |
| `POST /api/assignments/:assignmentId/returns` | ADMIN global; BASE_COMMANDER own base; LOGISTICS_OFFICER denied |
| `POST /api/expenditures` | ADMIN global; BASE_COMMANDER own base; LOGISTICS_OFFICER denied |

Purchases are created as `PENDING` only and never create inventory movements.
There is no purchase approval, completion, or rejection endpoint. Transfer
initiation, approval, and rejection do not reserve or change inventory.
Completion locks both existing asset positions in ID order and records exactly
one outgoing and one incoming ledger movement in the same transaction. The
database balance trigger remains the final defense against negative inventory.
Assignment returns use the database return trigger; application code does not
insert a second return movement. New operations require active resources;
returns may reference existing assignments after asset or equipment
deactivation.

Every mutation requires an `Idempotency-Key` header containing 1-128 ASCII
letters, digits, periods, underscores, colons, or hyphens. Keys are globally
unique across business operations and permanently retained in the
append-only `business_idempotency` table; keys are not reusable for another
actor, operation, or payload. An exact actor/operation/normalized-payload retry
replays the original successful HTTP status and safe response. Reuse with any
mismatch returns `409 IDEMPOTENCY_KEY_REUSED`. The table stores a fingerprint
and replayable safe response, not the original request body. It has no cleanup
job; retention is indefinite to preserve retry semantics.

Successful business mutations and their audit records commit or roll back
together. Audit snapshots contain minimal state only; they exclude free-text
expenditure notes and personnel references. The database audit sanitizer and
append-only trigger remain enabled. Business endpoints do not add read
permissions.

Run controlled tests from `backend/` with
`node --test config/businessOperations.test.js`. The PostgreSQL integration
suite includes business-operation transactions and requires
`KRISTALLBALL_ISOLATED_TEST_DATABASE_URL` to point to a newly initialized,
disposable local cluster. Never point it at any configured, shared, staging,
hosted, or production database.

## Phase 3 Step 6B Reporting and Dashboard APIs

The read-only reporting endpoints use the authenticated user's current database
role and base. `ADMIN` can request global data or an explicitly selected base;
`BASE_COMMANDER` and `LOGISTICS_OFFICER` are limited to their assigned base.
Transfer reports include a transfer when that base is either its source or
destination. Base-scoped users cannot expand access with a `baseId` query
parameter.

| Method and endpoint | Access and scope |
|---|---|
| `GET /api/dashboard` | `ADMIN`, global |
| `GET /api/bases/:baseId/dashboard` | `ADMIN`, selected base; other roles, own base |
| `GET /api/reports/inventory-movements` | `ADMIN`, global or selected base; other roles, own base |
| `GET /api/reports/purchases` | `ADMIN`, global or selected base; other roles, own base |
| `GET /api/reports/transfers` | `ADMIN`, global or selected base; other roles, transfers involving own base |
| `GET /api/reports/assignments` | `ADMIN`, global or selected base; other roles, own base |
| `GET /api/reports/returns` | `ADMIN`, global or selected base; other roles, own base |
| `GET /api/reports/expenditures` | `ADMIN`, global or selected base; other roles, own base |

Report filters accept `baseId`, `equipmentTypeId`, `from`, `to`, `limit`, and
`offset` as applicable. UTC ISO-8601 timestamps are required; `from` and `to`
are inclusive, future or invalid timestamps are rejected, and the maximum
range is 365 days. Pagination defaults to 50 rows and is capped at 100.
The inventory-movements endpoint also accepts a validated `movementType`
filter for its paged ledger entries; its period balance remains based on all
movement types so it can reconcile to closing inventory.

Inventory period summaries use the inventory ledger and the requested period:
opening balance is the ledger-derived balance immediately before `from`,
period movements are inclusive, and closing balance applies completed purchases
and transfers, net assignments after returns, and expenditures. If original
asset stock is initialized during the period, it is reported separately as
`openingBalanceIntroduced` and included once in closing balance; it is not
classified as a purchase or transfer. Assets initialized after the period do
not contribute stock to that period. A period's `netAssigned` can be negative
when returns in the period restore inventory assigned before the period;
earlier assignments and returns are already reflected in `openingBalance`.
Pending purchases and pending or approved transfers do not affect inventory.
Current inventory and dashboard totals exclude opening stock before
`opening_at` and ledger movements after the current time.
Assignment reports include gross assigned, cumulative returned, and net
assigned quantities; their period filters and ordering use `assigned_at`.
Returns reports filter by the return event timestamp. Expenditure reports
contain quantities only. Purchase and transfer lifecycle reports show current
status; historical status changes are not reconstructible because status
history is not stored.

Run the synthetic, mock-backed route tests with
`node --test config/reportingApi.test.js`. These tests exercise HTTP routing,
authorization, request validation, DTOs, and controller behavior. The
`reportingApi.integration.test.js` suite also runs the actual report and
dashboard queries against the isolated PostgreSQL cluster using synthetic
fixtures. It verifies historical opening/closing balances, inclusive event
dates, purchase and transfer status semantics, assignment/return quantities,
expenditures, base scoping, and dashboard reconciliation. Query plans and index
effectiveness are not benchmarked by these tests.

## Phase 3 Step 7 Frontend

The React application uses the `VITE_API_BASE_URL` environment variable for
all backend requests. Set it to the API origin ending in `/api`; do not put
production service URLs or credentials in source code. The frontend keeps the
short-lived access token in memory only, attaches it as a Bearer token, and
clears the session after a 401 response or sign-out. Refreshing the page
requires signing in again; there is no refresh-token endpoint.

The protected workspace includes the dashboard, base directory, user
management, equipment catalog, inventory, purchases, transfers, assignments
and returns, expenditures, audit metadata, and reports. Navigation and
operation forms reflect the current role for usability, while backend
authorization remains authoritative. Audit views show safe event metadata
only, not snapshots. The frontend uses backend inventory and report quantities
without recalculating ledger balances.

User, base, and equipment-type screens provide API-backed search and filters,
detail views, pagination, and their permitted management actions. The
inventory screen provides base/equipment filters, pagination, and displays the
opening balance and timestamp. Only `ADMIN` users see the one-time opening
stock form; successful initialization refreshes inventory and its summary.
Purchase, transfer, assignment/return, and expenditure histories use bounded
previous/next pagination from their report endpoints.
Reports provide date/base/equipment filters and bounded previous/next
pagination using the report API's returned totals.

Purchases can be submitted only as pending requests; no purchase completion
control is available. Transfers require an idempotency key and expose only
role-appropriate initiation, approval, rejection, and completion actions.
Assignment references and all other demonstration records must be synthetic.
Expenditure reporting shows quantities only; it does not invent monetary
totals.

For local development, copy `frontend/.env.example` to `frontend/.env` and set
`VITE_API_BASE_URL` to the backend API URL. Run `npm run dev` from
`frontend/`. Verify the production bundle with `npm run build`. Vercel's SPA
rewrite is configured in `frontend/vercel.json`; set the Vercel environment
variable to the deployed Render API URL.

## Phase 5 Administrative Audit Trail

Administrative audit events are written in the same database transaction as
their successful mutations. User creation, user detail/role/base-assignment
updates, user activation/deactivation, base creation/update/activation/
deactivation, equipment-type creation/update/activation/deactivation, and
opening-stock creation are recorded as `USER_CREATED`, `USER_UPDATED`,
`USER_ACTIVATED`, `USER_DEACTIVATED`, `BASE_CREATED`, `BASE_UPDATED`,
`BASE_ACTIVATED`, `BASE_DEACTIVATED`, `EQUIPMENT_TYPE_CREATED`,
`EQUIPMENT_TYPE_UPDATED`, `EQUIPMENT_TYPE_ACTIVATED`,
`EQUIPMENT_TYPE_DEACTIVATED`, and `OPENING_STOCK_CREATED`. Role and base
changes are represented by the single `USER_UPDATED` event and its sanitized
changed-field metadata; they do not create duplicate update events.

Existing business event categories remain enabled: purchase creation, transfer
initiation/approval/rejection/completion, assignment creation, assignment
returns, and expenditure recording. Opening stock produces one
`OPENING_STOCK_CREATED` event and does not create a second audit entry.

Only `ADMIN` can read global audit events. `BASE_COMMANDER` and
`LOGISTICS_OFFICER` can read events associated with their own base; transfer
events remain visible to the permitted source and destination bases. A
non-admin cannot widen access with a base filter. The API returns bounded,
paginated event metadata (including actor ID, action, entity, base,
correlation ID, and server timestamp), never before/after snapshots,
credentials, access tokens, IP addresses, or user-agent values. User audit
snapshots omit identity and contact values; the database sanitizer removes
sensitive snapshot keys, and database triggers plus runtime-role privileges
keep audit records append-only. There are no ordinary application API routes
for creating, updating, or deleting audit records.

From `backend/`, run the audit API, sanitizer, and controller tests with:

```powershell
node --test config/auditApi.test.js config/auditSanitizer.test.js config/coreApi.test.js
```

The administrative transaction integration test is
`config/administrativeAudit.integration.test.js`; run it only with
`KRISTALLBALL_ISOLATED_TEST_DATABASE_URL` pointed at a fresh, disposable,
loopback-only PostgreSQL test cluster. It creates and drops its own isolated
test database. Never use an application, hosted, shared, staging, or
production database for these tests.

## Local Demo Accounts

The local demo seed creates these synthetic accounts when their normalized
email addresses do not already exist:

- `admin.demo@example.com` (`ADMIN`, no base assignment)
- `commander.demo@example.com` (`BASE_COMMANDER`, synthetic local base)
- `logistics.demo@example.com` (`LOGISTICS_OFFICER`, same synthetic local base)

Run the seed from PowerShell in the `backend` directory:

```powershell
.\scripts\seed-demo.ps1
```

The script prompts for the agreed temporary demo password without echoing it.
It is supplied only to the local seed process and is never written to source,
`.env`, logs, audit records, or API responses. The seed stores only a bcrypt
hash using the existing password-hashing cost. Use the existing login page at
`http://localhost:5173/login` with one of the emails above and the password
entered at the prompt.

The seed requires `NODE_ENV=development`, an explicit one-run opt-in, the
restricted `kristallball_runtime` connection in `DATABASE_URL`, the
`kristallball_app` role setting, and a loopback PostgreSQL connection to the
local `military-management` database on port `5433`. It also validates the
runtime role's effective permissions before writing. Production and remote
database targets are rejected.

The application schema and all required migrations must already be applied.
The seed never runs migrations, changes database roles, or modifies existing
accounts, bases, or inventory. Existing demo email addresses are skipped
without changing their passwords or account state. A synthetic base is added
only when needed for a new commander or logistics account; no equipment or
opening stock is created. Account/base audit events are written in the same
transaction as their inserts.

## Database Migration Policy

- Never edit a migration after it has been applied in any shared or production
  environment.
- Create a new migration for every schema correction.
- Review migration SQL and rollback behavior before production deployment.
- Rollbacks are deliberate operations and must be tested on a database copy.
- Production migrations must not run automatically during application startup.
- `TYPEORM` is configured with `migrationsTransactionMode: "all"` where each
  migration batch is supported.

Set `DB_SSL=true` and `DB_SSL_REJECT_UNAUTHORIZED=true` for hosted PostgreSQL
connections. The Neon or other hosted database certificate must be verified.

## Runtime Application Database Role

Separate the migration owner from the runtime application account:

- The migration owner may create tables, types, indexes, triggers, and migrations.
- The runtime login must inherit the non-login `APP_DATABASE_ROLE` and must not
  inherit the migration-owner login or any role inherited by that login.
- Neither the runtime login nor application role may own application tables,
  protected tables, or the `public` schema.
- Neither role may be superuser, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, or have
  replication privileges.
- Database credentials must come from Render environment variables.

Set `APP_DATABASE_ROLE` and run the permission script using
`MIGRATION_DATABASE_URL`. The script independently connects through both
`DATABASE_URL` and `MIGRATION_DATABASE_URL` before provisioning. It compares
the current database name and OID with a database-specific identity marker and
requires distinct `session_user` roles. Different connection endpoints are
allowed; matching hostnames or URL strings are not used as proof of identity.
Provisioning fails closed if either identity is missing, malformed, or
mismatched. Only the maintenance connection performs permission changes.

Before opening its HTTP listener, the backend performs read-only checks through
`DATABASE_URL` for the runtime database identity, safe runtime/application
role attributes and memberships, temporary-table access,
object ownership, database CREATE, schema/table/routine/sequence privileges,
and append-only table protections. `APP_DATABASE_ROLE` must be configured; the
backend exits without serving requests if any check fails. Startup validation
does not grant or revoke database permissions.

The configured effective table privileges are:

| Permission | Runtime application access |
|---|---|
| `SELECT` | All application tables except `typeorm_migrations` |
| `INSERT` | `base`, `equipment_type`, `app_user`, `asset`, `purchase`, `transfer`, `assignment`, `expenditure`, `return_operation`, `inventory_movement`, `audit_log`, `business_idempotency` |
| `UPDATE` | `base`, `equipment_type`, `app_user`, `asset`, `purchase`, `transfer`, `assignment`, `expenditure`, `return_operation` |
| `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` | Not granted |

`inventory_movement`, `audit_log`, and `business_idempotency` allow inserts but
not updates, deletes, or truncation; append-only database triggers remain an
additional defense.
Validation checks effective table and column privileges (including inherited
grants) for `SELECT`, `INSERT`, `UPDATE`, and `REFERENCES`. It rejects column
grants that would bypass the table allowlist, including any access to
`typeorm_migrations`. The provisioner checks every public application table and
fails closed if a required table is missing, an unexpected relation exists, or
either runtime role has a grant outside this allowlist. It revokes `CREATE` on
the `public` schema from the application role and verifies that neither runtime
role has effective `CREATE` access. It does not alter unrelated roles,
silently grant membership, transfer ownership, or remove unexpected runtime
privileges.

All current entity identifiers are UUIDs, generated with PostgreSQL
`gen_random_uuid()` by the migrations; application inserts do not require
sequence privileges. TypeORM may use a sequence for migration metadata; if
present, it follows the same ownership policy. The runtime login and
application role must have no effective privileges on any public sequence.
The migration owner must own each public sequence, if present, so maintenance
can manage it.

The migration owner must be a separate login used only through
`MIGRATION_DATABASE_URL`, with no superuser, `BYPASSRLS`, `CREATEDB`,
`CREATEROLE`, replication, or privileged inherited role. It must not own the
database or `public` schema. Instead, it must have effective `USAGE` and
`CREATE` on `public` and own all twelve application tables plus the
`typeorm_migrations` metadata table. Migrations run as this owner create and
own their tables; if an existing object has a different owner, provisioning
fails and an administrator must review the arrangement. The provisioning
script never transfers ownership or grants broad DDL privileges. The schema
itself remains owned by its database administrator/provider role.

### Database Identity Marker

Before provisioning, an administrator must assign each intended database a
unique UUID marker in its database comment. Use a newly generated UUID for each
database, and rotate the marker after cloning or restoring a database:

```sql
COMMENT ON DATABASE kristallball
  IS 'kristallball.identity=<unique-uuid>';
```

Both connection roles must be able to read the database catalog comment. The
provisioner verifies the marker together with the actual database name and OID,
and verifies that `session_user` differs between the two connections. A
missing/malformed marker or a mismatch blocks provisioning before the
QueryRunner is created. The marker is an identity label, not a credential; do
not reuse it across independent databases.

### Schema and Routine Allowlist

The only approved application schema is `public`; there are currently no
additional application-specific infrastructure schemas. PostgreSQL's own
`pg_catalog`, `information_schema`, TOAST, and temporary schemas are excluded
from the application-object inventory. Any other non-system schema, even an
empty one, causes validation to fail until explicitly reviewed and added to
the code allowlist.

The migration owner requires `USAGE` and `CREATE` on `public` but may not own
the schema or database. The application role and runtime login require
`USAGE`, must not have `CREATE`, and may not own any application schema. The
runtime validator inventories tables, views, materialized views, foreign
tables, and sequences; checks their effective privileges and ownership; and
fails closed for unlisted public relations.

The application routine allowlist is limited to the seven migration-defined
`SECURITY INVOKER` routines: the audit/inventory append-only and integrity
trigger functions, `validate_inventory_balance()`,
`process_return_operation()`, `sanitize_audit_json(jsonb)`, and
`sanitize_audit_log_insert()`. These are required by the database triggers
and audit-sanitization path. The validator rejects other public routines and
any `SECURITY DEFINER` routine. It also checks effective `EXECUTE` through
inherited role memberships.

The initial migration installs `pgcrypto` in `public`. Its `gen_random_uuid()`
routine is allowed for UUID defaults. Other pgcrypto routines must not be
executable by the runtime role or application group; the database owner or
extension owner must revoke their default `PUBLIC` execution grants. The
validator checks this state and does not silently alter extension privileges.
If another workload shares this database, review the impact of that
extension-level ACL correction before applying it.

### Runtime TEMPORARY Privilege

The runtime login must not have effective `TEMPORARY` privilege on the
application database. PostgreSQL commonly grants `TEMPORARY` on newly created
databases to `PUBLIC`; this means every role can create temporary tables unless
that grant is removed or otherwise countered. A temporary relation can shadow
an unqualified relation name during trigger execution, so the runtime validator
checks the actual login with PostgreSQL's effective
`has_database_privilege(..., 'TEMPORARY')` function. That check accounts for
direct grants, inherited memberships, and grants to `PUBLIC`, and fails closed
if the runtime connection identity or privilege cannot be verified.

Do not revoke privileges automatically from application startup or ordinary
role provisioning. A database owner or administrator must first select the
intended disposable test database explicitly, then review and run the narrow
database-level operation:

```sql
REVOKE TEMPORARY ON DATABASE kristallball_test FROM PUBLIC;
```

Replace `kristallball_test` with the exact selected database identifier; do not
run this example against a shared or production database as part of local
testing. This removes only `PUBLIC`'s TEMPORARY grant on that database. If the
runtime login or any role it inherits has a separate direct TEMPORARY grant,
an administrator must inspect and revoke that specific grant separately. Do
not use blanket ACL changes. Verify the runtime login's effective privilege
afterward:

```sql
SELECT has_database_privilege(
  'kristallball_runtime',
  'kristallball_test',
  'TEMPORARY'
) AS runtime_can_create_temporary_objects;
```

The result must be `false`. The application validator independently performs
the same effective check using the connected runtime login; a valid URL or
application-role setting is not a substitute for checking the live database
identity and effective privilege.

On the intended database, an administrator or extension owner can remove
those default grants without changing the `gen_random_uuid()` grant:

```sql
DO $$
DECLARE
  routine_record record;
BEGIN
  FOR routine_record IN
    SELECT routine.oid::regprocedure AS signature
    FROM pg_proc routine
    JOIN pg_depend dependency
      ON dependency.classid = 'pg_proc'::regclass
     AND dependency.objid = routine.oid
     AND dependency.refclassid = 'pg_extension'::regclass
     AND dependency.deptype = 'e'
    JOIN pg_extension extension
      ON extension.oid = dependency.refobjid
    JOIN pg_namespace namespace
      ON namespace.oid = routine.pronamespace
    WHERE extension.extname = 'pgcrypto'
      AND namespace.nspname = 'public'
      AND routine.proname <> 'gen_random_uuid'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
      routine_record.signature
    );
  END LOOP;
END
$$;
```

Role provisioning uses a QueryRunner transaction. PostgreSQL role membership,
`GRANT`, and `REVOKE` operations used by this script are transactional; a
failed validation rolls back its permission changes. The script requires the
roles and runtime membership to exist before it runs.

### Trigger Resolution Protections

Migration `1795545540000-HardenTriggerSearchPath` is a forward-only security
migration. It keeps trigger functions `SECURITY INVOKER`, sets their explicit
search path to `pg_catalog, public, pg_temp`, and schema-qualifies application
tables and helper-function calls. Explicit qualification is the primary
temporary-table shadowing defense; placing `pg_temp` last is additional
hardening, not a replacement for qualification or for denying runtime
TEMPORARY privilege. The migration contains no dynamic SQL or sequence
references. Do not edit historical migrations that may already have run; apply
the new migration through the separately controlled migration-owner workflow.
The migration has no safe `down()` operation by design. If it fails, inspect
the migration error and database migration history, correct the cause, and
retry only through the migration-owner connection after testing on a disposable
database copy. Do not edit an applied historical migration, delete migration
history, or mark the migration applied manually. If a later correction is
needed, use a reviewed forward-only migration; use backup restoration only
under the normal database recovery procedure.

### Isolated PostgreSQL Integration Tests

The PostgreSQL integration tests require a newly initialized, disposable local
cluster. They create and drop test roles, schemas, objects, and database
comments, so never point `KRISTALLBALL_ISOLATED_TEST_DATABASE_URL` at a
configured application database or any shared, staging, or production server.
`npm run test:postgres` runs only the PostgreSQL integration suites;
`npm run test:release` runs all backend test files serially, including the
reporting and dashboard database integration suite. The PostgreSQL suites run
sequentially and the runner fails if any required integration suite reports
zero tests or skipped tests. Both commands fail before starting tests unless
`KRISTALLBALL_ISOLATED_TEST_DATABASE_URL` is
explicitly set to a password-free `127.0.0.1` URL for the `postgres` database
on a non-default port. Neither command falls back to `DATABASE_URL` or
`MIGRATION_DATABASE_URL`. The integration suites then verify the data-directory
marker before creating their disposable test databases.

The tests enforce a password-free loopback URL to database `postgres`, port
other than `5432`, and a data directory named with the
`kristallball-step1-pg-` prefix. `synchronize` and automatic migrations remain
disabled; tests apply the actual migration classes explicitly inside the
disposable test database.

Example PowerShell setup and cleanup (run from `backend`; use the PostgreSQL
binary directory installed on the test machine):

```powershell
$pgBin = "C:\Program Files\PostgreSQL\18\bin"
$testData = Join-Path $env:TEMP ("kristallball-step1-pg-" + [guid]::NewGuid().ToString("N"))
$testPort = 55432
$started = $false
$testExitCode = 1
try {
  & "$pgBin\initdb.exe" -D $testData --username=postgres --auth=trust --encoding=UTF8 --no-locale
  if ($LASTEXITCODE -ne 0) { throw "initdb failed" }
  & "$pgBin\pg_ctl.exe" -D $testData -o "-h 127.0.0.1 -p $testPort" -l "$testData.log" start
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed" }
  $started = $true
  $env:KRISTALLBALL_ISOLATED_TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:$testPort/postgres"
  npm run test:release
  $testExitCode = $LASTEXITCODE
} finally {
  Remove-Item Env:\KRISTALLBALL_ISOLATED_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  if ($started) {
    & "$pgBin\pg_ctl.exe" -D $testData stop -m immediate
    if ($LASTEXITCODE -ne 0) { throw "Disposable PostgreSQL shutdown failed" }
  }
  Remove-Item -LiteralPath $testData -Recurse -Force
  Remove-Item -LiteralPath "$testData.log" -Force -ErrorAction SilentlyContinue
}
if ($testExitCode -ne 0) { throw "npm run test:release failed with exit code $testExitCode" }
```

Choose a port that is not already in use before starting the cluster. Run the
tests only against that new cluster, and ensure cleanup completes even if a
test fails. `npm test` without the isolated test URL is not release
verification; use `npm run test:release`, which fails closed when the isolated
URL is missing or malformed.

> **Safety warning:** Run role provisioning only against an intended isolated
> test/development database until separately approved. Never run it against
> production or a shared database as part of this phase.

Provision the non-login group and separate runtime login, and grant membership
before running the validation script:

```powershell
cd C:\Users\madhu\OneDrive\Desktop\military-management\backend
$env:DATABASE_URL="postgresql://runtime_login@host:5432/kristallball"
$env:MIGRATION_DATABASE_URL="postgresql://migration_owner@host:5432/kristallball"
$env:APP_DATABASE_ROLE="kristallball_app"
npm run apply-app-role
```

Create the roles and grant membership administratively before running the
script. Set passwords through the database provider's secure role-management
interface; do not put credentials in SQL files or source control.

```sql
CREATE ROLE kristallball_migration LOGIN INHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE kristallball_app NOLOGIN INHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE kristallball_runtime LOGIN INHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT kristallball_app TO kristallball_runtime;
```

Set `APP_DATABASE_ROLE` to `kristallball_app`; the runtime login in
`DATABASE_URL` must be
`kristallball_runtime`. The application group must stay `NOLOGIN`. The script
does not create roles, change role attributes, grant runtime membership, or
remove unexpected runtime-login privileges. If validation fails, an
administrator must inspect and correct the exact reported role or grant before
retrying it against the isolated database.

The `CORS_ORIGIN` setting is the same in this README and
`backend/.env.example`; Express's CORS middleware in `backend/server.js` reads
that variable as a comma-separated origin allowlist.

Do not use broad `REVOKE ALL` or blanket grants to make provisioning pass.
Review and correct only the specific pre-existing privilege or ownership
configuration reported by the validator.

### Local PostgreSQL 14 Development Setup

The Windows local-development configuration assumes PostgreSQL 14.x, the
`postgresql-x64-14` service, and a server listening only on `localhost` at port
`5433`. Create or select the `military-management` database in pgAdmin. Keep
this database separate from any hosted, shared, or production database.

Use the role definitions above to create the migration login, the non-login
`kristallball_app` role, and the restricted runtime login. Set distinct role
passwords through pgAdmin's role properties; do not put passwords in SQL,
README files, or source control. The `postgres` administrator is for
administrative setup only and must not be used by the application.

Configure the untracked `backend/.env` with the local connection details:

```dotenv
DATABASE_URL=postgresql://kristallball_runtime:URL_ENCODED_RUNTIME_PASSWORD@127.0.0.1:5433/military-management
MIGRATION_DATABASE_URL=postgresql://kristallball_migration:URL_ENCODED_MIGRATION_PASSWORD@127.0.0.1:5433/military-management
APP_DATABASE_ROLE=kristallball_app
```

Replace each password placeholder locally with its matching role password,
URL-encoding any reserved characters. The runtime and migration URLs must use
different logins. The backend loads `.env` relative to its own directory, and
environment variables already supplied by the process take precedence.

Before any migration, use a password-prompting `psql` session for read-only
checks. These commands target loopback explicitly and do not place a password
in command history:

```powershell
psql -X -W -h 127.0.0.1 -p 5433 -U postgres -d military-management -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_setting('server_version'), inet_server_addr(), inet_server_port();"
psql -X -W -h 127.0.0.1 -p 5433 -U postgres -d military-management -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.typeorm_migrations') IS NOT NULL AS migration_history_exists;"
```

Only if `migration_history_exists` is true, inspect the recorded history with:

```powershell
psql -X -W -h 127.0.0.1 -p 5433 -U postgres -d military-management -v ON_ERROR_STOP=1 -c "SELECT id, timestamp, name FROM public.typeorm_migrations ORDER BY id;"
```

The repository migration command is `npm run migration:run`; it uses the
TypeORM migration DataSource and `MIGRATION_DATABASE_URL`, with synchronization
and automatic migrations disabled. Do not run it until the target, version,
existing migration history, and migration review are verified and explicit
approval is given.

### Runtime and Migration Database Connections

The Express process uses `DATABASE_URL` only. It is the restricted runtime
login and must not be a PostgreSQL superuser, migration owner, or owner of the
public schema or protected application objects.

`GET /api/health` performs a read-only query through the initialized runtime
connection. It returns HTTP 503 with a generic unavailable status when the
database is not initialized or cannot be queried; connection details are never
included in the response.

Database maintenance commands use `MIGRATION_DATABASE_URL` only:

```powershell
cd C:\Users\madhu\OneDrive\Desktop\military-management\backend
npm run migration:run
npm run migration:revert
npm run seed
npm run apply-app-role
```

For an intended isolated test/development database, run `migration:run` before
`apply-app-role`; provisioning requires every application table and
`typeorm_migrations` to exist. Apply the role permissions only after the
separate runtime login and its membership in the non-login application role
have been created administratively.

These commands fail if `MIGRATION_DATABASE_URL` is missing; they never fall
back to `DATABASE_URL`. The Express process does not import or construct the
migration-owner DataSource. It waits for the runtime database connection to
initialize before opening its HTTP listener.

For local development, create separate PostgreSQL roles and store their
connection strings in an untracked `backend/.env` copied from
`backend/.env.example`. The runtime role should inherit the least-privilege
`APP_DATABASE_ROLE`; the migration owner should be separate. Replace placeholder
values locally without committing them. Do not use the local PostgreSQL
superuser in either application configuration.
