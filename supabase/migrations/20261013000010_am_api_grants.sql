-- Explicit browser API privileges for ratings and persistent session chat.
-- RLS policies decide which rows are visible; these grants allow the API roles
-- to reach the tables in Supabase projects with restricted default privileges.

revoke all on public.ratings, public.conversations, public.conversation_members, public.messages
  from public, anon, authenticated;

grant select, insert on public.ratings to authenticated;
grant select on public.conversations, public.conversation_members, public.messages to authenticated;
grant insert on public.messages to authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;

grant all on public.ratings, public.conversations, public.conversation_members, public.messages
  to service_role;
