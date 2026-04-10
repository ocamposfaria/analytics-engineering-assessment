{#
  Visão executiva: volume, qualificação, fechamento e coerência flag × status.
  Camada típica da primeira “seção” do scroll (overview).
#}
with base as (

    select * from {{ ref('int_leads_enriched') }}

),

reporting as (

    select * from base
    where not is_test_lead

),

reporting_kpis as (

    select
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
        ) as signup_rate_among_qualified_pct,
        sum(
            case
                when is_qualified != is_qualifying_by_status_rule then 1
                else 0
            end
        ) as leads_flag_status_mismatch

    from reporting

),

test_counts as (

    select count(*) as test_leads_excluded
    from base
    where is_test_lead

)

select
    reporting_kpis.*,
    test_counts.test_leads_excluded
from reporting_kpis
cross join test_counts
