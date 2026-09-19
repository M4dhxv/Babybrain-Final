# Babybrain-Final

## Git and deploys (MUST)

- Never run `git commit`, `git push` or `supabase db push` without explicit confirmation from Aman, in every session.
- Work in batches: finish and verify the changes, list what is uncommitted, and ask whether to bundle it into one commit. Do not commit per task.
- Once confirmed, commit straight to `main` (no feature branch, no PR).
- A push to `main` ships to Production via Vercel, and `supabase db push` applies every pending migration, not just yours. Confirm both before running.
