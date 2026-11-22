"use client";
import {useCallback, useEffect, useState} from "react";
import ProfilePhotoSection from "./ProfilePhotoSection";

// Settings → Sender profile (S1, §15.1).
// One block per mailbox, rendered from the LIVE mailbox list — never
// hardcoded to any address; a mailbox added later gets its block
// automatically. Per mailbox:
//   (a) mailbox photo — the existing ProfilePhotoSection (KV-stored),
//       shown here, not rebuilt. It is the avatar inside WorkMail only;
//       it does NOT travel inside sent emails.
//   (b) BIMI status — live server-side DNS read (GET
//       /api/sender-profile/bimi), raw record shown, Re-check button.
//   (c) Google alternate-email wizard — exact clicks + a USER-CONFIRMED
//       checklist persisted per mailbox in D1 (migration 0009).
//       RULE 0: nothing is auto-checked. There is NO Google API for
//       adding an alternate email to a personal Google Account, so the
//       app cannot see the user's Google Account and cannot verify any
//       step. A step is done only when the user ticks it.
//   (d) plain-language explanation of what recipients see / don't see.
//
// WIZARD_STEPS step_key values must match STEP_KEYS in
// app/api/sender-profile/checklist/route.ts and the comment in
// db/migrations/0009_sender_profile.sql.

type WizardStep = {key: string; title: string; detail: (address: string) => string};

const WIZARD_STEPS: WizardStep[] = [
  {
    key: "open_google_account",
    title: "Open myaccount.google.com",
    detail: () =>
      "Sign in with the Google Account whose photo you want recipients to see. That account's photo is what shows for every address linked to it.",
  },
  {
    key: "personal_info",
    title: "Open Personal info",
    detail: () => "On the left menu (or the top tabs on mobile), open “Personal info”.",
  },
  {
    key: "email_section",
    title: "Open Email",
    detail: () => "Under “Contact info”, open “Email”. This shows your Google Account email and alternate emails.",
  },
  {
    key: "alternate_emails",
    title: "Open Alternate emails",
    detail: () => "Find the “Alternate emails” section on the Email page.",
  },
  {
    key: "add_address",
    title: "Add alternate email — enter this mailbox address",
    detail: (address) =>
      `Click “Add alternate email” and enter exactly this address: ${address}. Then save. Google will send a verification mail to this address.`,
  },
  {
    key: "find_verification_mail",
    title: "Find Google's verification mail in this mailbox's WorkMail inbox",
    detail: () =>
      "Open the WorkMail inbox, switch to this mailbox, and look for Google's verification message (subject mentions verifying your email address).",
  },
  {
    key: "click_verify_link",
    title: "Click the verification link (or enter the code)",
    detail: () =>
      "Open Google's mail and click its verification link — or copy the verification code from the mail into the Google page, if it asks for a code instead.",
  },
  {
    key: "approve_phone_prompt",
    title: "Approve the prompt on your signed-in phone, if Google asks",
    detail: () =>
      "Google may ask you to confirm on your signed-in phone (“Yes, it's me”). Approve it there. If no prompt appears, this step is already done — tick it.",
  },
];

const TOTAL_STEPS = WIZARD_STEPS.length;

type BimiState =
  | {state: "loading"}
  | {state: "error"; message: string}
  | {
      state: "ready";
      status: string;
      records: string[];
      logoUrl: string | null;
      host: string;
      checkedAt: string;
    };

function BimiStatusLabel({status}: {status: string}) {
  if (status === "verified")
    return <b style={{color: "#8fd9b9"}}>Verified — BIMI record found with a valid logo URL</b>;
  if (status === "not_set_up")
    return <b style={{color: "#f2c94c"}}>Not set up — no BIMI record published for this domain</b>;
  if (status === "invalid")
    return <b style={{color: "#f2a6a6"}}>Invalid — a BIMI record exists but is malformed</b>;
  if (status === "lookup_failed")
    return <b style={{color: "#f2a6a6"}}>Check failed — the DNS lookup could not run</b>;
  return <b>{status}</b>;
}

