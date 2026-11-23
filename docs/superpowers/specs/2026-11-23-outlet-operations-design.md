# CafeOS Milestone 4: Outlet Operations and Task Tracking. Design

Status: **draft** (owner reviewing, 23 Nov 2026). Design only: nothing is applied to any database or connected to Petpooja until the owner approves. Petpooja access and records will be confirmed by the owner on 24 Nov; until then only Part 1 (tasks and notifications) is planned, built and tested on the TEST database.

**Owner revisions, 23 Nov 2026 (supersede anything below that says otherwise):**
- **Every task owner needs a linked, active login** (so they receive notifications). Tasks cannot be assigned or moved to staff without a login, and nobody starts or submits a task for its owner; HR can still add notes. (Replaces D8's "HR records on behalf".)
- **Evidence retention stays a proposed setting (D10, proposed 24 months).** Nothing deletes evidence automatically until the owner approves a period; the daily job only sends reminders.
- **Upload size (owner decision, 24 Nov 2026):** the app keeps its 6 MB request limit; proof uploads are at most 3 files, 5 MB each and 5 MB in total per submission (resource files 5 MB each). The database keeps a wider outer limit (5 files of 10 MB).
- Defaults while undecided: D7 uploaded Petpooja exports deleted after parsing; D9 employees see no sales or stock.
- D1-D6 wait for the owner's Petpooja answers (24 Nov). D11 (employees see their own rating) proposed yes.

## 1. Intent and why
The owner wants one place to see how each outlet is doing and to give staff occasional, checkable jobs.
- **Sales:** sales are already recorded in Petpooja (the POS). Staff must not type them in again. CafeOS shows and analyses them, down to which food items sold, how many, when and where. The goal is to spot popular and slow items, and good times and outlets for promotions.
- **Tasks:** HR gives a specific person a specific job at a specific outlet (not a daily checklist), the person proves it was done, HR approves or asks for changes. The approved history may inform a later, human-made salary or incentive review.
- **Stock:** if Petpooja cannot provide stock, a small count-based stock record for agreed items.

## 2. Goals, non-goals, anti-goals
**Goals**
1. Read-only sales data from Petpooja: outlet totals and item-level sales per outlet and business date, reconciled against Petpooja's own totals, never counted twice.
2. Daily and weekly totals, outlet comparison, actual against HR-set targets.
3. Item analysis: best and slow sellers, sales by time of day and weekday, discounts and refunds per item, and (where costs exist) margin, to help plan offers.
4. Tasks with owner, outlet, description, due date, priority, required proof, a clear workflow, private evidence, in-app notifications and full history.
5. Stock: Petpooja stock if available; otherwise a small CafeOS stock count.
6. Every entry and correction recorded with who, when and why.

**Non-goals (this milestone)**
- Creating, publishing or changing offers, menus, prices or stock in Petpooja. CafeOS never writes to Petpooja.
- Purchasing, suppliers, invoices, accounting or recipe costing.
- Payroll, incentive calculation, automatic scoring or salary changes.
- Customer data of any kind (names, phones, addresses, loyalty ids) and payment-card details.
- Email or SMS notifications (in-app only).
- Daily recurring checklists.

**Anti-goals (failure even if it "works")**
- A figure that differs from Petpooja without CafeOS saying so.
- A sale counted twice because a report was imported twice or re-exported after a correction.
- Staff re-entering sales by hand.
- Any customer or card data stored, even in a raw upload.
- An employee seeing another person's tasks or evidence, or any sales or stock figure the owner has not approved for them.
- A salary-relevant judgement made by the system instead of a person.

## 3. What exists today (reused, not duplicated)
Checked on branch `milestone-4-daily-status` = `main` at `7192a4d` (contains three roles, Employee Management, Attendance and Leave; 33 migrations).
- **Organisations and tenant isolation:** every company table has `organization_id`, composite FKs `(organization_id, parent_id)`, PostgreSQL row-level security, app account `hr_runtime`; identity comes from the session (`app_org_id()`, `app_user_id()`, `app_my_employee_id()`, `app_has_permission()`).
- **Outlets** (`outlets`): name, address, active flag, opening/changeover/closing hours. Reused as the CafeOS side of the outlet match and as a task's outlet.
- **Employees** (`employees`): home `outlet_id`, `member_id` (login), status. A task's outlet is a separate field, so helping at another outlet never changes the profile.
- **Roles and permissions:** exactly `SUPER_ADMIN`, `HR_MANAGER`, `EMPLOYEE`; checks by permission key in the app and in SQL. `report:read`, `integration:read`, `integration:manage`, `notification:read` already exist.
- **Notifications** (`notifications`): table addressed to a **login** (`recipient_user_id` → users), with subject, body, read time; RLS lets a person read and mark only their own; the app account has no insert path (inserts come from database functions). Recruitment-shaped extras (`application_id`, channel, status) stay unused here. No screen uses it yet (the employee home shows "You have no notifications"). Reused for task notifications: new `NotificationType` values for tasks (enum migration) and a small notification list.
- **Audit log** (`audit_logs`): append-only, Super Admin reads. Reused for every HR action, alongside each module's own history tables (as Leave and Attendance do).
- **Integration tables** (`integration_connections`, `external_entity_mappings`, `integration_sync_jobs`, `integration_sync_errors`): built for an outbound link to an external system ("CafeOS", from before this project became CafeOS); unused; `IntegrationSystem` has only `CAFEOS`, mappings are strictly one-to-one, sync jobs are outbound-shaped. Only `integration_connections` is reused, and only when a Petpooja API is granted (add `PETPOOJA`; the secret stays outside the database, only a `secret_reference` is stored). File imports get their own batch and outlet-mapping tables (see 6.3, 6.4; builder-check call).
- **Private file storage** (`src/lib/recruitment/storage.ts`): a put/get/remove store on disk under a private folder with random keys, limited today to `resumes` and `documents` folders; content checks and size limits live in `resume.ts` and the upload helpers; files are served only through authorised routes and the folder is in the daily verified backup. Reused for task evidence with a new `tasks` folder in the key pattern, and new photo checks (JPEG/PNG/WebP/HEIC) alongside the existing PDF check.
- **Daily housekeeping job** (10:00): retention, backup, expiry, checks. A scheduled import step can be added there later.

## 4. Petpooja: what is actually available (research, 23 Nov 2026)
Only public sources were read; Petpooja was not contacted and nothing was connected.
- **No official public API documentation for reading sales was found.** Independent catalogues describe Petpooja's published APIs as partner APIs for online-ordering aggregators: menu sync, pushing orders INTO Petpooja (`save_order`), marking menu items in or out of stock. These write into Petpooja and are not what CafeOS needs.
- **A read endpoint appears to exist but is unverified.** An unofficial project fetches "sales data" with a partner `app_key`, `app_secret`, `access_token` and restaurant id for a date range. It returns bill-level rows only: receipt number, receipt date, time, invoice amount, tax, discount, round-off, net sale, payment mode, order type, transaction status. **No item lines.** Credentials there were "supplied" (partner access); there is no self-service sign-up.
- **Petpooja's own reports** (official pages): downloadable reports of sales, item-wise consumption, online orders and more; export "with a single click"; a multi-outlet dashboard; scheduled emailed reports. Day-end inventory reports exist in its inventory module.
- **Stock:** no public stock-reading API was found (only "mark menu item in/out of stock" for aggregators). Petpooja's inventory module (raw materials, recipes with auto-deduction, wastage, closing stock) exists as a separate product with its own reports.

**Consequence:** item-level sales can be confirmed today only through Petpooja's item-wise sales reports (exports). Whether an API returns item-level lines can be confirmed only by Petpooja. Decision D1 asks the owner to request this from the Petpooja account manager.

## 5. Approaches considered
1. **Report import first, API later (recommended).** HR downloads Petpooja's standard exports (item-wise sales by day and outlet, plus the day-end/sales summary for totals) and uploads them to CafeOS. CafeOS validates, de-duplicates and reconciles them. The importer is written behind a "source adapter", so a Petpooja read API can feed the same tables once access is granted, without changing the analysis. Works now, needs no credentials, uses Petpooja's own definitions. Cost: a person uploads files (a minute a day or once a week), and the exact export columns must be confirmed against real (sanitised) samples.
2. **API only.** Wait for partner API access. Fully automatic, but blocked on Petpooja, possibly paid, and the only known read endpoint is bill-level (no items), which would not meet the item-level requirement.
3. **Direct database access to Petpooja.** Rejected: Petpooja is a hosted service; database access is not offered or appropriate (owner's instruction).
4. **Staff type in sales.** Rejected: duplicate entry (owner's instruction).

Tasks and stock counts have one sensible way: the same pattern as Leave (rows read by the app; changes through database functions that check permission and write history).

## 6. Sales and item analysis

### 6.1 Sources and grain
- **Item daily rows** (the core): per outlet, business date and item: quantity sold, gross amount, item discount, net amount, refunded/cancelled quantity and amount (where the report gives them). Time-of-day analysis needs bill or hour detail; if Petpooja's exports or API give hourly or bill-level item data, an optional **bill line** grain is stored as well (D3).
- **Outlet daily totals** (for reconciliation and targets): per outlet and business date: bill count, gross, discounts, tax, round-off, net sales, refunds, cancelled bills, from Petpooja's day-end/sales summary.
- **Menu items:** a CafeOS list of Petpooja items (Petpooja item id where present, otherwise a normalised name + category), with category, active flag and an optional cost (see 6.5).

### 6.2 Definitions (proposed; owner confirms in D2)
- **Business date:** Petpooja's own date for the bill (day-end date) when the export gives it; otherwise the bill's local date in the organisation's time zone. Outlets open until midnight close on the same date; a cut-off hour (e.g. 04:00) is applied only if Petpooja reports after-midnight bills on the next date.
- **Net sales** (the main figure, used for targets and comparisons): item amounts after item and bill discounts, excluding tax and round-off, excluding cancelled/void bills, minus refunds. Gross, discount, tax and round-off are kept alongside, so other definitions can be shown without re-importing.
- **Refunds:** counted on the date Petpooja records them (as in its reports), shown as a separate line, never silently netted into another day.
- **Quantity sold:** sold minus refunded/cancelled quantity.

### 6.3 Matching
- **Outlets:** each Petpooja restaurant/outlet id (or outlet name in the export) is mapped by HR to a CafeOS outlet in a CafeOS mapping table (`sales_outlet_mappings`). Several Petpooja ids may point to one CafeOS outlet (an outlet renamed or re-registered in Petpooja); one Petpooja id never points to two outlets. An import naming an unmapped outlet stops with "Map this Petpooja outlet first". (Builder-check call: `external_entity_mappings` is strictly one-to-one and needs a connection row.)
- **Items:** matched by Petpooja item id when present; otherwise by exact normalised name + category per organisation. New items are added automatically as "new" for HR to review; renamed items can be merged by HR (history kept). Item identity is organisation-wide; sales are per outlet.
- **Dates:** as 6.2; the time zone is the organisation's (CafeOS has no per-outlet time zone; all outlets are in one zone).

### 6.4 Import, corrections, refunds, duplicates, missing data
- **Import batch** (own table `sales_import_batches`, builder-check call): each upload or API pull is a batch: source (file or API), outlet(s), period, file SHA-256, row counts, who, when, result. The raw file is **not** stored by default: only whitelisted columns are parsed and kept; any customer, phone, address or payment-card column is dropped before anything is saved (D7).
- **No double counting:** rows are keyed by (organisation, outlet, business date, item) for daily rows and (organisation, outlet, Petpooja bill id) for bill rows. Importing the same period again **replaces** that period's rows for that outlet in one transaction (a new version), never adds to them. The same file twice is recognised by its hash and refused as a duplicate.
- **Corrections:** a re-import after Petpooja corrected a bill or a day replaces the period; the previous version stays in history with who imported it and why ("Re-imported after correction"), and the change in totals is shown.
- **Reconciliation:** for each outlet and day, the sum of item rows is compared with Petpooja's day total. Equal (within ₹1 rounding): "Reconciled". Different: "Check" with the difference shown; analysis still shows the data with a warning. Days with no data at all are "Missing" on the calendar, never shown as ₹0.
- **API later:** the same batches, keys and reconciliation, scheduled in the daily job, with retries and errors in `integration_sync_jobs`/`integration_sync_errors`.

### 6.5 Analysis (HR/Super Admin)
- Outlet day and week totals, outlet comparison, actual vs target with percentage, trend.
- Item tables per outlet and period: quantity, net sales, share, change vs previous period; "Top sellers" and "Slow sellers" (lowest quantity among active items with sales in the period, and items with no sales); filters by category.
- When and where: weekday pattern per item and outlet; hour-of-day only if bill-level or hourly data is available (D3).
- Discounts and refunds per item and outlet.
- Margin: only if an item cost exists. Source in order of preference: Petpooja inventory/recipe cost report (if the cafés use it, D4); otherwise an optional HR-entered cost per item with history. Without costs the margin column is hidden and the offer view says so.
- **Offer planning (review only):** pick items, outlets and a period; see recent quantity, net sales, discount history and (with cost) margin at a proposed discount, plus slow periods. HR may save a "planned offer" note with status draft/approved/rejected for the record. CafeOS never creates or changes offers in Petpooja; staff apply approved offers in Petpooja themselves.

### 6.6 Targets
- HR sets a net-sales target per outlet per day, week or month (one level per outlet, D5), with a reason; every change is history (who, when, old, new, reason).

## 7. Stock
- **If Petpooja's inventory module is used** (D4): import its closing stock / consumption / wastage report the same way as sales (batches, hashes, versioned replacement), read-only.
- **Otherwise, a small CafeOS stock count** for agreed items only:
  - stock items: name, unit (kg, g, l, ml, pcs, packs), low-stock threshold per outlet, active flag;
  - an append-only ledger per outlet and item: COUNT (set to counted quantity), RECEIVED, WASTAGE (reason required), ADJUSTMENT (reason required); each line records who, when, reason; the current level is the last count plus later movements;
  - low-stock list per outlet; no purchasing, suppliers or costs.
- Who records counts (D6): HR only, or also employees for their task outlet/home outlet.

## 8. Tasks

### 8.1 Workflow
`ASSIGNED → IN_PROGRESS → SUBMITTED → APPROVED`, or `SUBMITTED → CHANGES_REQUESTED → IN_PROGRESS → SUBMITTED …`; HR may `CANCEL` any open task with a reason. Approved and cancelled are final.
- Assign (HR): owner (an employee of the organisation, picked and shown by their unique employee code, e.g. TTC-002, and name), task outlet (any active outlet, independent of the home outlet), title, description, due date (and optional time), priority (Low, Normal, High, Urgent), required proof (any of: photo, document, written explanation; at least one), and optional **resources** for the employee: reference files (photos, PDFs; same checks and private storage as evidence) and links (https only), added at assignment or later; each addition or removal is history.
- The owner starts it (In progress), adds progress notes, submits with the required proof; overdue tasks are flagged, not blocked.
- HR reviews: **Approve = passed the check**, with a **rating of the work from 1 to 5** (required when approving; 1 Poor, 2 Below expectations, 3 Meets expectations, 4 Good, 5 Excellent) and an optional comment; or Request changes (note required, no rating). The rating is HR's judgement of that one task; the system never averages, ranks or converts ratings (owner addition, 23 Nov). Four-eyes: HR cannot review a task assigned to themselves unless they are the only reviewer (same rule as Leave).
- Staff without a login: tasks cannot be assigned to them (owner revision, 23 Nov); link their account first.

### 8.2 Data
- `tasks`: organisation, task outlet, owner employee, title, description, due, priority, required proof set, status, created by/at, current submission, review fields.
- `task_events` (append-only): every change (assigned, edited, started, note, submitted, approved, changes requested, cancelled, reassigned) with actor, time, from/to status and note. Editing the description, due date, outlet or owner after assignment is an event with the old and new values.
- `task_submissions` (append-only, numbered): text, submitted by/at.
- `task_resources`: files (private storage key, name, type, size, SHA-256) or https links attached by HR, with who added or removed them and when.
- Rating fields on the task: `rating` (1-5, set only with APPROVED), `rating_comment`, rated by and at (the reviewer).
- `task_evidence`: per submission: private storage key, original name, type, size, SHA-256. Photos (JPEG/PNG/WebP/HEIC) and documents (PDF), checked by content, size-limited (5 MB each, at most 3 and 5 MB in total per submission: owner decision, 24 Nov). Files are never public; served only through a route that re-checks permission and organisation. Evidence lives in a new `tasks` storage folder covered by the existing daily file backup. Evidence is kept until the owner approves a retention period (D10); no automatic deletion is built yet.
- Writes go through database functions (like Leave) that take the actor from the session, check permission, lock the task, validate the transition and write the event; the app account only reads these tables.

### 8.3 Notifications (in-app)
Notifications go to a login; every task owner has one (owner revision). Builder-check calls:
- created inside the task functions (database functions, like every other write), never by the app account directly;
- the due-date reminder is created by the daily 10:00 housekeeping job (maintenance mode, every organisation): once on the due date and once the day after if still open, never repeatedly.
- Owner: "New task", "Changes requested", "Task approved", "Task cancelled", reminder on the due date.
- HR (`task:manage` holders): "Task submitted for review".
- A bell with unread count and a notification list (reusing `notifications`); marking as read.

### 8.4 Future salary/incentive review
- Approved tasks, with dates, outlet, priority, reviewer, **HR's rating and comment**, are listed on the employee's HR page and exportable later (Reports milestone). Ratings are shown task by task; no averages, rankings, scores, incentives or salary fields are calculated. Whether the employee sees their rating is D11.

## 9. Roles and visibility (proposed)
New permission keys (in `permission-keys.ts`, `roles.ts`, seed, a migration and the roles test):
| Key | Super Admin | HR Manager | Employee |
|---|---|---|---|
| `sales:read` (all sales and item analysis) | yes | yes | no |
| `sales:import` (upload/pull, map outlets and items, resolve checks) | yes | yes | no |
| `sales:target` (set targets, item costs, planned-offer notes) | yes | yes | no |
| `stock:read` | yes | yes | no (D6) |
| `stock:record` (counts, received, wastage, adjustments) | yes | yes | D6 |
| `task:manage` (assign, edit, review, cancel; see all) | yes | yes | no |
| `self:task` (own tasks: view, start, note, submit) | yes | yes | yes |
- Employees see only their own tasks, submissions and evidence (RLS on the employee link), plus the outlet name.
- **Sales and stock for employees: none by default** (owner's instruction). Optional later (D9): employees see their task/home outlet's daily net-sales total vs target only, no items, no other outlets.
- Integration settings and credentials: Super Admin only (`integration:manage`).

## 10. Privacy and security
- Organisation isolation by RLS on every new table, as in earlier milestones; the app account cannot write sales, stock ledger, task history or evidence tables directly.
- Imports keep only whitelisted, non-personal fields. No customer or card data is parsed or stored. Uploaded export files are deleted after parsing (default) or kept privately for a short time if the owner wants an audit copy (D7).
- Petpooja credentials (if the API is granted): stored only in `.env` / the server's secret store, referenced by name in `integration_connections.secret_reference`; never in the database, logs, audit metadata or screens. Read-only use; the connector has no code path that writes to Petpooja.
- Evidence files: private storage, content-type checks, size limits, random names, authorised download only, included in the daily backup; kept until the owner approves a retention period (D10); no automatic deletion is built.
- Audit: every import, re-import, mapping, target, cost, stock entry, task assignment/change/review recorded with actor and time (module history plus `audit_logs`).

## 11. Testing
- **No production sales in tests.** Fixtures are synthetic files in Petpooja's export layout (column names copied from sanitised samples the owner provides, with every value replaced: fake items, rounded amounts, no bill ids from real bills, no customer columns).
- Importer unit tests: parsing, whitelisting (a customer-phone column present in a fixture must never be stored), duplicate file refused, re-import replaces, reconciliation statuses, missing days, refunds on their own date, unmapped outlet stops the import.
- API adapter (only after access is granted): tested against a local mock that serves the sanitised sample responses; the real Petpooja endpoint is called only on the owner's approval, read-only, with a test outlet or a short date range.
- Database tests on `hr_recruitment_test` as `hr_runtime`: RLS isolation, permissions per role, task workflow transitions, four-eyes, evidence access, append-only history.
- Browser checks on the test site (`npm run dev:testdb`).

## 12. Proposed delivery order (each part designed here, planned and approved separately)
1. **Tasks + notifications** (no external dependency; can start right after approval).
2. **Sales import + outlet totals + targets + reconciliation** (needs sanitised sample exports, D1-D3). Its plan is written after the samples arrive: their grain (daily, hourly or bill-level item rows) decides whether the bill-line table exists and the daily-row key. Part 1 can be planned and built before that.
3. **Item analysis + offer planning** (on top of 2; margin needs D4).
4. **Stock** (Petpooja import or CafeOS stock count, per D4/D6).

## 13. Decisions for the owner
- **D1 Petpooja access:** ask the Petpooja account manager (a) whether a read-only reporting/partner API is available to the cafés, its cost, and whether it returns item-level lines with bill time; (b) for sanitised samples of the item-wise sales report and the day-end/sales summary export. Until then, file import.
- **D2 Sales definitions:** net sales = after discounts, excluding tax and round-off, excluding cancelled bills, minus refunds on the refund date; business date = Petpooja's date. Confirm or change.
- **D3 Time-of-day analysis:** needed? Requires an hourly or bill-level item export/API.
- **D4 Stock and cost source:** do the cafés use Petpooja's inventory module (recipes, closing stock)? If not, CafeOS stock count; item costs entered by HR or left out.
- **D5 Targets:** per outlet per day, week or month (one level), net sales.
- **D6 Stock recording:** HR only, or also employees (for which outlets)?
- **D7 Import files:** delete after parsing (recommended), or keep privately for N days.
- **D8 Staff without a login:** decided by the owner (23 Nov): tasks need a linked login.
- **D9 Employee visibility of sales:** none (default), or own outlet's daily total vs target only.
- **D11 Ratings visible to employees:** proposed yes (rating and comment on their own approved tasks, for transparency); or HR only.
- **D10 Evidence retention:** proposed 24 months after the task closes, then delete the files and keep the record. Not built until approved.

## 14. Left to the builder
Screen layout (following the existing modules; frontend-design for the analysis and task screens), chart types, exact export column mapping after the samples arrive, index choices, notification wording.

## 15. Out of scope (explicit)
Writing to Petpooja in any way; offers, prices or menus in Petpooja; purchasing, suppliers, accounting, recipe costing; payroll, incentive calculation, scoring or salary changes; customer or card data; email/SMS; recurring daily checklists; forecasting or automatic recommendations beyond the listed sorted views.
