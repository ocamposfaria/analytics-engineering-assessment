{#
  Mix de qualidade por canal (website, evento, outbound, etc.).
#}
select
    lead_source,
    count(*) as total_leads,
    sum(case when is_qualified then 1 else 0 end) as qualified_leads,
    sum(case when is_signed_up then 1 else 0 end) as signed_up_leads,
    round(100.0 * sum(case when is_qualified then 1 else 0 end) / nullif(count(*), 0), 2)
        as qualification_rate_pct,
    round(100.0 * sum(case when is_signed_up then 1 else 0 end) / nullif(count(*), 0), 2)
        as signup_rate_pct,
    round(
        100.0 * sum(case when is_signed_up then 1 else 0 end)
        / nullif(sum(case when is_qualified then 1 else 0 end), 0),
        2
    ) as signup_rate_among_qualified_pct
from {{ ref('int_leads_enriched') }}
where not is_test_lead
group by lead_source
order by signed_up_leads desc, total_leads desc
