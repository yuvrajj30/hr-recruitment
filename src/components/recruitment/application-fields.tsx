import { Input, Textarea } from "@/components/ui/input";
import { APPLICATION_LIMITS } from "@/lib/recruitment/application-input";
import { RESUME_ACCEPT } from "@/lib/recruitment/resume";
import { FormField, FormSection } from "./form-bits";

type Values = Record<string, string | undefined>;
type Errors = Record<string, string>;

// The candidate's details, used by BOTH the public application page and HR's manual entry form,
// so the two can never drift apart. `voice` only changes the wording ("Your name" / "Full name").
//
// The sections are fixed for now. They are kept as plain, separate blocks so that questions from
// the future Form Builder can be added as one more section without touching these.
export function ApplicationFields({ values, errors, voice, resumeRequired }: { values: Values; errors: Errors; voice: "candidate" | "staff"; resumeRequired: boolean }) {
  const you = voice === "candidate";
  return (
    <>
      <FormSection title={you ? "About you" : "Candidate"} description={you ? "How we can reach you." : "Who is applying and how to reach them."}>
        <FormField name="fullName" label="Full name" error={errors.fullName}>
          {(p) => <Input {...p} defaultValue={values.fullName} maxLength={APPLICATION_LIMITS.name} autoComplete={you ? "name" : "off"} required />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="email" label="Email" error={errors.email}>
            {(p) => <Input {...p} type="email" inputMode="email" defaultValue={values.email} maxLength={APPLICATION_LIMITS.email} autoComplete={you ? "email" : "off"} autoCapitalize="none" spellCheck={false} required />}
          </FormField>
          <FormField name="phone" label="Phone" hint="Indian numbers need no country code." error={errors.phone}>
            {(p) => <Input {...p} type="tel" inputMode="tel" defaultValue={values.phone} maxLength={30} autoComplete={you ? "tel" : "off"} required />}
          </FormField>
        </div>
        <FormField name="city" label="City" optional error={errors.city}>
          {(p) => <Input {...p} defaultValue={values.city} maxLength={APPLICATION_LIMITS.city} autoComplete={you ? "address-level2" : "off"} />}
        </FormField>
      </FormSection>

      <FormSection title="Education" description={you ? "Your most recent or current course." : "Their most recent or current course."}>
        <FormField name="institution" label="College or university" optional error={errors.institution}>
          {(p) => <Input {...p} defaultValue={values.institution} maxLength={APPLICATION_LIMITS.institution} />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField name="course" label="Course" optional error={errors.course}>
            {(p) => <Input {...p} defaultValue={values.course} maxLength={APPLICATION_LIMITS.course} placeholder="e.g. Hotel Management" />}
          </FormField>
          <FormField name="degree" label="Qualification" optional error={errors.degree}>
            {(p) => <Input {...p} defaultValue={values.degree} maxLength={APPLICATION_LIMITS.degree} placeholder="e.g. BBA, Diploma, 12th" />}
          </FormField>
          <FormField name="graduationYear" label="Graduation year" optional error={errors.graduationYear}>
            {(p) => <Input {...p} defaultValue={values.graduationYear} inputMode="numeric" maxLength={4} placeholder="e.g. 2025" />}
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Skills and experience">
        <FormField name="skills" label="Skills" optional hint="Separate skills with commas." error={errors.skills}>
          {(p) => <Input {...p} defaultValue={values.skills} placeholder="e.g. Espresso, Customer service, Billing" />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="experienceCompany" label="Most recent employer" optional error={errors.experienceCompany}>
            {(p) => <Input {...p} defaultValue={values.experienceCompany} maxLength={APPLICATION_LIMITS.company} />}
          </FormField>
          <FormField name="experienceTitle" label="Role there" optional error={errors.experienceTitle}>
            {(p) => <Input {...p} defaultValue={values.experienceTitle} maxLength={APPLICATION_LIMITS.title} />}
          </FormField>
        </div>
        <FormField name="experienceDescription" label="Experience" optional hint={you ? "What you did, and for how long. Freshers can leave this empty." : "What they did, and for how long."} error={errors.experienceDescription}>
          {(p) => <Textarea {...p} defaultValue={values.experienceDescription} rows={4} maxLength={APPLICATION_LIMITS.experience} />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="linkedinUrl" label="LinkedIn" optional error={errors.linkedinUrl}>
            {(p) => <Input {...p} defaultValue={values.linkedinUrl} inputMode="url" maxLength={APPLICATION_LIMITS.url} autoCapitalize="none" spellCheck={false} placeholder="linkedin.com/in/…" />}
          </FormField>
          <FormField name="portfolioUrl" label="Portfolio or GitHub" optional error={errors.portfolioUrl}>
            {(p) => <Input {...p} defaultValue={values.portfolioUrl} inputMode="url" maxLength={APPLICATION_LIMITS.url} autoCapitalize="none" spellCheck={false} />}
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Resume" description="PDF or Word document, up to 5 MB.">
        <FormField
          name="resume"
          label={resumeRequired ? "Resume" : "Resume file"}
          optional={!resumeRequired}
          hint={Object.keys(errors).length > 0 ? "For security, browsers clear the chosen file when a form is sent back. Please choose it again." : undefined}
          error={errors.resume}
        >
          {(p) => (
            <input
              {...p}
              type="file"
              accept={RESUME_ACCEPT}
              required={resumeRequired}
              className="block w-full text-sm text-fg file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg hover:file:bg-surface-muted"
            />
          )}
        </FormField>
      </FormSection>
    </>
  );
}
