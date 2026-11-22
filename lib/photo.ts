// Per-mailbox profile photo, stored in Cloudflare KV — the same KV the
// attachments store uses (see lib/kv.ts). No new storage backend.
//
// Key layout:
//   photo/<workspaceId>/<mailboxId>        — the image bytes
//   photo/<workspaceId>/<mailboxId>/meta   — JSON {content_type, size_bytes}
//
// The meta key exists because kvGet returns bytes only; the stored
// Content-Type is not recoverable from the KV read alone. If the meta key
// is missing (partial write), getMailboxPhoto falls back to magic-byte
// detection, and returns null rather than serve bytes of unknown type.
//
// HONESTY (RULE 0): a photo only ever renders when it really exists in KV.
// A missing photo is a null here, and every caller must render the
// initial-letter fallback — never an <img> pointed at a URL that 404s.

import {kvPut, kvGet, kvDelete} from '@/lib/kv';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedPhotoType = (typeof ALLOWED_PHOTO_TYPES)[number];

export interface MailboxPhoto {
  bytes: Buffer;
  contentType: AllowedPhotoType;
  sizeBytes: number;
}

export function photoKey(workspaceId: string, mailboxId: string): string {
  return `photo/${workspaceId}/${mailboxId}`;
}

function photoMetaKey(workspaceId: string, mailboxId: string): string {
  return `photo/${workspaceId}/${mailboxId}/meta`;
}

// Magic-byte detection. JPEG: FF D8 FF. PNG: 89 50 4E 47 0D 0A 1A 0A.
// WebP: bytes 0-3 "RIFF" and bytes 8-11 "WEBP".
export function detectPhotoType(bytes: Buffer): AllowedPhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return 'image/webp';
  return null;
}

function isAllowedPhotoType(value: string): value is AllowedPhotoType {
  return (ALLOWED_PHOTO_TYPES as readonly string[]).includes(value);
}

// Validate size, declared content-type AND magic bytes. The declared type
// must match the bytes: a renamed .exe (or any non-image) is rejected even
// if the browser reported an image content-type. Throws an Error whose
// message is safe to show to the user. Returns the verified content-type.
export function validatePhoto(bytes: Buffer, contentType: string): AllowedPhotoType {
  if (!bytes || bytes.length === 0) throw new Error('The photo file is empty.');
  if (bytes.length > MAX_PHOTO_BYTES)
    throw new Error(
      `Photo must be 2 MB or smaller — this file is ${(bytes.length / (1024 * 1024)).toFixed(2)} MB.`,
    );
  if (!isAllowedPhotoType(contentType))
    throw new Error('Only JPEG, PNG or WebP photos are accepted.');
  const detected = detectPhotoType(bytes);
  if (!detected)
    throw new Error('This file is not a valid JPEG, PNG or WebP image.');
  if (detected !== contentType)
    throw new Error(
      `The file contents are ${detected.replace('image/', '').toUpperCase()}, not ${contentType.replace('image/', '').toUpperCase()} — the file type and its contents do not match.`,
    );
  return detected;
}

export async function saveMailboxPhoto(
  workspaceId: string,
  mailboxId: string,
  bytes: Buffer,
  contentType: string,
): Promise<{contentType: AllowedPhotoType; sizeBytes: number}> {
  const verified = validatePhoto(bytes, contentType);
  await kvPut(photoKey(workspaceId, mailboxId), bytes, verified);
  await kvPut(
    photoMetaKey(workspaceId, mailboxId),
    Buffer.from(JSON.stringify({content_type: verified, size_bytes: bytes.length}), 'utf8'),
    'application/json',
  );
  return {contentType: verified, sizeBytes: bytes.length};
}

export async function getMailboxPhoto(
  workspaceId: string,
  mailboxId: string,
): Promise<MailboxPhoto | null> {
  const bytes = await kvGet(photoKey(workspaceId, mailboxId));
  if (!bytes) return null;
  const metaRaw = await kvGet(photoMetaKey(workspaceId, mailboxId)).catch(() => null);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw.toString('utf8')) as {content_type?: unknown; size_bytes?: unknown};
      if (isAllowedPhotoType(String(meta.content_type || ''))) {
        const sizeBytes = typeof meta.size_bytes === 'number' ? meta.size_bytes : bytes.length;
        return {bytes, contentType: meta.content_type as AllowedPhotoType, sizeBytes};
      }
    } catch {
      // Corrupt meta: fall through to magic-byte detection below.
    }
  }
  // No usable meta — trust only the bytes themselves.
  const detected = detectPhotoType(bytes);
  if (!detected) return null;
  return {bytes, contentType: detected, sizeBytes: bytes.length};
}

export async function deleteMailboxPhoto(workspaceId: string, mailboxId: string): Promise<void> {
  await kvDelete(photoKey(workspaceId, mailboxId));
  await kvDelete(photoMetaKey(workspaceId, mailboxId));
}
