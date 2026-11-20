// Candidate profiles belong to ONE organisation (migrations 20261118020000_candidate_profiles_per_organization and
// 20261118020200_candidate_document_links_same_organization), against the DISPOSABLE test database only. Two
// organisations receive applications from the SAME email address. Checked directly in PostgreSQL as the app's
// restricted account (row-level security applies), the way a bug or a forged request would try it: neither
// organisation can read or change the other's profile details, education/experience/skills, notes, documents,
// interview feedback or removal state, with any role; every refusal is shown next to the same statement working
// (or being refused for everyone) on the organisation's own rows; the owner account cannot link across
// organisations either (each key is named); and repeat applications within one organisation still find that
// organisation's single profile of the person.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import { type ApplicationInput, parseApplicationInput } from "@/lib/recruitment/application-input";
import { type AppDeps, applyPublicly, createApplicationManually, moveApplicationStage, type ResumeUpload } from "@/lib/recruitment/applications";
import { getCandidate, listCandidates } from "@/lib/recruitment/candidates";
import { removeCandidate } from "@/lib/recruitment/privacy";
import type { FileStorage } from "@/lib/recruitment/storage";
import { realRoleIds } from "./roles-helper";
import { giveSession, pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "tenant-isolation.example.test";
const AGE_OK = { ageConfirmed: true } as const;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const resume = (): ResumeUpload => ({ bytes: PDF, kind: { extension: "pdf", mimeType: "application/pdf" }, safeName: "cv.pdf" });
const CHILD_TABLES = ["candidate_educations", "candidate_experiences", "candidate_skills"] as const;

function person(overrides: Record<string, string>): ApplicationInput {
  const r = parseApplicationInput({ phone: "9812345678", city: "Indore", ...overrides });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

type K = "a" | "b";
type Who = "hr" | "sa" | "emp" | "public";

describe.skipIf(!enabled)("candidate data is isolated per organisation (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client; // owner, for fixtures and checks
  let rt: Client; // the app's account, for direct attempts
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const email = `same.person-${rnd()}@${DOMAIN}`;
  // ONE file store for both organisations, as in production (one disk store): removing one organisation's files
  // must not touch the other's.
  const files = new Map<string, Uint8Array>();
  const storage: FileStorage = { put: async (key, b) => void files.set(key, b), get: async (key) => files.get(key) ?? null, remove: async (key) => void files.delete(key) };
  // Filled in beforeAll.
  const f: Record<string, string> = {};
  const w: Record<K, { org: string; job: string; job2: string; sa: AuthContext; hr: AuthContext; user: Record<Exclude<Who, "public">, string>; deps: AppDeps }> = {} as never;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    const role = await realRoleIds(owner);
    for (const k of ["a", "b"] as const) {
      const mk = async (name: string) => {
        const u = await owner.user.create({ data: { email: `${name}-${k}-${rnd()}@${DOMAIN}`, name: `${name} ${k.toUpperCase()}` } });
        userIds.push(u.id);
        return u;
      };
      const [saU, hrU, empU] = [await mk("sa"), await mk("hr"), await mk("emp")];
      const org = await owner.organization.create({ data: { slug: `ti-${k}-${rnd()}${rnd()}`, name: `Isolation ${k.toUpperCase()}`, ownerUserId: saU.id, timezone: "Asia/Kolkata" } });
      orgIds.push(org.id);
      for (const [u, key] of [[saU, "SUPER_ADMIN"], [hrU, "HR_MANAGER"], [empU, "EMPLOYEE"]] as const) {
        await owner.organizationMember.create({ data: { organizationId: org.id, userId: u.id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[key] }] } } });
      }
      const job = (title: string) =>
        owner.jobOpening.create({ data: { organizationId: org.id, slug: `job-${rnd()}`, title, description: "Synthetic job.", employmentType: "FULL_TIME", workMode: "ON_SITE", createdById: saU.id, status: "PUBLISHED", publishedAt: new Date() } });
      const [j1, j2] = [await job("Barista"), await job("Cashier")];
      const deps: AppDeps = { db, now: new Date(), writeAudit: async () => undefined, client: { ipAddress: null, userAgent: null }, storage };
      const ctx = (u: { id: string; email: string; name: string }, key: RoleKey): AuthContext => ({
        sessionId: "00000000-0000-0000-0000-000000000000",
        user: { id: u.id, email: u.email, name: u.name, isPlatformAdmin: false },
        organization: { id: org.id, name: org.name, slug: org.slug },
        memberId: null, expiresAt: new Date(), absoluteExpiresAt: new Date(), roleKeys: [key], permissions: new Set(ROLE_PERMISSIONS[key]),
      });
      w[k] = {
        org: org.id, job: j1.id, job2: j2.id, deps,
        sa: await giveSession(owner, ctx(saU, "SUPER_ADMIN")), hr: await giveSession(owner, ctx(hrU, "HR_MANAGER")),
        user: { sa: saU.id, hr: hrU.id, emp: empU.id },
      };
    }
    // The same person applies to both organisations, telling each something different, with education,
    // experience and skills in BOTH (so every "none of theirs" below has rows behind it).
    const slugOf = async (k: K, job: string) => ({
      organizationSlug: (await owner.organization.findUniqueOrThrow({ where: { id: w[k].org } })).slug,
      jobSlug: (await owner.jobOpening.findUniqueOrThrow({ where: { id: job } })).slug,
    });
    const inA = await applyPublicly(w.a.deps, await slugOf("a", w.a.job),
      person({ email, fullName: "Asha told A", institution: "DAVV", degree: "BBA", experienceCompany: "Cafe A", experienceTitle: "Barista", skills: "espresso, latte art" }), resume(), AGE_OK);
    const inB = await applyPublicly(w.b.deps, await slugOf("b", w.b.job),
      person({ email, fullName: "Asha told B", city: "Bhopal", institution: "Barkatullah", experienceCompany: "Shop B", experienceTitle: "Cashier", skills: "cashier" }), resume(), AGE_OK);
    f.appA = inA.id;
    f.appB = inB.id;
    f.knownInB = String(inB.candidateWasKnown);
    for (const k of ["a", "b"] as const) {
      const app = await owner.application.findUniqueOrThrow({ where: { id: k === "a" ? inA.id : inB.id }, include: { organizationCandidate: true } });
      f[`oc_${k}`] = app.organizationCandidateId;
      f[`profile_${k}`] = app.organizationCandidate.candidateId;
      const doc = await owner.candidateDocument.findFirstOrThrow({ where: { applicationId: app.id } });
      f[`doc_${k}`] = doc.id;
      f[`key_${k}`] = doc.storageKey;
    }
    // HR notes on each organisation's record, and a completed interview with submitted feedback in A.
    await raw.query(`UPDATE organization_candidates SET notes = 'A private note', tags = '{a-tag}' WHERE id = $1`, [f.oc_a]);
    await raw.query(`UPDATE organization_candidates SET notes = 'B private note', tags = '{b-tag}' WHERE id = $1`, [f.oc_b]);
    const iv = (await raw.query(`INSERT INTO interviews (id, organization_id, application_id, round_number, type, status, scheduled_start, scheduled_end, location, created_by_id, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 1, 'IN_PERSON', 'COMPLETED', now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'Outlet A', $3, now()) RETURNING id`, [w.a.org, f.appA, w.a.user.hr])).rows[0].id;
    const seat = (await raw.query(`INSERT INTO interview_participants (id, organization_id, interview_id, interviewer_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [w.a.org, iv, w.a.user.hr])).rows[0].id;
    f.feedbackA = (await raw.query(`INSERT INTO interview_feedback (id, organization_id, participant_id, interviewer_id, overall_rating, recommendation, strengths, submitted_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 4, 'RECOMMEND', 'Feedback written in A', now(), now()) RETURNING id`, [w.a.org, seat, w.a.user.hr])).rows[0].id;
  }, 90_000);

  afterAll(async () => {
    if (owner && orgIds.length) {
      await owner.candidateDocument.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.application.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organizationCandidate.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.candidateProfile.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.jobOpening.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds);
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await db?.$disconnect();
    await raw?.end();
    await rt?.end();
  });

  // A direct attempt as the app's account (hr_runtime, row-level security applies), signed in as `who` of
  // organisation `k` through a real session token (or the public careers mode of `k`), in a rolled-back transaction.
  async function as(k: K, who: Who, sql: string, params: unknown[] = []) {
    await rt.query("BEGIN");
    try {
      if (who === "public") {
        await rt.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [w[k].org]);
      } else {
        const token = await pgSessionToken(raw, w[k].user[who], w[k].org);
        await rt.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [token]);
      }
      const r = await rt.query(sql, params);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0, error: undefined as string | undefined };
    } catch (e) {
      return { rows: [] as Record<string, unknown>[], rowCount: 0, error: (e as Error).message };
    } finally {
      await rt.query("ROLLBACK");
    }
  }
  const asHr = (k: K, sql: string, params: unknown[] = []) => as(k, "hr", sql, params);
  const other = (k: K): K => (k === "a" ? "b" : "a");
  const count = async (k: K, who: Who, table: string, col: string, id: string) => {
    const r = await as(k, who, `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id]);
    expect(r.error, `${who} of ${k} reading ${table}`).toBeUndefined();
    return r.rows[0]?.n;
  };
  // As the owner (no row-level security), inside a rolled-back transaction: the database's own keys decide.
  async function asOwner(sql: string, params: unknown[] = []) {
    await raw.query("BEGIN");
    try {
      await (params.length ? raw.query(sql, params) : raw.query(sql));
      return "allowed";
    } catch (e) {
      return (e as Error).message;
    } finally {
      await raw.query("ROLLBACK");
    }
  }

  it("gives the same email two separate profiles, each holding only what that organisation was told", async () => {
    expect(f.profile_a).not.toBe(f.profile_b);
    expect(f.knownInB).toBe("false"); // B is not told that the person applied somewhere else
    const rows = (await raw.query(`SELECT organization_id, full_name, city FROM candidate_profiles WHERE email = $1 ORDER BY full_name`, [email])).rows;
    expect(rows).toEqual([
      { organization_id: w.a.org, full_name: "Asha told A", city: "Indore" },
      { organization_id: w.b.org, full_name: "Asha told B", city: "Bhopal" },
    ]);
    const list = async (sql: string, p: string) => (await raw.query(sql, [p])).rows.map((r) => Object.values(r).join("/"));
    expect(await list(`SELECT name FROM candidate_skills WHERE candidate_id = $1 ORDER BY name`, f.profile_a)).toEqual(["espresso", "latte art"]);
    expect(await list(`SELECT name FROM candidate_skills WHERE candidate_id = $1 ORDER BY name`, f.profile_b)).toEqual(["cashier"]);
    expect(await list(`SELECT institution FROM candidate_educations WHERE candidate_id = $1`, f.profile_a)).toEqual(["DAVV"]);
    expect(await list(`SELECT institution FROM candidate_educations WHERE candidate_id = $1`, f.profile_b)).toEqual(["Barkatullah"]);
    expect(await list(`SELECT company FROM candidate_experiences WHERE candidate_id = $1`, f.profile_a)).toEqual(["Cafe A"]);
    expect(await list(`SELECT company FROM candidate_experiences WHERE candidate_id = $1`, f.profile_b)).toEqual(["Shop B"]);
  });

  it("lets HR and Super Admins read only their own organisation's profile, education, experience and skills", async () => {
    for (const k of ["a", "b"] as const) {
      for (const who of ["hr", "sa"] as const) {
        const seen = await as(k, who, `SELECT id FROM candidate_profiles WHERE email = $1`, [email]);
        expect(seen.rows.map((r) => r.id), `${who} of ${k}`).toEqual([f[`profile_${k}`]]);
        for (const t of CHILD_TABLES) {
          expect(await count(k, who, t, "candidate_id", f[`profile_${k}`]!), `${who} of ${k}: own ${t}`).toBeGreaterThan(0);
          expect(await count(k, who, t, "candidate_id", f[`profile_${other(k)}`]!), `${who} of ${k}: other's ${t}`).toBe(0);
        }
      }
      // And through the app: the other organisation's candidate does not exist.
      await expect(getCandidate(db, w[k].hr, f[`oc_${other(k)}`]!)).rejects.toMatchObject({ code: "not_found" });
      expect((await listCandidates(db, w[k].hr, {})).items.map((c) => c.email)).toEqual([email]);
    }
  });

  it("lets Employees and the public careers pages read no candidate data at all, not even their own organisation's", async () => {
    for (const k of ["a", "b"] as const) {
      for (const who of ["emp", "public"] as const) {
        for (const p of [f.profile_a!, f.profile_b!]) {
          expect(await count(k, who, "candidate_profiles", "id", p), `${who} of ${k}: profile`).toBe(0);
          for (const t of CHILD_TABLES) expect(await count(k, who, t, "candidate_id", p), `${who} of ${k}: ${t}`).toBe(0);
          expect(await count(k, who, "candidate_documents", "candidate_id", p), `${who} of ${k}: documents`).toBe(0);
        }
        expect(await count(k, who, "organization_candidates", "id", f[`oc_${k}`]!), `${who} of ${k}: own record`).toBe(0);
      }
    }
  });

  it("lets neither organisation change the other's notes or tags, while its own record can be changed", async () => {
    for (const k of ["a", "b"] as const) {
      const update = (id: string) => asHr(k, `UPDATE organization_candidates SET notes = 'changed', tags = '{x}' WHERE id = $1`, [id]);
      const own = await update(f[`oc_${k}`]!);
      expect(own.error).toBeUndefined();
      expect(own.rowCount, "own record (control)").toBe(1);
      const theirs = await update(f[`oc_${other(k)}`]!);
      expect(theirs.error).toBeUndefined();
      expect(theirs.rowCount, "other organisation's record").toBe(0);
      expect((await asHr(k, `SELECT notes FROM organization_candidates WHERE id = $1`, [f[`oc_${other(k)}`]])).rows).toEqual([]);
    }
    const intact = (await raw.query(`SELECT cp.full_name, oc.notes, oc.tags FROM organization_candidates oc JOIN candidate_profiles cp ON cp.id = oc.candidate_id WHERE oc.id = ANY($1) ORDER BY cp.full_name`, [[f.oc_a, f.oc_b]])).rows;
    expect(intact).toEqual([
      { full_name: "Asha told A", notes: "A private note", tags: ["a-tag"] },
      { full_name: "Asha told B", notes: "B private note", tags: ["b-tag"] },
    ]);
  });

  it("allows no direct writes to profiles, education, experience or skills for anyone (own organisation included)", async () => {
    // Profiles are created only through the database functions; the app account cannot change or delete any,
    // so the other organisation's are as safe as one's own.
    for (const k of ["a", "b"] as const) {
      for (const p of [f[`profile_${k}`]!, f[`profile_${other(k)}`]!]) {
        for (const sql of [`UPDATE candidate_profiles SET full_name = 'hijacked' WHERE id = $1`, `DELETE FROM candidate_profiles WHERE id = $1`]) {
          const r = await asHr(k, sql, [p]);
          expect(r.error).toBeUndefined();
          expect(r.rowCount).toBe(0);
        }
        for (const t of CHILD_TABLES) {
          const r = await asHr(k, `UPDATE ${t} SET candidate_id = candidate_id WHERE candidate_id = $1`, [p]);
          expect(r.error).toBeUndefined();
          expect(r.rowCount, `${k} updating ${t}`).toBe(0);
        }
        for (const org of [w[k].org, w[other(k)].org]) {
          const add = await asHr(k, `INSERT INTO candidate_skills (id, candidate_id, organization_id, name) VALUES (gen_random_uuid(), $1, $2, 'fake')`, [p, org]);
          expect(add.error).toMatch(/new row violates row-level security policy for table "candidate_skills"/);
        }
      }
    }
    expect((await raw.query(`SELECT full_name FROM candidate_profiles WHERE id = ANY($1) ORDER BY full_name`, [[f.profile_a, f.profile_b]])).rows.map((r) => r.full_name)).toEqual(["Asha told A", "Asha told B"]);
  });

  it("lets neither organisation read, change or delete the other's documents, while its own can be changed", async () => {
    for (const k of ["a", "b"] as const) {
      const mine = f[`doc_${k}`]!;
      const theirs = f[`doc_${other(k)}`]!;
      expect(await count(k, "hr", "candidate_documents", "id", mine)).toBe(1);
      expect(await count(k, "hr", "candidate_documents", "id", theirs)).toBe(0);
      for (const sql of [`UPDATE candidate_documents SET original_name = 'x' WHERE id = $1`, `DELETE FROM candidate_documents WHERE id = $1`]) {
        const own = await asHr(k, sql, [mine]);
        expect(own.error).toBeUndefined();
        expect(own.rowCount, `own document (control): ${sql}`).toBe(1);
        const other_ = await asHr(k, sql, [theirs]);
        expect(other_.error).toBeUndefined();
        expect(other_.rowCount, `other organisation's document: ${sql}`).toBe(0);
      }
      // A document of MY organisation pointing at the OTHER organisation's profile: the two-column key refuses it.
      const forged = await asHr(k, `INSERT INTO candidate_documents (id, candidate_id, organization_id, kind, original_name, storage_key, mime_type, size_bytes, sha256)
        VALUES (gen_random_uuid(), $1, $2, 'RESUME', 'x.pdf', $3, 'application/pdf', 1, 'x')`, [f[`profile_${other(k)}`], w[k].org, `forged/${rnd()}`]);
      expect(forged.error).toMatch(/candidate_documents_organization_id_candidate_id_fkey/);
    }
  });

  it("lets the other organisation see or change none of the interview feedback", async () => {
    for (const who of ["hr", "sa"] as const) {
      expect(await count("b", who, "interview_feedback", "id", f.feedbackA!)).toBe(0);
      expect(await count("a", who, "interview_feedback", "id", f.feedbackA!)).toBe(1);
    }
    const r = await asHr("b", `UPDATE interview_feedback SET strengths = 'x' WHERE id = $1`, [f.feedbackA]);
    expect(r.error).toBeUndefined();
    expect(r.rowCount).toBe(0);
    expect((await raw.query(`SELECT strengths FROM interview_feedback WHERE id = $1`, [f.feedbackA])).rows[0].strengths).toBe("Feedback written in A");
  });

  it("cannot link anything of one organisation to another organisation's profile or files, not even as the owner account", async () => {
    // A profile of A that no record uses yet: linking it to B's record can only fail on the two-column key.
    const fresh = `INSERT INTO candidate_profiles (id, organization_id, email, full_name, updated_at) VALUES ('00000000-0000-4000-8000-00000000f00d', $1, 'fresh-${rnd()}@${DOMAIN}', 'Fresh', now());`;
    const freshThen = (sql: string) => `${fresh} ${sql}`;
    // Multi-statement text cannot take parameters: the (generated, trusted) organisation ids go in literally.
    const run = (sql: string, params: string[]) => asOwner(sql.replaceAll("$1", `'${params[0]}'`).replaceAll("$2", `'${params[1]}'`));
    expect(await run(freshThen(`INSERT INTO organization_candidates (id, organization_id, candidate_id, updated_at) VALUES (gen_random_uuid(), $2, '00000000-0000-4000-8000-00000000f00d', now())`), [w.a.org, w.b.org]))
      .toMatch(/organization_candidates_organization_id_candidate_id_fkey/);
    expect(await run(freshThen(`INSERT INTO organization_candidates (id, organization_id, candidate_id, updated_at) VALUES (gen_random_uuid(), $1, '00000000-0000-4000-8000-00000000f00d', now())`), [w.a.org, w.b.org]))
      .toBe("allowed"); // control: the same link within A
    // A profile already used by a record cannot get a second one (one profile, one organisation record).
    expect(await asOwner(`INSERT INTO organization_candidates (id, organization_id, candidate_id, updated_at) VALUES (gen_random_uuid(), $1, $2, now())`, [w.a.org, f.profile_a]))
      .toMatch(/duplicate key value violates unique constraint "organization_candidates_(organization_id_)?candidate_id_key"/);
    // Education, experience, skills and documents: B's organisation on A's profile.
    const children: Record<string, string> = {
      candidate_educations: `INSERT INTO candidate_educations (id, candidate_id, organization_id, institution) VALUES (gen_random_uuid(), $1, $2, 'Fake')`,
      candidate_experiences: `INSERT INTO candidate_experiences (id, candidate_id, organization_id, company, title) VALUES (gen_random_uuid(), $1, $2, 'Fake', 'Fake')`,
      candidate_skills: `INSERT INTO candidate_skills (id, candidate_id, organization_id, name) VALUES (gen_random_uuid(), $1, $2, 'fake')`,
      candidate_documents: `INSERT INTO candidate_documents (id, candidate_id, organization_id, kind, original_name, storage_key, mime_type, size_bytes, sha256) VALUES (gen_random_uuid(), $1, $2, 'RESUME', 'x.pdf', 'forged/${rnd()}', 'application/pdf', 1, 'x')`,
    };
    for (const [t, sql] of Object.entries(children)) {
      expect(await asOwner(sql, [f.profile_a, w.b.org]), t).toMatch(new RegExp(`${t}_organization_id_candidate_id_fkey`));
      expect(await asOwner(sql, [f.profile_a, w.a.org]), `${t} (control)`).toBe("allowed");
    }
    // An offer letter of A that is B's file; a sign-in link joining A's profile with B's application.
    const offer = `INSERT INTO offers (id, organization_id, application_id, designation, compensation_amount, created_by_id, updated_at, offer_letter_id) VALUES (gen_random_uuid(), $1, $2, 'Barista', 1, $3, now(), $4)`;
    expect(await asOwner(offer, [w.a.org, f.appA, w.a.user.sa, f.doc_b])).toMatch(/offers_organization_id_offer_letter_id_fkey/);
    expect(await asOwner(offer, [w.a.org, f.appA, w.a.user.sa, f.doc_a]), "offer (control)").toBe("allowed");
    const token = `INSERT INTO candidate_login_tokens (id, email, purpose, token_hash, expires_at, organization_id, candidate_id, application_id) VALUES (gen_random_uuid(), 'x@${DOMAIN}', (enum_range(NULL::"LoginTokenPurpose"))[1], $1, now(), $2, $3, $4)`;
    expect(await asOwner(token, [rnd(), w.a.org, f.profile_a, f.appB])).toMatch(/candidate_login_tokens_organization_id_application_id_fkey/);
    expect(await asOwner(token, [rnd(), w.a.org, f.profile_b, f.appA])).toMatch(/candidate_login_tokens_organization_id_candidate_id_fkey/);
    expect(await asOwner(token, [rnd(), null, f.profile_a, null])).toMatch(/candidate_login_tokens_link_needs_org/);
    expect(await asOwner(token, [rnd(), w.a.org, f.profile_a, f.appA]), "sign-in link (control)").toBe("allowed");
  });

  it("keeps a document and its organisation when its application is deleted (only the application link is cleared)", async () => {
    await raw.query("BEGIN");
    try {
      const app = (await raw.query(`INSERT INTO applications (id, organization_id, reference_number, organization_candidate_id, job_id, stage, stage_changed_at, consent_accepted_at, privacy_notice_version, age_confirmed_at, applied_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'APPLIED', now(), now(), 'test', now(), now(), now()) RETURNING id`, [w.a.org, `TI-${rnd()}`, f.oc_a, w.a.job2])).rows[0].id;
      const doc = (await raw.query(`INSERT INTO candidate_documents (id, candidate_id, organization_id, application_id, kind, original_name, storage_key, mime_type, size_bytes, sha256)
        VALUES (gen_random_uuid(), $1, $2, $3, 'RESUME', 'x.pdf', $4, 'application/pdf', 1, 'x') RETURNING id`, [f.profile_a, w.a.org, app, `ti/${rnd()}`])).rows[0].id;
      await raw.query(`DELETE FROM applications WHERE id = $1`, [app]);
      expect((await raw.query(`SELECT organization_id, application_id FROM candidate_documents WHERE id = $1`, [doc])).rows).toEqual([{ organization_id: w.a.org, application_id: null }]);
    } finally {
      await raw.query("ROLLBACK");
    }
  });

  it("keeps one profile per person within an organisation: repeat applications and HR entries find it", async () => {
    const slug = (await owner.organization.findUniqueOrThrow({ where: { id: w.a.org } })).slug;
    const job2 = (await owner.jobOpening.findUniqueOrThrow({ where: { id: w.a.job2 } })).slug;
    // Same email with capitals and spaces, different name: the same profile (not rewritten), a second application.
    const again = await applyPublicly(w.a.deps, { organizationSlug: slug, jobSlug: job2 }, person({ email: `  ${email.toUpperCase()} `, fullName: "Someone Else" }), resume(), AGE_OK);
    expect(again.candidateWasKnown).toBe(true);
    const oc = (await owner.application.findUniqueOrThrow({ where: { id: again.id } })).organizationCandidateId;
    expect(oc).toBe(f.oc_a);
    expect((await raw.query(`SELECT count(*)::int AS n FROM candidate_profiles WHERE organization_id = $1 AND email = $2`, [w.a.org, email])).rows[0].n).toBe(1);
    expect((await raw.query(`SELECT full_name FROM candidate_profiles WHERE id = $1`, [f.profile_a])).rows[0].full_name).toBe("Asha told A");
    // HR entering the person by hand in B finds B's profile, and only B's.
    const viaHr = await asHr("b", `SELECT * FROM app_find_or_create_candidate_profile($1, 'Typed by HR', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [email]);
    expect(viaHr.rows).toEqual([{ id: f.profile_b, created: false }]);
    const manual = await createApplicationManually(w.b.deps, w.b.hr, w.b.job2, person({ email, fullName: "Typed by HR" }), null, AGE_OK);
    expect((await owner.application.findUniqueOrThrow({ where: { id: manual.id } })).organizationCandidateId).toBe(f.oc_b);
    // The database itself refuses a second profile with the same (normalised) email in one organisation.
    const dup = await asOwner(`INSERT INTO candidate_profiles (id, organization_id, email, full_name, updated_at) VALUES (gen_random_uuid(), $1, $2, 'Dup', now())`, [w.a.org, email]);
    expect(dup).toMatch(/candidate_profiles_organization_id_email_key/);
    const notNormal = await asOwner(`INSERT INTO candidate_profiles (id, organization_id, email, full_name, updated_at) VALUES (gen_random_uuid(), $1, $2, 'Dup', now())`, [w.a.org, ` ${email.toUpperCase()}`]);
    expect(notNormal).toMatch(/candidate_profiles_email_normalised/);
  });

  it("removing the person in one organisation leaves the other's profile, files and removal state untouched", async () => {
    // B cannot remove A's candidate, nor see whether A removed it.
    const tryB = await asHr("b", `SELECT * FROM app_remove_candidate($1, now())`, [f.oc_a]);
    expect(tryB.error).toMatch(/candidate_not_found/);
    // A closes all of the person's applications and removes them.
    for (const app of (await owner.application.findMany({ where: { organizationCandidateId: f.oc_a } })).map((x) => x.id)) {
      await moveApplicationStage(w.a.deps, w.a.hr, app, "REJECTED", "Not available on weekends.");
    }
    const bState = async () => ({
      profile: (await raw.query(`SELECT cp.*, oc.notes, oc.tags, oc.removed_at FROM candidate_profiles cp JOIN organization_candidates oc ON oc.candidate_id = cp.id WHERE oc.id = $1`, [f.oc_b])).rows[0],
      children: await Promise.all(CHILD_TABLES.map(async (t) => (await raw.query(`SELECT * FROM ${t} WHERE candidate_id = $1 ORDER BY id`, [f.profile_b])).rows)),
      docs: (await raw.query(`SELECT * FROM candidate_documents WHERE candidate_id = $1 ORDER BY id`, [f.profile_b])).rows,
    });
    const before = await bState();
    expect(files.has(f.key_a!) && files.has(f.key_b!)).toBe(true);
    const result = await removeCandidate(w.a.deps, w.a.sa, f.oc_a);
    expect(result.filesDeleted).toBeGreaterThan(0);
    // A's own profile is anonymised in place and A's file is gone from the shared store.
    expect((await raw.query(`SELECT full_name, anonymized_at IS NOT NULL AS anon FROM candidate_profiles WHERE id = $1`, [f.profile_a])).rows[0]).toEqual({ full_name: "Removed candidate", anon: true });
    expect(files.has(f.key_a!)).toBe(false);
    // B: the same profile, notes, removal state, education, experience, skills and document rows, and B's file
    // is still in the SAME store A's removal deleted from.
    expect(await bState()).toEqual(before);
    expect(files.has(f.key_b!)).toBe(true);
    // A's removal state is invisible to B.
    expect((await asHr("b", `SELECT removed_at FROM organization_candidates WHERE id = $1`, [f.oc_a])).rows).toEqual([]);
  });
});
