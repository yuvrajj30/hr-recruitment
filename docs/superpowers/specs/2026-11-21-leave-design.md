# CafeOS Milestone 3: Leave. Design

Status: draft for the owner's approval (21 Nov 2026).

## Intent and why
Leave at The Trust Coffee is on paper today: staff tell HR, and HR keeps track by hand. That makes it unclear who is off on a given day, lets balances drift (nobody can prove how many days someone has left), and gives payroll nothing reliable.

The owner handed the design to Claude ("decide it as if you owned the cafés"). The aim:
- Anyone can see who is off, when.
- Nobody takes paid leave they don't have.
- Every change to a balance can be explained later: who changed it, when, why.
- The rota and attendance know about leave, so a day on leave is never a "missed shift".

## Goals
1. **Leave types per organisation.** HR edits them. Starting set:
   - Casual Leave (CL): paid, granted yearly up front;
   - Sick Leave (SL): paid, granted yearly up front;
   - Earned Leave (EL): paid, builds up monthly, partly carried over;
   - Comp-off (CO): paid, credited by HR for working a holiday;
   - Unpaid Leave (UL): no balance, always allowed.

   The numbers are settings HR changes, not rules in code.
2. **A holiday calendar** per organisation. A holiday is for all outlets or for one outlet.
3. **Balances kept as a ledger** (one line per change). The balance is the sum of the lines.
4. **Requests.** The employee asks for a date range with an optional half day at either end. Only their working days are counted. HR approves or rejects; rejecting needs a note.
5. **Safeguards:**
   - no request for paid leave beyond what is available (the balance minus pending requests);
   - the balance is checked again at approval;
   - no two active requests of one person overlap;
   - nobody decides their own request, unless they are the organisation's only person with the approve permission (same rule as attendance).
6. **Attendance link:**
   - approving leave cancels that person's planned shifts on full leave days ("On leave");
   - the standard-rota fill skips those days;
   - clocking in on a full leave day is refused;
   - the review page shows "On leave", not "Missed".
7. **Screens:**
   - "My leave" for everyone: balances, a request form, my requests, upcoming holidays;
   - HR: requests waiting, a calendar-style "who is off", per-employee balances with the ledger, leave types, holidays, and adjustments.

## Non-goals (this milestone)
- Payroll calculation or leave encashment. The HR reports milestone will export days worked, paid leave and unpaid leave per month.
- Notifications by email or SMS.
- Attachments (for example medical certificates). A note field only.
- Automatic expiry of comp-offs. HR can expire them by an adjustment.
- Manager-level approval. Approval is HR only, matching the three roles.

## Anti-goals (failure even if it "works")
- Legal or statutory numbers hard-coded. Entitlements differ by state law (Madhya Pradesh Shops & Establishments rules apply to Indore), so HR must confirm and set them.
- A balance that changes without a recorded reason and author.
- Leave that silently leaves a shift on the rota, so the day later shows as missed.
- Staff able to see other people's leave reasons or balances.

## Constraints (from the existing system)
- **Tenancy and identity:** multi-tenant, with PostgreSQL row-level security. The organisation and person always come from the session (`app_org_id()`, `app_user_id()`, `app_my_employee_id()`). Composite foreign keys use `(organization_id, id)`.
- **Roles:** exactly three: SUPER_ADMIN, HR_MANAGER, EMPLOYEE. Permissions are checked by key, never by role name. These keys already exist: `leave:read`, `leave:approve`, `self:leave_apply`, `self:leave_read`. **New:** `leave:manage` (leave types, holidays, adjustments) for SUPER_ADMIN and HR_MANAGER. Adding it means a migration that inserts the permission and its role rows, plus changes to seed.ts, roles.ts and permission-keys.ts. The roles test compares them.
- **Writes:** as with attendance, the app account only READS the ledger and the requests. All writes go through SECURITY DEFINER functions that:
  - check the mode, the permission key and the organisation;
  - lock the employee row (FOR SHARE), then a per-employee advisory lock, then the rows;
  - write the ledger lines themselves.

  Leave types and holidays may be written directly under row-level security, with audit rows.
- **Days and time zone:** dates are local calendar days (DATE columns) in the organisation's time zone (`att_org_timezone`). The leave year is the calendar year (January to December).
- **Migrations:** new migrations only, on the test database first. Real-database release only with the owner's approval and a verified backup. `btree_gist` is installed, so exclusion constraints may use daterange.

## Approaches considered
1. **Ledger (chosen).** Every balance change is an append-only line: GRANT, ACCRUAL, TAKEN, RESTORED, ADJUSTMENT, CARRY_OVER or EXPIRED, with days, reason, author and request. The balance is the sum.
   - *Why:* auditable, the same pattern as the attendance history, and it handles monthly build-up, comp-offs and corrections without special cases.
2. **One editable balance number.** Rejected: no history, so it is exactly the paper problem again.
3. **A configurable policy engine** (probation, formulas, encashment). Rejected: far too heavy for cafés, and HR would never configure it.

The owner handed the choice to Claude. It is Claude's call.

## How it works (decided)

**Leave type settings:**
- code, name, paid (yes/no);
- accrual: NONE, YEARLY or MONTHLY;
- days per year (decimal, steps of 0.5);
- carry-over cap (days moved into the next year; the rest expires);
- whether a note is required;
- active.

Unpaid: no balance check at all. Comp-off: accrual NONE; balance only from HR adjustments.

**Grants:**
- YEARLY types: the full days are credited on 1 January, or pro rata (by remaining months, rounded down to 0.5) when someone joins mid-year.
- MONTHLY types: days per year ÷ 12 are credited on the 1st of each month the person is employed, for the month just started.
- Done by the daily housekeeping job (maintenance mode), idempotent: at most one ACCRUAL line per person, type, year and month, and one GRANT per person, type and year.
- No grants after someone has left.

