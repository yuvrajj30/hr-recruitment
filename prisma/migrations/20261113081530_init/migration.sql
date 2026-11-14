-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CandidateType" AS ENUM ('EXTERNAL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "JobVisibility" AS ENUM ('PUBLIC', 'INTERNAL_ONLY');

-- CreateEnum
CREATE TYPE "CandidateAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LoginTokenPurpose" AS ENUM ('SIGN_IN', 'VERIFY_EMAIL');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('INTERNSHIP', 'FULL_TIME', 'PART_TIME', 'CONTRACT');

-- CreateEnum
CREATE TYPE "WorkMode" AS ENUM ('ON_SITE', 'HYBRID', 'REMOTE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('APPLIED', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER_ISSUED', 'OFFER_ACCEPTED', 'ONBOARDING', 'JOINED', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('RESUME', 'ADDITIONAL', 'IDENTITY', 'EDUCATION', 'OFFER_LETTER', 'OTHER');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FormPurpose" AS ENUM ('INITIAL_APPLICATION', 'TECHNICAL_SCREENING', 'HR_SCREENING', 'ADDITIONAL_INFORMATION', 'INTERVIEW_EVALUATION');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('SHORT_TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'NUMBER', 'DROPDOWN', 'RADIO', 'CHECKBOXES', 'DATE', 'YES_NO', 'FILE_UPLOAD', 'RESUME_UPLOAD', 'URL', 'RATING');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InterviewType" AS ENUM ('ONLINE', 'IN_PERSON', 'PHONE');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "Recommendation" AS ENUM ('STRONGLY_RECOMMEND', 'RECOMMEND', 'HOLD', 'REJECT');

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('SELECTED', 'REJECTED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'JOINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OnboardingDocStatus" AS ENUM ('PENDING', 'UPLOADED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPLICATION_RECEIVED', 'APPLICATION_STATUS_CHANGED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_RESCHEDULED', 'INTERVIEW_CANCELLED', 'INTERVIEW_REMINDER', 'EVALUATION_PENDING', 'FORM_ASSIGNED', 'OFFER_ISSUED', 'OFFER_RESPONDED', 'ONBOARDING_DOCUMENTS_PENDING', 'GENERAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "IntegrationSystem" AS ENUM ('CAFEOS');

-- CreateEnum
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('NOT_CONFIGURED', 'ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "EmployeeLinkStatus" AS ENUM ('PENDING_MATCH', 'LINKED', 'CONFLICT', 'UNLINKED');

-- CreateEnum
CREATE TYPE "ExternalEntityType" AS ENUM ('DEPARTMENT', 'LOCATION', 'ROLE', 'USER');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'RETRYING', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'IN_PROGRESS', 'SYNCED', 'FAILED', 'CONFLICT');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "owner_user_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "default_currency" TEXT NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT,
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'INVITED',
    "invited_by_id" UUID,
    "joined_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "organization_member_roles" (
    "member_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_member_roles_pkey" PRIMARY KEY ("member_id","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active_organization_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_openings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "department_id" UUID,
    "visibility" "JobVisibility" NOT NULL DEFAULT 'PUBLIC',
    "employment_type" "EmploymentType" NOT NULL,
    "work_mode" "WorkMode" NOT NULL,
    "location" TEXT,
    "required_skills" TEXT[],
    "qualifications" TEXT,
    "experience_requirement" TEXT,
    "compensation_min" DECIMAL(12,2),
    "compensation_max" DECIMAL(12,2),
    "compensation_currency" TEXT NOT NULL DEFAULT 'INR',
    "compensation_period" TEXT,
    "internship_months" INTEGER,
    "openings_count" INTEGER NOT NULL DEFAULT 1,
    "application_deadline" TIMESTAMPTZ(6),
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "application_form_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_recruiters" (
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_recruiters_pkey" PRIMARY KEY ("job_id","user_id")
);

-- CreateTable
CREATE TABLE "candidate_profiles" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "city" TEXT,
    "linkedin_url" TEXT,
    "portfolio_url" TEXT,
    "anonymized_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_educations" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "institution" TEXT NOT NULL,
    "course" TEXT,
    "degree" TEXT,
    "graduation_year" INTEGER,
    "grade" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_educations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_experiences" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_experiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_skills" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_candidates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "candidate_type" "CandidateType" NOT NULL DEFAULT 'EXTERNAL',
    "employee_link_id" UUID,
    "claimed_employee_code" TEXT,
    "internal_verified_at" TIMESTAMPTZ(6),
    "tags" TEXT[],
    "notes" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_documents" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "organization_id" UUID,
    "application_id" UUID,
    "kind" "DocumentKind" NOT NULL,
    "original_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "candidate_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_documents" (
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "shared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_documents_pkey" PRIMARY KEY ("application_id","document_id")
);

-- CreateTable
CREATE TABLE "candidate_accounts" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "status" "CandidateAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "candidate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_login_tokens" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "LoginTokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "requested_ip" TEXT,
    "candidate_id" UUID,
    "application_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_login_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reference_number" TEXT NOT NULL,
    "organization_candidate_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage" "ApplicationStage" NOT NULL DEFAULT 'APPLIED',
    "stage_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rejection_reason" TEXT,
    "source" TEXT,
    "candidate_type_at_application" "CandidateType" NOT NULL DEFAULT 'EXTERNAL',
    "profile_snapshot" JSONB,
    "assigned_recruiter_id" UUID,
    "status_token_hash" TEXT,
    "consent_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "privacy_notice_version" TEXT,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_status_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_stage" "ApplicationStage",
    "to_stage" "ApplicationStage" NOT NULL,
    "changed_by_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_notes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "purpose" "FormPurpose" NOT NULL,
    "suggested_stage" "ApplicationStage",
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "config" JSONB,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "stage_at_assignment" "ApplicationStage",
    "assigned_by_id" UUID,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "access_token_hash" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "form_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "assignment_id" UUID,
    "template_version" INTEGER NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_answers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "field_id" UUID,
    "field_key" TEXT NOT NULL,
    "field_label" TEXT NOT NULL,
    "field_type" "FieldType" NOT NULL,
    "value" JSONB,
    "document_id" UUID,

    CONSTRAINT "form_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "round_number" INTEGER NOT NULL,
    "round_name" TEXT,
    "type" "InterviewType" NOT NULL,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_start" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(6) NOT NULL,
    "meeting_link" TEXT,
    "location" TEXT,
    "instructions" TEXT,
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_participants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "interviewer_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_feedback" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "interviewer_id" UUID NOT NULL,
    "technical_knowledge" INTEGER,
    "communication" INTEGER,
    "problem_solving" INTEGER,
    "confidence" INTEGER,
    "relevant_experience" INTEGER,
    "role_suitability" INTEGER,
    "overall_rating" INTEGER,
    "strengths" TEXT,
    "weaknesses" TEXT,
    "notes" TEXT,
    "recommendation" "Recommendation",
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hiring_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "outcome" "DecisionOutcome" NOT NULL,
    "rationale" TEXT,
    "decided_by_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hiring_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "designation" TEXT NOT NULL,
    "compensation_amount" DECIMAL(12,2) NOT NULL,
    "compensation_currency" TEXT NOT NULL DEFAULT 'INR',
    "compensation_period" TEXT,
    "joining_date" DATE,
    "expires_at" TIMESTAMPTZ(6),
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "offer_letter_id" UUID,
    "issued_at" TIMESTAMPTZ(6),
    "responded_at" TIMESTAMPTZ(6),
    "decline_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "personal_details_verified" BOOLEAN NOT NULL DEFAULT false,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "emergency_contact_name" TEXT,
    "emergency_contact_relation" TEXT,
    "emergency_contact_phone" TEXT,
    "joining_date" DATE,
    "department_id" UUID,
    "designation" TEXT,
    "assigned_location" TEXT,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "joined_at" TIMESTAMPTZ(6),
    "employee_link_id" UUID,
    "integration_status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "onboarding_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "onboarding_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "status" "OnboardingDocStatus" NOT NULL DEFAULT 'PENDING',
    "document_id" UUID,
    "remarks" TEXT,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "onboarding_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "recipient_user_id" UUID,
    "recipient_email" TEXT,
    "application_id" UUID,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "scheduled_for" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_user_id" UUID,
    "actor_label" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "system" "IntegrationSystem" NOT NULL DEFAULT 'CAFEOS',
    "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "base_url" TEXT,
    "external_tenant_ref" TEXT,
    "secret_reference" TEXT,
    "last_success_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_employee_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_employee_id" TEXT,
    "external_employee_code" TEXT,
    "display_name" TEXT,
    "status" "EmployeeLinkStatus" NOT NULL DEFAULT 'PENDING_MATCH',
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_employee_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_entity_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "entity_type" "ExternalEntityType" NOT NULL,
    "local_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_entity_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL DEFAULT 'OUTBOUND',
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(6),
    "payload" JSONB,
    "response_summary" JSONB,
    "external_ref" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_errors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sync_job_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "http_status" INTEGER,
    "error_code" TEXT,
    "message" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_sync_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_by_id" UUID,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_owner_user_id_idx" ON "organizations"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE INDEX "organization_member_roles_role_id_idx" ON "organization_member_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organization_id_name_key" ON "departments"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organization_id_id_key" ON "departments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "job_openings_organization_id_status_application_deadline_idx" ON "job_openings"("organization_id", "status", "application_deadline");

-- CreateIndex
CREATE INDEX "job_openings_organization_id_department_id_idx" ON "job_openings"("organization_id", "department_id");

-- CreateIndex
CREATE INDEX "job_openings_created_by_id_idx" ON "job_openings"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_openings_organization_id_slug_key" ON "job_openings"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "job_openings_organization_id_id_key" ON "job_openings"("organization_id", "id");

-- CreateIndex
CREATE INDEX "job_recruiters_organization_id_user_id_idx" ON "job_recruiters"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_email_key" ON "candidate_profiles"("email");

-- CreateIndex
CREATE INDEX "candidate_profiles_full_name_idx" ON "candidate_profiles"("full_name");

-- CreateIndex
CREATE INDEX "candidate_educations_candidate_id_idx" ON "candidate_educations"("candidate_id");

-- CreateIndex
CREATE INDEX "candidate_experiences_candidate_id_idx" ON "candidate_experiences"("candidate_id");

-- CreateIndex
CREATE INDEX "candidate_skills_name_idx" ON "candidate_skills"("name");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_skills_candidate_id_name_key" ON "candidate_skills"("candidate_id", "name");

-- CreateIndex
CREATE INDEX "organization_candidates_candidate_id_idx" ON "organization_candidates"("candidate_id");

-- CreateIndex
CREATE INDEX "organization_candidates_organization_id_candidate_type_idx" ON "organization_candidates"("organization_id", "candidate_type");

-- CreateIndex
CREATE UNIQUE INDEX "organization_candidates_organization_id_candidate_id_key" ON "organization_candidates"("organization_id", "candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_candidates_organization_id_id_key" ON "organization_candidates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_candidates_organization_id_employee_link_id_key" ON "organization_candidates"("organization_id", "employee_link_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_documents_storage_key_key" ON "candidate_documents"("storage_key");

-- CreateIndex
CREATE INDEX "candidate_documents_candidate_id_kind_idx" ON "candidate_documents"("candidate_id", "kind");

-- CreateIndex
CREATE INDEX "candidate_documents_organization_id_application_id_idx" ON "candidate_documents"("organization_id", "application_id");

-- CreateIndex
CREATE INDEX "application_documents_organization_id_application_id_idx" ON "application_documents"("organization_id", "application_id");

-- CreateIndex
CREATE INDEX "application_documents_document_id_idx" ON "application_documents"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_accounts_candidate_id_key" ON "candidate_accounts"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_sessions_token_hash_key" ON "candidate_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "candidate_sessions_account_id_idx" ON "candidate_sessions"("account_id");

-- CreateIndex
CREATE INDEX "candidate_sessions_expires_at_idx" ON "candidate_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_login_tokens_token_hash_key" ON "candidate_login_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "candidate_login_tokens_email_created_at_idx" ON "candidate_login_tokens"("email", "created_at");

-- CreateIndex
CREATE INDEX "candidate_login_tokens_expires_at_idx" ON "candidate_login_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "applications_reference_number_key" ON "applications"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "applications_status_token_hash_key" ON "applications"("status_token_hash");

-- CreateIndex
CREATE INDEX "applications_organization_id_stage_idx" ON "applications"("organization_id", "stage");

-- CreateIndex
CREATE INDEX "applications_organization_id_job_id_stage_idx" ON "applications"("organization_id", "job_id", "stage");

-- CreateIndex
CREATE INDEX "applications_organization_id_applied_at_idx" ON "applications"("organization_id", "applied_at");

-- CreateIndex
CREATE INDEX "applications_organization_candidate_id_idx" ON "applications"("organization_candidate_id");

-- CreateIndex
CREATE INDEX "applications_assigned_recruiter_id_idx" ON "applications"("assigned_recruiter_id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_job_id_organization_candidate_id_key" ON "applications"("job_id", "organization_candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_organization_id_id_key" ON "applications"("organization_id", "id");

-- CreateIndex
CREATE INDEX "application_status_history_organization_id_application_id_c_idx" ON "application_status_history"("organization_id", "application_id", "created_at");

-- CreateIndex
CREATE INDEX "application_notes_organization_id_application_id_created_at_idx" ON "application_notes"("organization_id", "application_id", "created_at");

-- CreateIndex
CREATE INDEX "form_templates_organization_id_purpose_status_idx" ON "form_templates"("organization_id", "purpose", "status");

-- CreateIndex
CREATE UNIQUE INDEX "form_templates_organization_id_id_key" ON "form_templates"("organization_id", "id");

-- CreateIndex
CREATE INDEX "form_fields_organization_id_template_id_position_idx" ON "form_fields"("organization_id", "template_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_template_id_key_key" ON "form_fields"("template_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "form_assignments_access_token_hash_key" ON "form_assignments"("access_token_hash");

-- CreateIndex
CREATE INDEX "form_assignments_organization_id_application_id_status_idx" ON "form_assignments"("organization_id", "application_id", "status");

-- CreateIndex
CREATE INDEX "form_assignments_organization_id_template_id_idx" ON "form_assignments"("organization_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_submissions_assignment_id_key" ON "form_submissions"("assignment_id");

-- CreateIndex
CREATE INDEX "form_submissions_organization_id_application_id_idx" ON "form_submissions"("organization_id", "application_id");

-- CreateIndex
CREATE INDEX "form_submissions_organization_id_template_id_idx" ON "form_submissions"("organization_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_submissions_organization_id_id_key" ON "form_submissions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "form_answers_organization_id_submission_id_idx" ON "form_answers"("organization_id", "submission_id");

-- CreateIndex
CREATE INDEX "form_answers_field_id_idx" ON "form_answers"("field_id");

-- CreateIndex
CREATE INDEX "interviews_organization_id_application_id_idx" ON "interviews"("organization_id", "application_id");

-- CreateIndex
CREATE INDEX "interviews_organization_id_scheduled_start_idx" ON "interviews"("organization_id", "scheduled_start");

-- CreateIndex
CREATE INDEX "interviews_organization_id_status_scheduled_start_idx" ON "interviews"("organization_id", "status", "scheduled_start");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_organization_id_id_key" ON "interviews"("organization_id", "id");

-- CreateIndex
CREATE INDEX "interview_participants_organization_id_interviewer_id_idx" ON "interview_participants"("organization_id", "interviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_participants_interview_id_interviewer_id_key" ON "interview_participants"("interview_id", "interviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_participants_organization_id_id_key" ON "interview_participants"("organization_id", "id");

-- CreateIndex
CREATE INDEX "interview_feedback_interviewer_id_idx" ON "interview_feedback"("interviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_feedback_organization_id_participant_id_key" ON "interview_feedback"("organization_id", "participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "hiring_decisions_organization_id_application_id_key" ON "hiring_decisions"("organization_id", "application_id");

-- CreateIndex
CREATE INDEX "offers_organization_id_application_id_status_idx" ON "offers"("organization_id", "application_id", "status");

-- CreateIndex
CREATE INDEX "offers_organization_id_status_expires_at_idx" ON "offers"("organization_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "offers_organization_id_id_key" ON "offers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "onboarding_records_organization_id_status_idx" ON "onboarding_records"("organization_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_records_organization_id_integration_status_idx" ON "onboarding_records"("organization_id", "integration_status");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_records_organization_id_application_id_key" ON "onboarding_records"("organization_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_records_organization_id_offer_id_key" ON "onboarding_records"("organization_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_records_organization_id_id_key" ON "onboarding_records"("organization_id", "id");

-- CreateIndex
CREATE INDEX "onboarding_documents_organization_id_onboarding_id_status_idx" ON "onboarding_documents"("organization_id", "onboarding_id", "status");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_read_at_idx" ON "notifications"("recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_status_scheduled_for_idx" ON "notifications"("organization_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "notifications_organization_id_application_id_idx" ON "notifications"("organization_id", "application_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_organization_id_system_key" ON "integration_connections"("organization_id", "system");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_organization_id_id_key" ON "integration_connections"("organization_id", "id");

-- CreateIndex
CREATE INDEX "external_employee_links_organization_id_status_idx" ON "external_employee_links"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "external_employee_links_connection_id_external_employee_id_key" ON "external_employee_links"("connection_id", "external_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_employee_links_organization_id_id_key" ON "external_employee_links"("organization_id", "id");

-- CreateIndex
CREATE INDEX "external_entity_mappings_organization_id_entity_type_idx" ON "external_entity_mappings"("organization_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "external_entity_mappings_connection_id_entity_type_local_id_key" ON "external_entity_mappings"("connection_id", "entity_type", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_entity_mappings_connection_id_entity_type_external_key" ON "external_entity_mappings"("connection_id", "entity_type", "external_id");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_status_next_attempt_at_idx" ON "integration_sync_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_entity_type_entity_id_idx" ON "integration_sync_jobs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_organization_id_status_idx" ON "integration_sync_jobs"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_sync_jobs_connection_id_idempotency_key_key" ON "integration_sync_jobs"("connection_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "integration_sync_jobs_organization_id_id_key" ON "integration_sync_jobs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "integration_sync_errors_sync_job_id_attempt_number_idx" ON "integration_sync_errors"("sync_job_id", "attempt_number");

-- CreateIndex
CREATE INDEX "integration_sync_errors_organization_id_occurred_at_idx" ON "integration_sync_errors"("organization_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_key_hash_key" ON "api_clients"("key_hash");

-- CreateIndex
CREATE INDEX "api_clients_organization_id_idx" ON "api_clients"("organization_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "organization_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_fkey" FOREIGN KEY ("active_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_organization_id_application_form_id_fkey" FOREIGN KEY ("organization_id", "application_form_id") REFERENCES "form_templates"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_recruiters" ADD CONSTRAINT "job_recruiters_organization_id_job_id_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "job_openings"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_recruiters" ADD CONSTRAINT "job_recruiters_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_educations" ADD CONSTRAINT "candidate_educations_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_experiences" ADD CONSTRAINT "candidate_experiences_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_skills" ADD CONSTRAINT "candidate_skills_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_candidates" ADD CONSTRAINT "organization_candidates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_candidates" ADD CONSTRAINT "organization_candidates_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_candidates" ADD CONSTRAINT "organization_candidates_organization_id_employee_link_id_fkey" FOREIGN KEY ("organization_id", "employee_link_id") REFERENCES "external_employee_links"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "candidate_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_accounts" ADD CONSTRAINT "candidate_accounts_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_sessions" ADD CONSTRAINT "candidate_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "candidate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_login_tokens" ADD CONSTRAINT "candidate_login_tokens_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_login_tokens" ADD CONSTRAINT "candidate_login_tokens_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_organization_id_job_id_fkey" FOREIGN KEY ("organization_id", "job_id") REFERENCES "job_openings"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_organization_id_organization_candidate_id_fkey" FOREIGN KEY ("organization_id", "organization_candidate_id") REFERENCES "organization_candidates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_assigned_recruiter_id_fkey" FOREIGN KEY ("assigned_recruiter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "form_templates"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_assignments" ADD CONSTRAINT "form_assignments_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_assignments" ADD CONSTRAINT "form_assignments_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "form_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_assignments" ADD CONSTRAINT "form_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "form_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "form_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_organization_id_submission_id_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "form_submissions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "form_fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_answers" ADD CONSTRAINT "form_answers_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "candidate_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_organization_id_interview_id_fkey" FOREIGN KEY ("organization_id", "interview_id") REFERENCES "interviews"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_organization_id_interviewer_id_fkey" FOREIGN KEY ("organization_id", "interviewer_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_organization_id_participant_id_fkey" FOREIGN KEY ("organization_id", "participant_id") REFERENCES "interview_participants"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_interviewer_id_fkey" FOREIGN KEY ("interviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_decisions" ADD CONSTRAINT "hiring_decisions_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_decisions" ADD CONSTRAINT "hiring_decisions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_offer_letter_id_fkey" FOREIGN KEY ("offer_letter_id") REFERENCES "candidate_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_organization_id_offer_id_fkey" FOREIGN KEY ("organization_id", "offer_id") REFERENCES "offers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_organization_id_employee_link_id_fkey" FOREIGN KEY ("organization_id", "employee_link_id") REFERENCES "external_employee_links"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_organization_id_onboarding_id_fkey" FOREIGN KEY ("organization_id", "onboarding_id") REFERENCES "onboarding_records"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "candidate_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "applications"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_employee_links" ADD CONSTRAINT "external_employee_links_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_mappings" ADD CONSTRAINT "external_entity_mappings_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_errors" ADD CONSTRAINT "integration_sync_errors_organization_id_sync_job_id_fkey" FOREIGN KEY ("organization_id", "sync_job_id") REFERENCES "integration_sync_jobs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- Extra database rules that Prisma's schema language cannot express (v2).
-- These are appended to the first migration (see setup instructions).
-- ============================================================================

-- 1. Prevent duplicate scheduling: only one non-cancelled interview per round
CREATE UNIQUE INDEX "interviews_one_active_per_round"
  ON "interviews" ("application_id", "round_number")
  WHERE "status" <> 'CANCELLED';

-- 2. At most one active offer per application (Draft, Issued or Accepted)
CREATE UNIQUE INDEX "offers_one_active_per_application"
  ON "offers" ("application_id")
  WHERE "status" IN ('DRAFT', 'ISSUED', 'ACCEPTED');

-- 3. Value checks so bad data cannot get in even if app code has a bug
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "job_openings"
  ADD CONSTRAINT "job_openings_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "job_openings_openings_positive" CHECK ("openings_count" >= 1),
  ADD CONSTRAINT "job_openings_compensation_range" CHECK
    ("compensation_min" IS NULL OR "compensation_max" IS NULL OR "compensation_max" >= "compensation_min"),
  ADD CONSTRAINT "job_openings_internship_months_positive" CHECK
    ("internship_months" IS NULL OR "internship_months" > 0);

ALTER TABLE "candidate_educations"
  ADD CONSTRAINT "candidate_educations_year_range" CHECK
    ("graduation_year" IS NULL OR "graduation_year" BETWEEN 1950 AND 2100);

ALTER TABLE "interviews"
  ADD CONSTRAINT "interviews_end_after_start" CHECK ("scheduled_end" > "scheduled_start"),
  ADD CONSTRAINT "interviews_round_positive" CHECK ("round_number" >= 1);

ALTER TABLE "interview_feedback"
  ADD CONSTRAINT "interview_feedback_ratings_1_to_5" CHECK (
    ("technical_knowledge" IS NULL OR "technical_knowledge" BETWEEN 1 AND 5) AND
    ("communication"       IS NULL OR "communication"       BETWEEN 1 AND 5) AND
    ("problem_solving"     IS NULL OR "problem_solving"     BETWEEN 1 AND 5) AND
    ("confidence"          IS NULL OR "confidence"          BETWEEN 1 AND 5) AND
    ("relevant_experience" IS NULL OR "relevant_experience" BETWEEN 1 AND 5) AND
    ("role_suitability"    IS NULL OR "role_suitability"    BETWEEN 1 AND 5) AND
    ("overall_rating"      IS NULL OR "overall_rating"      BETWEEN 1 AND 5)
  );

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_amount_not_negative" CHECK ("compensation_amount" >= 0);

ALTER TABLE "candidate_documents"
  ADD CONSTRAINT "candidate_documents_size_positive" CHECK ("size_bytes" > 0),
  -- a file attached to an application must say which organization it belongs to
  ADD CONSTRAINT "candidate_documents_application_needs_org" CHECK
    ("application_id" IS NULL OR "organization_id" IS NOT NULL);

ALTER TABLE "form_fields"
  ADD CONSTRAINT "form_fields_position_not_negative" CHECK ("position" >= 0);

-- An INTERNAL candidate must have an employee link or a stated employee code
ALTER TABLE "organization_candidates"
  ADD CONSTRAINT "organization_candidates_internal_needs_reference" CHECK
    ("candidate_type" = 'EXTERNAL' OR "employee_link_id" IS NOT NULL OR "claimed_employee_code" IS NOT NULL);

ALTER TABLE "integration_sync_jobs"
  ADD CONSTRAINT "integration_sync_jobs_attempts_valid" CHECK
    ("attempt_count" >= 0 AND "max_attempts" >= 1 AND "attempt_count" <= "max_attempts");

-- 4. History and audit records cannot be silently rewritten.
--    The only allowed change is clearing the actor (when a user is removed).
CREATE FUNCTION "block_record_changes"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only: rows cannot be deleted', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - 'actor_user_id' - 'changed_by_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'actor_user_id' - 'changed_by_id') THEN
    RAISE EXCEPTION '% is append-only: rows cannot be modified', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();

-- Failed sync attempts are a permanent record too
CREATE TRIGGER "integration_sync_errors_append_only"
  BEFORE UPDATE OR DELETE ON "integration_sync_errors"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();

-- Status history: edits are blocked; deletes are allowed only through cascades
-- (so test data can be cleaned up), never by normal application code.
CREATE FUNCTION "block_history_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'changed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'changed_by_id') THEN
    RAISE EXCEPTION 'application_status_history is append-only: rows cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "application_status_history_no_update"
  BEFORE UPDATE ON "application_status_history"
  FOR EACH ROW EXECUTE FUNCTION "block_history_updates"();

-- 5. A candidate can only share THEIR OWN files with an application
CREATE FUNCTION "check_application_document_owner"() RETURNS trigger AS $$
DECLARE
  doc_candidate uuid;
  app_candidate uuid;
BEGIN
  SELECT "candidate_id" INTO doc_candidate FROM "candidate_documents" WHERE "id" = NEW."document_id";
  SELECT oc."candidate_id" INTO app_candidate
    FROM "applications" a
    JOIN "organization_candidates" oc ON oc."id" = a."organization_candidate_id"
   WHERE a."id" = NEW."application_id";
  IF doc_candidate IS DISTINCT FROM app_candidate THEN
    RAISE EXCEPTION 'document does not belong to the candidate who made this application';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "application_documents_owner_check"
  BEFORE INSERT OR UPDATE ON "application_documents"
  FOR EACH ROW EXECUTE FUNCTION "check_application_document_owner"();

