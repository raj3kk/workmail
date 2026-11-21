import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/guards';
import {listUserWorkspaces} from '@/lib/auth';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaces = await listUserWorkspaces(user.id);
  return NextResponse.json({user: {id: user.id, email: user.email, name: user.name}, workspaces});
}
