{#
  Oportunidades qualificadas ainda abertas (não assinaram): priorização de follow-up.
#}
select
    lead_id,
    lead_name,
    created_date,
    status,
    agent_name,
    lead_source,
    funnel_stage_rank,
    current_date - created_date as days_since_created
from {{ ref('int_leads_enriched') }}
where not is_test_lead
  and is_qualified
  and not is_signed_up
order by funnel_stage_rank desc, created_date asc