**Year change:**
- for each type with a carry-over cap: CARRY_OVER = min(the year-end balance, the cap) into the new year;
- an EXPIRED line removes the rest from the old year;
- also done by the daily job, on the first run of the new year.

**Counting days of a request:**
- every date from start to end, inclusive;
- skip holidays (organisation-wide, or at the employee's home outlet);
- skip the person's weekly off days (the days missing from their standard shift's working days; with no standard, no weekly offs);
- a half day at the start or end counts 0.5 when that day counts;
- a request counting 0 days is refused.
- **Counted when:** the DB computes the count when the request is made and stores it. Approval uses the stored number. A holiday added later does not change existing requests; HR can cancel and re-request.

**Availability:**
- available = the ledger balance for the year of the start date, minus the days of that person's PENDING requests of that type;
- a request may not cross a year boundary: it is split into two requests, which the screen does for the user;
- paid types: the request is refused if days > available, and checked again at approval under the lock.

**Request states:**
- PENDING → APPROVED or REJECTED (rejecting needs a note).
- PENDING → WITHDRAWN (by the employee).
- APPROVED → CANCELLED:
  - by the employee before the first leave day;
  - by HR at any time, with a reason.

  Cancelling writes RESTORED for the days not yet taken. If the leave is partly in the past, the leave days already passed stay taken.
- TAKEN is written once, at approval, for the full days.

**Back-dated requests:** allowed up to 31 days back, for illness reported afterwards. Up to 365 days ahead.

**Overlaps:** an exclusion constraint on (employee, daterange) for PENDING and APPROVED requests.

**Attendance and rota at approval** (in the same transaction):
- planned shifts of that person whose standard day, or local start day, is a full leave day are cancelled ("On leave"), as a system-style change recorded in shift history;
- `att_sync_standard_shifts` skips full leave days;
- `app_clock_in` refuses on a full leave day ("You are on leave today; ask HR if that is wrong");
- half days do not cancel shifts: HR adjusts the shift if needed;
- the day review shows approved leave per person ("On leave: CL"), and a shift cancelled for leave is not "missed".

**Leaving the company:** marking someone as left cancels their APPROVED leave after the last working day and restores those days. PENDING requests after that day are withdrawn. No further grants.

**HR adjustments:** ADJUSTMENT lines with a required reason, positive or negative (for example comp-off credit, or a correction). They are refused if they would make a paid balance negative.

**Who sees what:**
- an employee sees their own balances, ledger and requests;
- HR (`leave:read`) sees the organisation's;
- the "who is off" calendar shows names and leave type, never the reason;
- holidays and leave types are readable by every signed-in member of the organisation.

**Audit:** the ledger and the request decisions are the authoritative trail (append-only, written by the database). HR actions also get audit_log rows.

## Decisions added after the builder check (Claude's calls, owner to confirm)
1. **Staff without a login.** HR can record leave on behalf of any employee (`leave:approve`): a paper request is entered directly as APPROVED, with `requested_by` = the HR person, the employee id taken from the form and checked against the organisation, and the same day count and balance checks. Employees request only for themselves (the employee comes from the session, never from the form). HR recording leave for themselves goes through the normal request path, with the four-eyes rule.
2. **Weekly offs and pattern changes.**
   - With no standard shift pattern, every non-holiday day counts. The request screen says so ("No working days set: every day counts. Ask HR to set your standard").
   - The count is computed at request time and recomputed at approval. The approval value is final: it is what is TAKEN. A later pattern or outlet change does not touch approved leave.
3. **The only-approver exception.** Same rule as attendance: self-decision is allowed only if no other ACTIVE member with an ACTIVE user in the organisation holds `leave:approve` (any role). Such a decision is marked `self_decided` on the request and shown to HR.
4. **Joiners and leavers.**
   - A month counts if the person is employed on its 15th: joined on or before the 15th, and not left before the 15th.
   - MONTHLY: one accrual per counting month.
   - YEARLY: pro rata by counting months left in the year, at joining.
   - Leaving: grants stop, nothing already granted is clawed back (payroll settles it).
5. **Starting leave types.** Seeded for each organisation with 0 days per year and no carry-over, marked "not configured". The HR screens and "My leave" show a clear warning until HR sets the numbers. No statutory numbers are guessed. Unpaid works from day one. Claude will give suggested starting values for HR to confirm separately.
6. **Year end and back-dating.**
   - Requests never cross 31 Dec / 1 Jan; the screen splits them.
   - New-year grants are written on 1 January.
   - Carry-over and expiry of the old year run on 1 February, after the 31-day back-dating window has closed. So a January request for December leave still uses December's year and balance, and the year is closed only once nothing can still change it.
7. **Cancelling approved leave.**
   - "Before the first leave day" means before 00:00 on the start date, in the organisation's time zone; after that, only HR can cancel.
   - Shifts cancelled at approval are cancelled as a system change (no person) with reason "On leave", so the standard-rota fill refills standard days when the leave is cancelled.
   - Hand-planned shifts are not restored: HR re-adds them, and the cancel screen lists them.
8. **Outlet holidays.**
   - The employee's home outlet at the time of the request (and again at approval) decides outlet-specific holidays.
   - With no outlet, only organisation-wide holidays apply.

## Left to the builder
- Table and column names, indexes, and how the types are seeded per organisation (e.g. created on first use or by the migration for existing organisations).
- Exact screen layout (follow the existing Attendance and Employees screens; use the frontend-design skill for the new "My leave" and calendar screens).
- How the "who is off" calendar is drawn (a week or month grid).
- Error message wording, test structure, and whether the day count is a SQL function shared by request and approval.
