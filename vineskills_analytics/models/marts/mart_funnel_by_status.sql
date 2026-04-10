{#
  Funil atual por estágio (snapshot): contagens ordenadas para gráfico de funil.
#}
select
    status_label as status,
    status_normalized,
    funnel_stage_rank,
    count(*) as lead_count,
    round(100.0 * count(*) / sum(count(*)) over (), 2) as pct_of_total_leads
from {{ ref('int_leads_enriched') }}
where not is_test_lead
group by status_label, status_normalized, funnel_stage_rank
order by funnel_stage_rank, lead_count desc
