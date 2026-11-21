# WorkMail — Start here

1. Read `COMPLETE-SETUP-GUIDE.md` from beginning to end.
2. Push the repository to GitHub (`raj3kk/workmail`). The repo root **is** the app root — push the whole repo, not a subfolder.
3. Deploy the repository on Vercel (Framework: Next.js, Root Directory: `./`) with the host env vars from the root `.env.example`.
4. Verify every release gate in `COMPLETE-SETUP-GUIDE.md` section J before using real customer mail.

Layout: repo root = app root; docs in `docs/`; D1 schema in `db/` (`db/schema.sql` + `db/seed.sql`, one file); inbound worker in `cloudflare/inbound-email-worker/`.

The code is a beta/pilot foundation, not certified production email hosting. The guide clearly lists what is implemented and what still requires development or verification. No Browser Agent or Computer-Use Agent is included.
