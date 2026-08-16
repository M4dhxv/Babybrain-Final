-- 00046_smartstart_chinese.sql
--
-- 00043 moved "SMART-START English Preschool Ready Programme" to Early
-- Learning, because that's the row the founder named. The same vendor runs the
-- identical programme in Chinese, which was left in Sensory & Art — a parent
-- filtering for Early Learning would see one and not the other. Same treatment.

update public.activities a
   set category_id = c.id,
       updated_at  = now()
  from public.activity_categories c
 where c.slug = 'early-learning'
   and a.provider_name ilike 'the music scientist'
   and a.title ilike 'SMART-START%Preschool Ready%'
   and a.category_id is distinct from c.id;