function MailboxSenderProfile({box}: {box: any}) {
  const mailboxId: string = box.id;
  const address: string = box.address;
  const [bimi, setBimi] = useState<BimiState>({state: "loading"});
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [checklistError, setChecklistError] = useState("");
  const [savingKey, setSavingKey] = useState("");

  const loadBimi = useCallback(async () => {
    setBimi({state: "loading"});
    try {
      const r = await fetch(`/api/sender-profile/bimi?mailbox_id=${encodeURIComponent(mailboxId)}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setBimi({state: "error", message: d?.error || "Could not check BIMI status."});
        return;
      }
      setBimi({
        state: "ready",
        status: String(d.status || "lookup_failed"),
        records: Array.isArray(d.records) ? d.records : [],
        logoUrl: d.logo_url || null,
        host: String(d.host || ""),
        checkedAt: String(d.checked_at || ""),
      });
    } catch {
      setBimi({state: "error", message: "Could not check BIMI status."});
    }
  }, [mailboxId]);

  const loadChecklist = useCallback(async () => {
    try {
      const r = await fetch(`/api/sender-profile/checklist?mailbox_id=${encodeURIComponent(mailboxId)}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setChecklistError(d?.error || "Could not load the checklist.");
        return;
      }
      setDoneKeys(new Set((d.steps || []).map((s: any) => String(s.step_key))));
    } catch {
      setChecklistError("Could not load the checklist.");
    }
  }, [mailboxId]);

  useEffect(() => {
    loadBimi();
    loadChecklist();
  }, [loadBimi, loadChecklist]);

  async function toggleStep(stepKey: string, done: boolean) {
    setSavingKey(stepKey);
    setChecklistError("");
    try {
      const r = await fetch("/api/sender-profile/checklist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({mailbox_id: mailboxId, step_key: stepKey, done}),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setChecklistError(d?.error || "Could not save the checklist step.");
        return;
      }
      setDoneKeys(new Set((d.steps || []).map((s: any) => String(s.step_key))));
    } catch {
      setChecklistError("Could not save the checklist step.");
    } finally {
      setSavingKey("");
    }
  }

  const doneCount = doneKeys.size;
  const complete = doneCount === TOTAL_STEPS;

  return (
    <article style={{display: "block"}}>
      <b>{address}</b>
      <span>
        Sender profile — {doneCount} of {TOTAL_STEPS} wizard steps done
        {complete ? " — complete" : ""}
      </span>

      <h3 style={{margin: "12px 0 4px"}}>Mailbox photo</h3>
      <p className="muted" style={{margin: "0 0 4px"}}>
        This photo is shown as your avatar inside WorkMail. It does not travel inside sent
        emails — what recipients see in Gmail comes from your Google Account photo (wizard
        below) and, where supported, BIMI.
      </p>
      <ProfilePhotoSection mailboxId={mailboxId} mailboxAddress={address} />

      <h3 style={{margin: "16px 0 4px"}}>BIMI status (brand logo in inboxes)</h3>
      {bimi.state === "loading" && <p className="muted">Checking the BIMI DNS record live…</p>}
      {bimi.state === "error" && <p style={{fontSize: 12, color: "#f2a6a6"}}>{bimi.message}</p>}
      {bimi.state === "ready" && (
        <>
          <p style={{margin: "0 0 4px"}}>
            <BimiStatusLabel status={bimi.status} />{" "}
            <span className="muted">({bimi.host})</span>
          </p>
          {bimi.records.length > 0 ? (
            <p style={{margin: "0 0 4px"}}>
              <span className="muted">Raw record: </span>
              <code style={{wordBreak: "break-all"}}>{bimi.records.join(" ")}</code>
            </p>
          ) : (
            <p className="muted" style={{margin: "0 0 4px"}}>
              No TXT record found at {bimi.host}.
            </p>
          )}
          {bimi.logoUrl && (
            <p style={{margin: "0 0 4px"}}>
              <span className="muted">Logo URL: </span>
              <code style={{wordBreak: "break-all"}}>{bimi.logoUrl}</code>
            </p>
          )}
          <p className="muted" style={{margin: "0 0 8px"}}>
            Checked live from DNS at {bimi.checkedAt ? new Date(bimi.checkedAt).toLocaleString() : "—"}.
            Honest limit: Gmail shows a BIMI logo ONLY with a paid Verified Mark Certificate
            (about $1,000/year) plus a registered trademark — without one, Gmail shows no logo
            even when this record is Verified. Apple Mail, Yahoo and Fastmail can show the logo
            without a VMC.
          </p>
          <button type="button" onClick={loadBimi}>
            Re-check BIMI
          </button>
        </>
      )}

      <h3 style={{margin: "16px 0 4px"}}>Google alternate-email wizard — show your photo in Gmail</h3>
      <p style={{margin: "0 0 4px"}}>
        Link this mailbox address to your Google Account as an alternate email. Then Gmail
        recipients see your Google Account photo and name next to your mails. There is no
        Google API for this — these are steps you do in your Google Account, and WorkMail
        cannot see or verify them. Tick each step yourself when you have done it; nothing
        here is ticked automatically.
      </p>
      <p className="muted" style={{margin: "0 0 8px"}}>
        The same Google Account photo shows for every address linked to that account — one
        photo, all your mailboxes on that account.
      </p>
      {complete && (
        <p style={{fontSize: 12, color: "#8fd9b9", margin: "0 0 8px"}}>
          All {TOTAL_STEPS} steps ticked — this mailbox is linked as an alternate email on your
          Google Account (as far as you have confirmed here).
        </p>
      )}
      <ol style={{margin: "0 0 8px", paddingLeft: 20}}>
        {WIZARD_STEPS.map((s) => {
          const done = doneKeys.has(s.key);
          return (
            <li key={s.key} style={{marginBottom: 10}}>
              <label style={{display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer"}}>
                <input
                  type="checkbox"
                  checked={done}
                  disabled={savingKey === s.key}
                  onChange={(e) => toggleStep(s.key, e.target.checked)}
                  style={{marginTop: 3}}
                />
                <span>
                  <b style={done ? {textDecoration: "line-through"} : undefined}>{s.title}</b>
                  <br />
                  <span className="muted" style={{fontSize: 12}}>
                    {s.detail(address)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ol>
      {checklistError && <p style={{fontSize: 12, color: "#f2a6a6"}}>{checklistError}</p>}

      <h3 style={{margin: "16px 0 4px"}}>What recipients see — and what they don&apos;t</h3>
      <p style={{margin: "0 0 4px"}}>
        What recipients see in Gmail: your Google Account photo and your name next to the mail,
        and this mailbox&apos;s address as the sender. Nothing else.
      </p>
      <p className="muted" style={{margin: 0}}>
        What they don&apos;t see: your phone number, your other email addresses, your other
        mailboxes, or anything from your Google Account beyond the photo and name. Linking an
        alternate email does not share your contacts or your inbox with anyone.
      </p>
    </article>
  );
}

export default function SenderProfileSection({workspace}: {workspace: string}) {
  const [boxes, setBoxes] = useState<any[]>([]);
  const [error, setError] = useState("");

  const loadBoxes = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await fetch("/api/mailboxes");
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Could not load mailboxes.");
        return;
      }
      setBoxes(d.data || []);
    } catch {
      setError("Could not load mailboxes.");
    }
  }, [workspace]);

  useEffect(() => {
    loadBoxes();
  }, [loadBoxes]);

  if (!workspace)
    return (
      <section>
        <h2>Sender profile</h2>
        <p className="muted">Loading workspace…</p>
      </section>
    );

  return (
    <section>
      <h2>Sender profile</h2>
      <p>
        Per mailbox: your photo, your BIMI brand-logo status, and the guided Google
        alternate-email wizard that makes Gmail show your photo next to your mails. Every
        mailbox gets its own block automatically — including mailboxes added later.
      </p>
      {error && <p style={{fontSize: 12, color: "#f2a6a6"}}>{error}</p>}
      {boxes.length === 0 ? (
        <p className="muted">No mailboxes yet — create one above first.</p>
      ) : (
        boxes.map((b) => <MailboxSenderProfile key={b.id} box={b} />)
      )}
    </section>
  );
}
