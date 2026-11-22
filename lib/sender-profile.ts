// Sender-profile wizard steps — SINGLE SOURCE OF TRUTH (MERGE 2).
//
// The 8 Google alternate-email wizard steps live here and ONLY here.
// Both the Settings UI (app/settings/SenderProfileSection.tsx) and the
// checklist API (app/api/sender-profile/checklist/route.ts) import from
// this file; the step_key comment in db/migrations/0009_sender_profile.sql
// points here too. Do NOT copy this list anywhere else — a copied list
// drifts (the old STEP_KEYS / WIZARD_STEPS duplication), and a drifted
// list means the API rejects a step the UI shows, or vice versa.
//
// RULE 0: a step is done ONLY when the user ticks it. There is NO Google
// API for adding an alternate email to a personal Google Account, so the
// app cannot see the user's Google Account and NOTHING is auto-checked.

export type SenderProfileStep = {
  key: string;
  title: string;
  detail: (address: string) => string;
};

export const SENDER_PROFILE_STEPS: SenderProfileStep[] = [
  {
    key: 'open_google_account',
    title: 'Open myaccount.google.com',
    detail: () =>
      "Sign in with the Google Account whose photo you want recipients to see. That account's photo is what shows for every address linked to it.",
  },
  {
    key: 'personal_info',
    title: 'Open Personal info',
    detail: () => 'On the left menu (or the top tabs on mobile), open “Personal info”.',
  },
  {
    key: 'email_section',
    title: 'Open Email',
    detail: () => 'Under “Contact info”, open “Email”. This shows your Google Account email and alternate emails.',
  },
  {
    key: 'alternate_emails',
    title: 'Open Alternate emails',
    detail: () => 'Find the “Alternate emails” section on the Email page.',
  },
  {
    key: 'add_address',
    title: 'Add alternate email — enter this mailbox address',
    detail: (address: string) =>
      `Click “Add alternate email” and enter exactly this address: ${address}. Then save. Google will send a verification mail to this address.`,
  },
  {
    key: 'find_verification_mail',
    title: "Find Google's verification mail in this mailbox's WorkMail inbox",
    detail: () =>
      "Open the WorkMail inbox, switch to this mailbox, and look for Google's verification message (subject mentions verifying your email address).",
  },
  {
    key: 'click_verify_link',
    title: 'Click the verification link (or enter the code)',
    detail: () =>
      "Open Google's mail and click its verification link — or copy the verification code from the mail into the Google page, if it asks for a code instead.",
  },
  {
    key: 'approve_phone_prompt',
    title: 'Approve the prompt on your signed-in phone, if Google asks',
    detail: () =>
      "Google may ask you to confirm on your signed-in phone (“Yes, it's me”). Approve it there. If no prompt appears, this step is already done — tick it.",
  },
];

// The key list the checklist API validates step_key against.
export const SENDER_PROFILE_STEP_KEYS: readonly string[] = SENDER_PROFILE_STEPS.map((s) => s.key);
