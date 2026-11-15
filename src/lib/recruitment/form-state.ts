// What a recruitment Server Action sends back to its form. Plain data only: it travels to the browser.

export type FormState = {
  message: string | null; // shown above the form or next to the buttons
  fieldErrors: Record<string, string>;
  // The values the person typed, so a rejected form keeps them (forms are reset after an action runs).
  values?: Record<string, string | undefined>;
  // Set when the action worked and the page stays where it is (a counter, so each success is noticed).
  done?: number;
  // The public application form: the reference number to show on the confirmation.
  reference?: string;
};

export const EMPTY_FORM_STATE: FormState = { message: null, fieldErrors: {} };
