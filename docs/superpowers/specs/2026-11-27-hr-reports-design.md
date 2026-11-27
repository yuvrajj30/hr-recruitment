# HR Reports (CafeOS Milestone 5): design

Owner said "just dive in" on 27 Nov 2026 to the overview + CSV export proposal; the calls below are Claude's.

## Intent
- **What:** HR Managers and Super Admins get reports built from the data CafeOS already holds: headcount, attendance, leave, hiring and tasks.
- **Purpose:** see how the cafés and their people are doing, and take the numbers away as CSV.
- **Not a payroll tool:** CafeOS holds no pay data. The attendance report gives hours, not money.

## Goals
- `/reports` overview, plus one page per report (`/reports/headcount`, `attendance`, `leave`, `hiring`, `tasks`).
- Each report has a period and, where it applies, an outlet filter.
- Each report has a CSV download.
- Gated by the existing permission `report:read`:
  - HR Managers and Super Admins have it; Employees do not.
  - The menu item "Reports and Analytics" becomes available.

## Non-goals
- No charts library, saved or scheduled reports, or email delivery.
- No Petpooja or sales figures.
- No payroll amounts.

## Anti-goals
- **No other organisation's data.**
- **No candidate personal data:** the hiring report gives counts per job and stage only.
- **No change to task-rating visibility (D11):** ratings appear only in the HR report.

## Approach
Read-only services in `src/lib/reports/` read through `staffDb` under the existing row-level security, so there is **no migration**.
- **Two checks:**
  - the app requires `report:read`;
  - PostgreSQL only shows an organisation's HR its own organisation's rows (an Employee sees only their own, so a missed app check still cannot leak colleagues' data).
- **Calculations:** the figures are worked out in pure functions in `src/lib/reports/rules.ts`, with unit tests. These reuse the attendance rules (`workedMinutes`, `recordFlags`, `minutesLate`, `isMissedShift`) and the leave balance calculation, so the numbers match the existing screens.
- **Alternatives rejected:**
  - SQL views or materialised tables: they need a migration and new RLS, and the data volume (a few cafés) doesn't need them.
  - Client-side charts: they put data in client bundles.

## Report definitions
Periods are local days in the organisation's time zone, inclusive.
- **Default period:** the 1st of the current month to today.
- **Maximum:** 366 days.

**Headcount** (as of the period's last day)
- Active employees, by outlet, department and employment type.
- Joiners: `joinedOn` in the period. Leavers: `exitedOn` in the period.
- Turnover % = leavers / average of the headcount at the start and at the end.

**Attendance**, per employee. A shift or record belongs to the local day it starts on.
- Planned shifts: status `PLANNED`.
- Attended: the shift has a linked non-void record.
- Missed: `isMissedShift`, minus shifts on a day covered by one of the person's approved leave requests, which count as "on leave" (the same rule as the attendance day screen). The app account may not read `leave_request_days`, by design.
- Late arrivals: count and total minutes. Early leaves.
- Missing clock-outs.
- Unplanned records: a record with no shift.
- Worked hours: the sum of `workedMinutes`.
- Voided records are ignored.
- Outlet filter: by the shift's or record's outlet.

**Leave** (calendar year)
- Per employee and leave type: credited, taken, balance and pending, using the same calculation as the leave screens.
- Requests in the period by status.
- Days of approved requests that start in the period (charged days of the request).

**Hiring**
- Over the period, per job: applications received (`appliedAt` in the period), moved to Interview scheduled, Selected, Offer accepted, Joined and Rejected. These come from the status history `toStage` in the period.
- The current pipeline (all applications by current stage) for jobs that are not archived.
- Counts only; no candidate names.

**Tasks** (`dueOn` in the period, cancelled tasks excluded)
- Per employee:
  - assigned; approved;
  - approved on time: submitted by the deadline (`dueTime`, or else the end of the due day, in the organisation's time zone);
  - open and overdue; changes requested (the count of `CHANGES_REQUESTED` events);
  - average rating.

## CSV
- **Route:** `GET /api/reports/[report]?from&to&outlet&year`. It requires a session and `report:read`.
- **Format:** UTF-8 with BOM (for Excel) and CRLF line endings.
- **Formula-injection protection:** a cell starting with `= + - @`, tab or carriage return gets a leading `'`.
- **Headers:** `no-store`, sent as an attachment.
- **Audit:** every export writes `report.exported` (the report name and the filters, never the data).

## Limits
- Each report refuses more than 20,000 source rows with "narrow the period", rather than truncating silently.
- The first version has no pagination.

## Tests
- Unit tests for the period parser, the summaries and CSV escaping.
- DB tests on the test DB:
  - an HR user sees only their own organisation;
  - an Employee is refused, and even with the app check skipped, their database view holds only their own rows;
  - the numbers on the seeded data are correct;
  - an export writes its audit row.
- The navigation test is updated.

## Left to the builder
Layout and wording on the pages, using the existing UI components.
