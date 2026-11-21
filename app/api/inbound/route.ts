import {NextResponse} from 'next/server';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';

export const runtime = 'nodejs';

const schema = z.object({
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().max(998).optional(),
  text: z.string().max(500000).optional(),
  html: z.string().max(1000000).optional(),
  messageId: z.string().max(998).optional(),
  receivedAt: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const expected = process.env.INBOUND_WEBHOOK_TOKEN || '';
  const supplied = req.headers.get('x-inbound-token') || '';
  if (
    !expected ||
    !supplied ||
    expected.length !== supplied.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  )
    return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid inbound message'}, {status: 400});
  const d = p.data;
  const box = await dbOne(
    'SELECT id, workspace_id, is_active FROM mailboxes WHERE address = ? AND is_active = 1',
    [d.to.toLowerCase()],
  );
  if (!box) return NextResponse.json({error: 'Recipient mailbox not found'}, {status: 404});
  if (d.messageId) {
    const dup = await dbOne('SELECT id FROM messages WHERE mailbox_id = ? AND message_id = ?', [box.id, d.messageId]);
    if (dup) return NextResponse.json({accepted: true, duplicate: true}, {status: 202});
  }
  const now = nowIso();
  try {
    await dbRun(
      `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, message_id, delivery_state, received_at, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
      [
        newId(),
        box.workspace_id,
        box.id,
        d.from,
        d.to.toLowerCase(),
        d.subject || '(No Subject)',
        d.text || '',
        d.html || '',
        d.messageId || null,
        d.receivedAt || now,
        now,
        now,
      ],
    );
  } catch (e) {
    return NextResponse.json({error: 'Could not store inbound message'}, {status: 500});
  }
  const period = new Date().toISOString().slice(0, 7) + '-01';
  await dbRun(
    `INSERT INTO usage_counters (workspace_id, period_start, sent_count, received_count, storage_bytes)
     VALUES (?, ?, 0, 1, 0)
     ON CONFLICT(workspace_id, period_start) DO UPDATE SET received_count = usage_counters.received_count + 1`,
    [box.workspace_id, period],
  );
  return NextResponse.json({accepted: true}, {status: 202});
}
