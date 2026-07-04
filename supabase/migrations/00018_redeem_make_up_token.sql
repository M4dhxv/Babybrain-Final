-- BabyBrain — redeem a make-up token against a future session, atomically.
-- Parents can read their tokens but not update them (only the vendor/service
-- role can), so redemption runs through this SECURITY DEFINER function:
--   * validates the token belongs to the caller, is 'issued', not expired;
--   * validates the target session belongs to the token's provider;
--   * creates the booking (normal insert triggers apply → capacity/waitlist);
--   * marks the token redeemed and links the booking.
-- Idempotent to (re)define.

create or replace function public.redeem_make_up_token(p_token_id uuid, p_session_id uuid)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_tok public.make_up_tokens;
  v_provider uuid;
  v_booking_id uuid;
  v_status text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_tok
  from public.make_up_tokens
  where id = p_token_id
    and user_id = v_user
    and status = 'issued'
    and (expires_at is null or expires_at > now());
  if not found then
    raise exception 'This make-up token is not available';
  end if;

  select a.provider_id into v_provider
  from public.activity_sessions s
  join public.activities a on a.id = s.activity_id
  where s.id = p_session_id;
  if v_provider is null or v_provider <> v_tok.provider_id then
    raise exception 'This token can only be used for its provider''s classes';
  end if;

  insert into public.bookings (user_id, session_id, child_id)
  values (v_user, p_session_id, v_tok.child_id)
  returning id, status into v_booking_id, v_status;

  update public.make_up_tokens
  set status = 'redeemed', redeemed_booking_id = v_booking_id
  where id = p_token_id;

  return v_status;
end;
$$;

grant execute on function public.redeem_make_up_token(uuid, uuid) to authenticated;
