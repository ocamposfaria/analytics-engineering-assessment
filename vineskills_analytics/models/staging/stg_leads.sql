with source as (

    select * from {{ ref('raw_leads') }}

),

typed as (

    select
        lead_id,
        lead_name,
        cast(created_date as date) as created_date,
        trim(status) as status,
        qualified_flag,
        case
            when nullif(trim(cast(signed_up_date as varchar)), '') is null then null
            else cast(trim(cast(signed_up_date as varchar)) as date)
        end as signed_up_date,
        trim(agent_name) as agent_name,
        trim(lead_source) as lead_source

    from source

)

select * from typed
