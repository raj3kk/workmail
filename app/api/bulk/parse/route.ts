// POST /api/bulk/parse — upload a CSV/XLSX sheet and preview validation.
//
// Multipart form fields:
//   file (required) — .csv or .xlsx, max BULK_MAX_FILE_BYTES
//   workspace_id (required)
//   subject / text / html (optional) — when present, unknown {{placeholders}}
//   in them are flagged against the sheet's columns in the preview.
//
// Response: columns, counts, valid recipients (capped at BULK_MAX_RECIPIENTS
// — over-cap uploads are rejected with 400), invalid rows, duplicates
// removed, suppressed addresses excluded, unknown placeholders, and the
// workspace's remaining monthly sends. Nothing is stored here; the client
// posts the returned `recipients` to POST /api/bulk/campaigns to create
// the campaign. Suppression is checked against the workspace
// `suppressions` table (the same store lib/providers.ts reads).
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {
  BULK_ACCEPTED_EXTENSIONS,
  BULK_MAX_FILE_BYTES,
  BULK_MAX_RECIPIENTS,
  BulkParseError,
  findUnknownPlaceholders,
  loadSuppressionMap,
  monthlySendRemaining,
  parseSheet,
  sheetRowsToRecipients,
  validateRecipients,
} from '@/lib/bulk';
import {requireUser, workspaceRole} from '@/lib/guards';

export const runtime = 'nodejs';

const formSchema = z.object({
  workspace_id: z.string().uuid(),
  subject: z.string().max(998).optional().default(''),
  text: z.string().max(100000).optional().default(''),
  html: z.string().max(200000).optional().default(''),
});

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({error: 'Expected a multipart form upload.'}, {status: 400});
  }
  const parsed = formSchema.safeParse({
    workspace_id: form.get('workspace_id'),
    subject: form.get('subject') || '',
    text: form.get('text') || '',
    html: form.get('html') || '',
  });
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid request', details: parsed.error.flatten()}, {status: 400});
  const {workspace_id, subject, text, html} = parsed.data;

  const role = await workspaceRole(user.id, workspace_id);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});

  const file = form.get('file');
  if (!file || typeof file !== 'object' || !('arrayBuffer' in file))
    return NextResponse.json({error: 'Attach a .csv or .xlsx file as "file".'}, {status: 400});
  const name = String((file as File).name || '');
  const lower = name.toLowerCase();
  if (!BULK_ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext)))
    return NextResponse.json({error: 'Unsupported file type. Upload a .csv or .xlsx file.'}, {status: 400});
  const buf = Buffer.from(await (file as File).arrayBuffer());
  if (buf.length === 0) return NextResponse.json({error: 'The file is empty.'}, {status: 400});
  if (buf.length > BULK_MAX_FILE_BYTES)
    return NextResponse.json(
      {error: `File too large (max ${BULK_MAX_FILE_BYTES / 1024 / 1024} MB).`},
      {status: 400},
    );

  let grid: string[][];
  try {
    grid = parseSheet(buf, name);
  } catch (e) {
    if (e instanceof BulkParseError) return NextResponse.json({error: e.message}, {status: 400});
    throw e;
  }
  let sheet;
  try {
    sheet = sheetRowsToRecipients(grid);
  } catch (e) {
    if (e instanceof BulkParseError) return NextResponse.json({error: e.message}, {status: 400});
    throw e;
  }
  const suppressed = await loadSuppressionMap(workspace_id);
  const validation = validateRecipients(sheet.recipients, suppressed);
  if (validation.valid.length > BULK_MAX_RECIPIENTS) {
    return NextResponse.json(
      {
        error: `Too many valid recipients (${validation.valid.length}). The per-campaign cap is ${BULK_MAX_RECIPIENTS} — split the list and send in smaller campaigns.`,
        valid_count: validation.valid.length,
        cap: BULK_MAX_RECIPIENTS,
      },
      {status: 400},
    );
  }
  const knownColumns = ['email', 'name', ...validation.columns];
  const unknownPlaceholders = [
    ...new Set([
      ...findUnknownPlaceholders(subject, knownColumns),
      ...findUnknownPlaceholders(text, knownColumns),
      ...findUnknownPlaceholders(html, knownColumns),
    ]),
  ];
  const monthly = await monthlySendRemaining(workspace_id);
  return NextResponse.json({
    columns: sheet.columns,
    total_rows: validation.totalRows,
    valid_count: validation.valid.length,
    invalid: validation.invalid,
    duplicates_removed: validation.duplicatesRemoved,
    suppressed: validation.suppressed,
    recipients: validation.valid,
    unknown_placeholders: unknownPlaceholders,
    cap: BULK_MAX_RECIPIENTS,
    monthly,
  });
}
