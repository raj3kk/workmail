"use client";
import {useCallback, useEffect, useRef, useState} from "react";

// Per-mailbox profile photo editor for Settings → Mailboxes.
// Self-contained: fetches the current photo (GET /api/profile-photo),
// previews a newly picked file before saving, uploads (POST) and removes
// (DELETE). The photo is shown as the avatar in WorkMail only — it never
// travels inside sent emails.
//
// RULE 0: the <img> renders only when a photo was actually returned by the
// API. A missing photo (404) renders the initial-letter circle, never a
// broken image.
//
// Removal uses an INLINE two-step confirmation (click once to arm, click
// again to delete) — never window.confirm(). A native confirm() dialog is
// auto-dismissed in headless/automated browsers and returns false, which
// made the old "Remove photo" button silently do nothing: no fetch, no
// state change, no error. The inline arm/disarm state is plain React, so
// it works in every browser and is clickable by automation.
//
// KV is eventually consistent: a GET right after an upload can still 404
// for a moment, so loadPhoto retries a 404 twice (400ms, then 1200ms)
// before settling on the letter fallback. Without the retry the section
// could show "no photo" right after a successful save.

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const ACCEPT_ATTR = "image/jpeg,image/png,image/webp";
const CONFIRM_ARM_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

export default function ProfilePhotoSection({
  mailboxId,
  mailboxAddress,
}: {
  mailboxId: string;
  mailboxAddress: string;
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [selected, setSelected] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function disarmRemove() {
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setConfirmingRemove(false);
  }

  function armRemove() {
    setError("");
    setNotice("");
    setConfirmingRemove(true);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(() => setConfirmingRemove(false), CONFIRM_ARM_MS);
  }

  const loadPhoto = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`/api/profile-photo?mailbox_id=${encodeURIComponent(mailboxId)}`);
        if (r.status === 404) {
          if (attempt < 2) {
            // KV read-after-write lag: the photo may exist but not be
            // visible yet. Retry before concluding there is no photo.
            await sleep(attempt === 0 ? 400 : 1200);
            continue;
          }
          setPhotoUrl(null);
          return;
        }
        if (!r.ok) {
          setError("Could not load the current photo.");
          return;
        }
        const blob = await r.blob();
        if (!blob.type.startsWith("image/")) {
          setPhotoUrl(null);
          return;
        }
        const url = URL.createObjectURL(blob);
        setPhotoUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        return;
      }
    } catch {
      setError("Could not load the current photo.");
    } finally {
      setChecking(false);
    }
  }, [mailboxId]);

  useEffect(() => {
    loadPhoto();
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, [loadPhoto]);

  function pickFile(file: File | null) {
    setError("");
    setNotice("");
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    setPreviewUrl(null);
    setSelected(null);
    if (!file) return;
    if (file.type && !ACCEPTED.includes(file.type)) {
      setError("Only JPEG, PNG or WebP photos are accepted.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Photo must be 2 MB or smaller — this file is ${formatSize(file.size)}.`);
      return;
    }
    if (file.size < 1) {
      setError("The photo file is empty.");
      return;
    }
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreviewUrl(url);
    setSelected(file);
  }

  async function savePhoto() {
    if (!selected) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("mailbox_id", mailboxId);
      fd.append("file", selected);
      const r = await fetch("/api/profile-photo", {method: "POST", body: fd});
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError(d?.error || "Could not save the photo.");
        return;
      }
      setNotice("Profile photo saved.");
      setSelected(null);
      setPreviewUrl(null);
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current);
        previewRef.current = null;
      }
      if (inputRef.current) inputRef.current.value = "";
      await loadPhoto();
    } catch {
      setError("Could not save the photo.");
    } finally {
      setSaving(false);
    }
  }

  async function removePhoto() {
    disarmRemove();
    setRemoving(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/api/profile-photo?mailbox_id=${encodeURIComponent(mailboxId)}`, {
        method: "DELETE",
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setError(d?.error || "Could not remove the photo.");
        return;
      }
      setPhotoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setNotice("Profile photo removed.");
    } catch {
      setError("Could not remove the photo.");
    } finally {
      setRemoving(false);
    }
  }

  const shownUrl = previewUrl || photoUrl;
  const letter = (mailboxAddress || "W").trim()[0]?.toUpperCase() || "W";

  return (
    <div style={{marginTop: 10, display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap"}}>
      {shownUrl ? (
        <img
          src={shownUrl}
          alt={`Profile photo for ${mailboxAddress}`}
          width={64}
          height={64}
          style={{width: 64, height: 64, borderRadius: "50%", objectFit: "cover", flexShrink: 0}}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: "#2b4163",
            color: "#dce6ff",
            fontWeight: 700,
            fontSize: 26,
            flexShrink: 0,
          }}
        >
          {checking ? "…" : letter}
        </span>
      )}
      <div style={{flex: 1, minWidth: 220}}>
        <div style={{fontSize: 12, color: "#bdcce0", marginBottom: 8}}>
          Profile photo for <b>{mailboxAddress}</b>
          {selected ? ` — new file: ${selected.name} (${formatSize(selected.size)})` : ""}
        </div>
        <div style={{display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center"}}>
          <label
            style={{
              background: "#1a2a43",
              border: "1px solid #283a55",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Choose photo
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTR}
              style={{display: "none"}}
              onChange={(e) => pickFile(e.target.files?.[0] || null)}
            />
          </label>
          <button type="button" disabled={!selected || saving} onClick={savePhoto}>
            {saving ? "Saving…" : "Save photo"}
          </button>
          {photoUrl && !previewUrl && !confirmingRemove && (
            <button type="button" disabled={removing} onClick={armRemove}>
              Remove photo
            </button>
          )}
          {photoUrl && !previewUrl && confirmingRemove && (
            <>
              <button
                type="button"
                disabled={removing}
                onClick={removePhoto}
                style={{background: "#5b2333", borderColor: "#8a3a44"}}
              >
                {removing ? "Removing…" : "Click again to confirm removal"}
              </button>
              <button
                type="button"
                disabled={removing}
                onClick={disarmRemove}
                style={{background: "none", border: 0, color: "#bdcce0", fontSize: 12}}
              >
                Cancel
              </button>
            </>
          )}
          {previewUrl && (
            <button
              type="button"
              onClick={() => pickFile(null)}
              style={{background: "none", border: 0, color: "#f2a6a6", fontSize: 12}}
            >
              Cancel
            </button>
          )}
        </div>
        <p style={{fontSize: 11, color: "#96a8c3", lineHeight: 1.6, margin: "8px 0 0"}}>
          JPEG, PNG or WebP, max 2 MB. Square photos look best — the photo is shown cropped to a
          circle.
        </p>
        <p style={{fontSize: 11, color: "#96a8c3", lineHeight: 1.6, margin: "4px 0 0"}}>
          Shown as your avatar in WorkMail. It does not travel inside sent emails — the sender
          logo in recipients&apos; inboxes comes from BIMI (see docs/BIMI.md).
        </p>
        {error && <p style={{fontSize: 12, color: "#f2a6a6", margin: "8px 0 0"}}>{error}</p>}
        {notice && <p style={{fontSize: 12, color: "#8fd9b9", margin: "8px 0 0"}}>{notice}</p>}
      </div>
    </div>
  );
}
