{# Ordem do funil para ordenação em gráficos / scroll narrative #}
{% macro funnel_stage_rank(status_normalized_col) %}
    case {{ status_normalized_col }}
        when 'contacted' then 10
        when 'no_response' then 20
        when 'demo_completed' then 30
        when 'proposal_sent' then 40
        when 'negotiation' then 50
        when 'pending signature' then 60
        when 'signed_up' then 70
        when 'rejected' then 90
        when 'unqualified' then 91
        else 99
    end
{% endmacro %}

{# Status considerados qualificados (espelha regra de negócio do assessment) #}
{% macro qualifying_status_list() %}
    {% set statuses = [
        'demo_completed',
        'negotiation',
        'pending signature',
        'proposal_sent',
        'signed_up',
    ] %}
    {{ return(statuses) }}
{% endmacro %}

{% macro is_qualifying_status_sql(status_expr) %}
    ({{ status_expr }}) in (
        {% for s in qualifying_status_list() -%}
            '{{ s }}'{% if not loop.last %}, {% endif %}
        {%- endfor %}
    )
{% endmacro %}
