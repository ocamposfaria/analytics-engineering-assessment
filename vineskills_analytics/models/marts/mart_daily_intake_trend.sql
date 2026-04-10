{#
  Série temporal de entrada de leads e outcomes (seção “evolução no tempo” no scroll).
#}
select
    created_date,
    count(*) as leads_created,
    sum(case when is_qualified then 1 else 0 end) as qualified_same_day_snapshot,
    sum(case when is_signed_up then 1 else 0 end) as signed_up_leads
from {{ ref('int_leads_enriched') }}
where not is_test_lead
group by created_date
order by created_date
