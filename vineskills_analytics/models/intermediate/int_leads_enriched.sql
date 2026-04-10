with stg as (

    select * from {{ ref('stg_leads') }}

),

enriched as (

    select
        stg.*,
        lower(trim(stg.status)) as status_normalized,
        case lower(trim(stg.status))
            when 'contacted' then 'Contacted'
            when 'no_response' then 'No Response'
            when 'demo_completed' then 'Demo Completed'
            when 'proposal_sent' then 'Proposal Sent'
            when 'negotiation' then 'Negotiation'
            when 'pending signature' then 'Pending Signature'
            when 'signed_up' then 'Signed Up'
            when 'rejected' then 'Rejected'
            when 'unqualified' then 'Unqualified'
            else replace(trim(stg.status), '_', ' ')
        end as status_label,
        {{ funnel_stage_rank('lower(trim(stg.status))') }} as funnel_stage_rank,
        coalesce(stg.qualified_flag = {{ var('qualified_flag_value') }}, false) as is_qualified,
        {{ is_qualifying_status_sql('lower(trim(stg.status))') }} as is_qualifying_by_status_rule,
        coalesce(lower(trim(stg.status)) = '{{ var("signed_up_status") }}', false)
            or stg.signed_up_date is not null as is_signed_up,
        coalesce(
            stg.lead_name ilike '%test%'
            or stg.lead_name ilike '%test%',
            false
        ) as is_test_lead,
        case
            when stg.signed_up_date is not null then stg.signed_up_date - stg.created_date
        end as days_to_signup

    from stg

)

select * from enriched
