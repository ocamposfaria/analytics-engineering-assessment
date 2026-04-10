{#
  Velocidade de fechamento: dias entre criação do lead e assinatura (apenas ganhos).
#}
select
    agent_name,
    lead_source,
    count(*) as signed_deals,
    round(avg(days_to_signup), 2) as avg_days_to_signup,
    round(median(days_to_signup), 2) as median_days_to_signup,
    min(days_to_signup) as min_days_to_signup,
    max(days_to_signup) as max_days_to_signup
from {{ ref('int_leads_enriched') }}
where not is_test_lead
  and is_signed_up
  and days_to_signup is not null
group by grouping sets ((agent_name, lead_source), (agent_name), (lead_source), ())
order by grouping(agent_name, lead_source) desc, signed_deals desc
