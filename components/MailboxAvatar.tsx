"use client";
import {useEffect, useState} from "react";

// Mailbox avatar for the inbox header, compose modal and reader sender
// block. Fetches GET /api/profile-photo?mailbox_id=... and renders the
// photo when one really exists in KV; otherwise renders a circle with the
// address's first letter.
//
// RULE 0: the <img> renders only after a successful photo fetch. A 404 (or
// any fetch failure) renders the letter fallback — never a broken image.
// Pass the mailbox's own id only: for the reader sender block, render this
// component only when the sender address matches one of the user's own
// mailboxes; external senders keep the letter fallback.
//
// KV is eventually consistent: a GET right after an upload can still 404
// for a moment, so a 404 is retried twice (400ms, then 1200ms) before the
// letter fallback is settled on. Without the retry, opening Compose right
// after an upload could show the letter and only a second open would show
// the photo.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function MailboxAvatar({
  mailboxId,
  address,
  size = 34,
}: {
  mailboxId: string;
  address: string;
  size?: number;
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mailboxId) {
      setPhotoUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const r = await fetch(`/api/profile-photo?mailbox_id=${encodeURIComponent(mailboxId)}`);
          if (r.status === 404) {
            if (attempt < 2) {
              await sleep(attempt === 0 ? 400 : 1200);
              if (cancelled) return;
              continue;
            }
            return; // Genuinely no photo: letter fallback.
          }
          if (!r.ok) return; // Any other failure: letter fallback, not a broken image.
          const blob = await r.blob();
          if (!blob.type.startsWith("image/")) return;
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setPhotoUrl(objectUrl);
          return;
        }
      } catch {
        // Network/KV failure: letter fallback, never a broken image.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mailboxId]);

  const letter = (address || "W").trim()[0]?.toUpperCase() || "W";
  const circle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: "#2b4163",
    color: "#dce6ff",
    fontWeight: 700,
    fontSize: Math.max(11, Math.round(size * 0.4)),
    flexShrink: 0,
  };

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        width={size}
        height={size}
        style={{width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0}}
      />
    );
  }
  return (
    <span aria-hidden="true" style={circle}>
      {letter}
    </span>
  );
}
