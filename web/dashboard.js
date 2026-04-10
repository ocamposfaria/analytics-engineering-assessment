(function () {
  const d3 = window.d3;
  function normalizeApiBase(base) {
    return String(base || "").trim().replace(/\/+$/, "");
  }

  function resolveApiBase() {
    const configured = normalizeApiBase(window.DASH_API_BASE);
    if (configured) return configured;
    const host = String(window.location.hostname || "").toLowerCase();
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    if (isLocalHost) return "http://127.0.0.1:8000";
    return normalizeApiBase(window.location.origin);
  }

  const API_BASE = resolveApiBase();
  const loader = document.getElementById("page-loader");
  const loaderText = document.getElementById("loader-text");

  let DATA = null;
  let FILTERS = { start_date: "", end_date: "", agent: "", source: "" };
  let SHOULD_ANIMATE_NEXT_RENDER = true;

  function setDashboardRevealPreparing(isPreparing) {
    const main = document.querySelector(".main");
    if (!main) return;
    main.classList.toggle("dash-reveal-prep", Boolean(isPreparing));
  }

  const COLORS = {
    accent: "#7fa94e",
    accentDark: "#3f6a2a",
    muted: "#4f6859",
    ink: "#1f3328",
    line: "#d8e3da",
    pale: "#edf5e8",
  };

  /** Statuses that end the journey without signup (for aggregate reading; not a temporal ordering). */
  const TERMINAL_WITHOUT_SIGNUP = new Set(["no_response", "rejected", "unqualified"]);

  /**
   * Order for "Volume by current state" to mirror the conceptual journey (diagram above):
   * early outreach → pipeline → outcomes, with signed_up and rejected last.
   */
  const FUNNEL_JOURNEY_DISPLAY_ORDER = [
    "contacted",
    "no_response",
    "demo_completed",
    "unqualified",
    "negotiation",
    "proposal_sent",
    "pending signature",
    "signed_up",
    "rejected",
  ];

  function setLoading(isLoading, text) {
    if (loaderText && text) loaderText.textContent = text;
    if (!loader) return;
    loader.classList.toggle("is-hidden", !isLoading);
    document.body.classList.toggle("is-loading", isLoading);
  }

  function pct(v) {
    if (v == null || Number.isNaN(Number(v))) return "0.00%";
    return `${Number(v).toFixed(2)}%`;
  }

  function pct1(v) {
    if (v == null || Number.isNaN(Number(v))) return "0.0%";
    return `${Number(v).toFixed(1)}%`;
  }

  function num(v) {
    if (v == null || Number.isNaN(Number(v))) return "0";
    return Number(v).toLocaleString("en-US");
  }

  function fmtDate(value) {
    if (!value) return "-";
    const raw = String(value).slice(0, 10);
    const dt = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return raw;
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(dt);
  }

  /** White label when the value sits on the colored bar (inline fill beats app.css `svg text { fill: ... }`). */
  function appendOnBarValueText(g, xPos, midY, anchor, fontSize, label) {
    g.append("text")
      .attr("x", xPos)
      .attr("y", midY)
      .attr("text-anchor", anchor)
      .attr("dominant-baseline", "middle")
      .attr("font-size", fontSize)
      .style("fill", "#ffffff")
      .text(label);
  }

  /** Place count/label: after bar (ink), inside bar (white), or flush right (white if it overlaps the bar). */
  function appendHorizontalBarValueLabel(g, midY, barWidth, innerW, label, fontSize) {
    const gap = 6;
    const estW = Math.max(40, label.length * fontSize * 0.62);
    const minInside = estW + gap * 2;
    if (barWidth + gap + estW <= innerW - 2) {
      g.append("text")
        .attr("x", barWidth + gap)
        .attr("y", midY)
        .attr("text-anchor", "start")
        .attr("dominant-baseline", "middle")
        .attr("font-size", fontSize)
        .style("fill", COLORS.ink)
        .text(label);
    } else if (barWidth >= minInside) {
      appendOnBarValueText(g, barWidth - gap, midY, "end", fontSize, label);
    } else {
      const labelRight = innerW - 2;
      const labelLeft = labelRight - estW;
      const overlapsBar = barWidth > labelLeft - gap;
      if (overlapsBar) {
        appendOnBarValueText(g, labelRight, midY, "end", fontSize, label);
      } else {
        g.append("text")
          .attr("x", labelRight)
          .attr("y", midY)
          .attr("text-anchor", "end")
          .attr("dominant-baseline", "middle")
          .attr("font-size", fontSize)
          .style("fill", COLORS.ink)
          .text(label);
      }
    }
  }

  function buildQuery(filters) {
    const q = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v) q.set(k, v);
    });
    return q.toString();
  }

  async function fetchJson(path, filters) {
    const query = buildQuery(filters || {});
    const res = await fetch(`${API_BASE}${path}${query ? `?${query}` : ""}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  function renderHero() {
    const kpi = DATA.mart_kpis_global[0] || {};
    const trend = DATA.mart_daily_intake_trend || [];
    const periodStart = trend.length ? String(trend[0].created_date).slice(0, 10) : "-";
    const periodEnd = trend.length ? String(trend[trend.length - 1].created_date).slice(0, 10) : "-";
    const cards = [
      ["Period", `${fmtDate(periodStart)} – ${fmtDate(periodEnd)}`],
      ["Total leads", num(kpi.total_leads)],
      ["Signed up (total)", num(kpi.signed_up_leads)],
      ["Overall signup rate", pct(kpi.signup_rate_pct)],
    ];
    document.getElementById("hero-kpis").innerHTML = cards
      .map(([label, value]) => `<article class="kpi-card"><p class="kpi-label">${label}</p><p class="kpi-value">${value}</p></article>`)
      .join("");
  }

  function prepareSvg(container, height, margin) {
    const width = Math.max(320, container.clientWidth || 640);
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    container.innerHTML = "";
    const svg = d3.select(container).append("svg").attr("width", width).attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    return { svg, g, innerW, innerH };
  }

  function renderStatusDistribution() {
    const el = document.querySelector('[data-chart="status-distribution"]');
    if (!el) return;
    const rows = [...(DATA.mart_funnel_by_status || [])].sort((a, b) => (b.lead_count || 0) - (a.lead_count || 0));
    const margin = { top: 8, right: 14, bottom: 8, left: 130 };
    const { g, innerW } = prepareSvg(el, Math.max(180, rows.length * 28 + 20), margin);
    const x = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.lead_count) || 1]).range([0, innerW]);

    rows.forEach((d, i) => {
      const y = i * 28;
      const bw = x(d.lead_count);
      g.append("rect")
        .attr("x", 0)
        .attr("y", y)
        .attr("width", bw)
        .attr("height", 20)
        .attr("rx", 4)
        .attr("fill", d.status === "signed_up" ? COLORS.accentDark : COLORS.accent);
      g.append("text").attr("x", -8).attr("y", y + 10).attr("text-anchor", "end").attr("dominant-baseline", "middle").attr("font-size", 12).text(d.status);
      appendHorizontalBarValueLabel(g, y + 10, bw, innerW, `${num(d.lead_count)} (${pct(d.pct_of_total_leads)})`, 11);
    });
  }

  function renderQualificationSplit() {
    const el = document.querySelector('[data-chart="qualification-split"]');
    if (!el) return;
    const k = DATA.mart_kpis_global[0] || {};
    const qual = Number(k.qualified_leads || 0);
    const total = Number(k.total_leads || 0);
    const nqual = Math.max(0, total - qual);
    const data = [
      { label: "Qualified", value: qual, color: COLORS.accentDark },
      { label: "Not qualified", value: nqual, color: COLORS.pale },
    ];

    const margin = { top: 8, right: 8, bottom: 20, left: 8 };
    const { g, innerW, innerH } = prepareSvg(el, 220, margin);
    const radius = Math.min(innerW, innerH) / 2 - 10;
    const pie = d3.pie().value((d) => d.value)(data);
    const arc = d3.arc().innerRadius(radius * 0.58).outerRadius(radius);
    const labelArc = d3.arc().innerRadius(radius * 0.62).outerRadius(radius * 0.96);
    const qualPct = total > 0 ? (100 * qual) / total : 0;
    const center = g.append("g").attr("transform", `translate(${innerW / 2},${innerH / 2})`);
    center
      .selectAll("path")
      .data(pie)
      .join("path")
      .attr("d", arc)
      .attr("fill", (d) => d.data.color)
      .attr("stroke", "#fff")
      .attr("stroke-width", 2);
    center.append("text").attr("text-anchor", "middle").attr("y", -8).attr("font-size", 11).style("fill", COLORS.muted).text("Qualified");
    center
      .append("text")
      .attr("text-anchor", "middle")
      .attr("y", 14)
      .attr("font-size", 18)
      .attr("font-weight", 700)
      .style("fill", COLORS.accentDark)
      .text(pct1(qualPct));
    center
      .selectAll("text.qual-arc-count")
      .data(pie)
      .join("text")
      .attr("class", "qual-arc-count")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", 10)
      .attr("font-weight", 700)
      .attr("transform", (d) => {
        let [cx, cy] = labelArc.centroid(d);
        if (Math.hypot(cx, cy) < radius * 0.2) {
          const mid = (d.startAngle + d.endAngle) / 2;
          const r = radius * 0.79;
          cx = Math.sin(mid) * r;
          cy = -Math.cos(mid) * r;
        }
        return `translate(${cx},${cy})`;
      })
      .style("fill", (d) => (d.data.label === "Qualified" ? "#ffffff" : COLORS.muted))
      .text((d) => (d.data.value > 0 ? num(d.data.value) : ""));
  }

  function renderVolumeComparison() {
    const el = document.querySelector('[data-chart="volume-comparison"]');
    if (!el) return;
    const topAgents = [...(DATA.mart_conversion_by_agent || [])].sort((a, b) => b.total_leads - a.total_leads).slice(0, 5);
    const topSources = [...(DATA.mart_conversion_by_source || [])].sort((a, b) => b.total_leads - a.total_leads).slice(0, 5);
    const rows = [
      ...topAgents.map((d) => ({ label: `Ag: ${d.agent_name}`, value: d.total_leads, kind: "agent" })),
      ...topSources.map((d) => ({ label: `Src: ${d.lead_source}`, value: d.total_leads, kind: "source" })),
    ];
    const margin = { top: 8, right: 14, bottom: 18, left: 125 };
    const { g, innerW } = prepareSvg(el, Math.max(220, rows.length * 24 + 20), margin);
    const x = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.value) || 1]).range([0, innerW]);
    rows.forEach((d, i) => {
      const y = i * 24;
      const bw = x(d.value);
      g.append("rect").attr("x", 0).attr("y", y).attr("width", bw).attr("height", 17).attr("rx", 4).attr("fill", d.kind === "agent" ? COLORS.accent : COLORS.accentDark);
      g.append("text").attr("x", -8).attr("y", y + 8.5).attr("text-anchor", "end").attr("dominant-baseline", "middle").attr("font-size", 11).text(d.label);
      appendHorizontalBarValueLabel(g, y + 8.5, bw, innerW, num(d.value), 11);
    });
  }

  function parseDate(v) {
    return d3.timeParse("%Y-%m-%d")(String(v).slice(0, 10));
  }

  /**
   * API returns only days with ≥1 lead; expand to every calendar day in range so rolling windows are correct.
   */
  function densifyDailyIntake(sortedRows) {
    if (!sortedRows.length) return [];
    const byKey = new Map(sortedRows.map((d) => [d3.timeDay(d.dt).getTime(), d]));
    const [start, end] = d3.extent(sortedRows, (d) => d.dt);
    let cur = d3.timeDay(start);
    const endDay = d3.timeDay(end);
    const dense = [];
    while (cur <= endDay) {
      const k = cur.getTime();
      const row = byKey.get(k);
      dense.push({
        dt: new Date(cur),
        leads_created: row ? row.leads_created : 0,
        signed_up_leads: row ? row.signed_up_leads : 0,
      });
      cur = d3.timeDay.offset(cur, 1);
    }
    return dense;
  }

  function renderIntakeTrend() {
    const el = document.querySelector('[data-chart="intake-trend"]');
    if (!el) return;
    const raw = (DATA.mart_daily_intake_trend || [])
      .map((d) => ({
        dt: parseDate(d.created_date),
        leads_created: Number(d.leads_created || 0),
        signed_up_leads: Number(d.signed_up_leads || 0),
      }))
      .filter((d) => d.dt);
    raw.sort((a, b) => a.dt - b.dt);
    const margin = { top: 8, right: 12, bottom: 26, left: 40 };
    if (!raw.length) {
      prepareSvg(el, 140, margin);
      return;
    }
    const dense = densifyDailyIntake(raw);
    const rollDays = 7;
    dense.forEach((d, i) => {
      const lo = Math.max(0, i - rollDays + 1);
      let s = 0;
      for (let j = lo; j <= i; j++) s += dense[j].leads_created;
      d.ma7 = s / (i - lo + 1);
    });

    const { g, innerW, innerH } = prepareSvg(el, 248, margin);

    const x = d3.scaleTime().domain(d3.extent(dense, (d) => d.dt)).range([0, innerW]);
    const yMax = Math.max(d3.max(dense, (d) => d.leads_created) || 0, d3.max(dense, (d) => d.ma7) || 0, 1);
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

    g.selectAll("rect.intake-daily")
      .data(dense)
      .join("rect")
      .attr("class", "intake-daily")
      .attr("x", (d) => x(d.dt))
      .attr("y", (d) => y(d.leads_created))
      .attr("width", (d) => Math.max(1, x(d3.timeDay.offset(d.dt, 1)) - x(d.dt) - 1))
      .attr("height", (d) => Math.max(0, innerH - y(d.leads_created)))
      .attr("fill", COLORS.line)
      .attr("opacity", 0.9);

    const lineMa = d3
      .line()
      .x((d) => x(d.dt))
      .y((d) => y(d.ma7))
      .curve(d3.curveMonotoneX);
    g.append("path")
      .datum(dense)
      .attr("fill", "none")
      .attr("stroke", COLORS.accentDark)
      .attr("stroke-width", 2.5)
      .attr("d", lineMa);

    g.append("g").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x).ticks(5).tickFormat(d3.timeFormat("%b '%y")));
    g.append("g").call(d3.axisLeft(y).ticks(4));
  }

  function buildStatusSnapshotChain() {
    const rows = [...(DATA.mart_funnel_by_status || [])];
    const sortKey = (row) => {
      const n = String(row.status_normalized || row.status || "").toLowerCase();
      const idx = FUNNEL_JOURNEY_DISPLAY_ORDER.indexOf(n);
      if (idx !== -1) return idx;
      return 100 + Number(row.funnel_stage_rank ?? 99);
    };
    rows.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return (Number(b.lead_count) || 0) - (Number(a.lead_count) || 0);
    });
    return rows.map((d) => ({
      status: d.status,
      count: Number(d.lead_count || 0),
      pct: Number(d.pct_of_total_leads || 0),
      normalized: String(d.status_normalized || d.status || "").toLowerCase(),
    }));
  }

  function terminalWithoutSignupSharePct(chain) {
    let p = 0;
    chain.forEach((d) => {
      if (TERMINAL_WITHOUT_SIGNUP.has(d.normalized)) p += d.pct;
    });
    return p;
  }

  function renderFunnelMain() {
    const el = document.querySelector('[data-chart="funnel-main"]');
    if (!el) return;
    const chain = buildStatusSnapshotChain();
    const margin = { top: 10, right: 20, bottom: 20, left: 120 };
    const { g, innerW } = prepareSvg(el, Math.max(240, chain.length * 30 + 20), margin);
    const x = d3.scaleLinear().domain([0, d3.max(chain, (d) => d.count) || 1]).range([0, innerW]);
    chain.forEach((d, i) => {
      const y = i * 30;
      const bw = x(d.count);
      g.append("rect").attr("x", 0).attr("y", y).attr("width", bw).attr("height", 21).attr("rx", 4).attr("fill", d.normalized === "signed_up" ? COLORS.accentDark : COLORS.accent);
      g.append("text").attr("x", -8).attr("y", y + 10.5).attr("text-anchor", "end").attr("dominant-baseline", "middle").attr("font-size", 12).text(d.status);
      appendHorizontalBarValueLabel(g, y + 10.5, bw, innerW, `${num(d.count)} (${pct(d.pct)})`, 11);
    });

    const diag = document.getElementById("funnel-diagnostics");
    const topBucket = chain.slice().sort((a, b) => b.count - a.count)[0] || null;
    const terminalShare = terminalWithoutSignupSharePct(chain);
    const signup = DATA.mart_kpis_global[0]?.signup_rate_pct || 0;
    diag.innerHTML = `
      <p><strong>How to read this:</strong></p>
      <ul>
        <li>These counts are a <strong>snapshot</strong>: each lead is counted once in its current state. Bars are not sequential steps along the same journey.</li>
        <li>State with the most leads right now: <strong>${topBucket ? topBucket.status : "—"}</strong> (${topBucket ? `${num(topBucket.count)} | ${pct(topBucket.pct)} of total` : "no data"}).</li>
        <li>Share ending without signup (no response / rejected / unqualified): <strong>${pct(terminalShare)}</strong> of all leads.</li>
        <li>Conversion rate (signed_up over all leads): <strong>${pct(signup)}</strong>.</li>
      </ul>
    `;
  }

  function renderPerformanceBars(selector, rows, labelKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    const data = [...rows].sort((a, b) => (b.signup_rate_pct || 0) - (a.signup_rate_pct || 0));
    const margin = { top: 26, right: 10, bottom: 72, left: 34 };
    const { g, innerW, innerH } = prepareSvg(el, 260, margin);
    const x0 = d3.scaleBand().domain(data.map((d) => d[labelKey])).range([0, innerW]).padding(0.18);
    const x1 = d3.scaleBand().domain(["qualification_rate_pct", "signup_rate_pct"]).range([0, x0.bandwidth()]).padding(0.12);
    const y = d3.scaleLinear().domain([0, 100]).range([innerH, 0]);
    const labelAbove = (value) => y(value) - 6;
    g.append("g").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x0)).selectAll("text").attr("transform", "rotate(-28)").style("text-anchor", "end").attr("font-size", 11);
    g.append("g").call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d}%`));
    const barPairs = (d) => [
      { key: "qualification_rate_pct", value: d.qualification_rate_pct || 0 },
      { key: "signup_rate_pct", value: d.signup_rate_pct || 0 },
    ];
    const cluster = g
      .selectAll(".cluster")
      .data(data)
      .join("g")
      .attr("class", "cluster")
      .attr("transform", (d) => `translate(${x0(d[labelKey])},0)`);
    cluster
      .selectAll("rect")
      .data(barPairs)
      .join("rect")
      .attr("x", (d) => x1(d.key))
      .attr("y", (d) => y(d.value))
      .attr("width", x1.bandwidth())
      .attr("height", (d) => innerH - y(d.value))
      .attr("fill", (d) => (d.key === "signup_rate_pct" ? COLORS.accentDark : COLORS.accent));
    cluster
      .selectAll("text.perf-bar-label")
      .data(barPairs)
      .join("text")
      .attr("class", "perf-bar-label")
      .attr("x", (d) => x1(d.key) + x1.bandwidth() / 2)
      .attr("y", (d) => labelAbove(d.value))
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "alphabetic")
      .attr("font-size", Math.min(10, Math.max(7, x1.bandwidth() / 2.2)))
      .style("fill", COLORS.ink)
      .text((d) => pct1(d.value));
  }

  function renderHeatmap() {
    const el = document.querySelector('[data-chart="agent-source-heatmap"]');
    if (!el) return;
    const rows = DATA.mart_conversion_by_agent_source || [];
    const agents = [...new Set(rows.map((d) => d.agent_name))];
    const sources = [...new Set(rows.map((d) => d.lead_source))];
    const margin = { top: 34, right: 8, bottom: 10, left: 110 };
    const height = Math.max(200, agents.length * 32 + margin.top + margin.bottom);
    const { svg, g, innerW } = prepareSvg(el, height, margin);
    const cellW = Math.max(44, Math.floor(innerW / Math.max(1, sources.length)));
    const cellH = 24;
    const map = new Map(rows.map((d) => [`${d.agent_name}|${d.lead_source}`, d]));
    const maxRate = d3.max(rows, (d) => Number(d.signup_rate_pct || 0)) || 1;
    const color = d3.scaleSequential(d3.interpolateRgb("#edf5e8", "#3f6a2a")).domain([0, Math.max(15, maxRate)]);

    sources.forEach((s, j) => {
      svg.append("text").attr("x", margin.left + j * cellW + cellW / 2).attr("y", 12).attr("text-anchor", "middle").attr("font-size", 10).text(s);
    });
    agents.forEach((a, i) => {
      svg.append("text").attr("x", margin.left - 8).attr("y", margin.top + i * (cellH + 6) + cellH / 2).attr("text-anchor", "end").attr("dominant-baseline", "middle").attr("font-size", 10).text(a);
    });
    agents.forEach((a, i) => {
      sources.forEach((s, j) => {
        const d = map.get(`${a}|${s}`);
        const rate = Number(d?.signup_rate_pct || 0);
        const total = Number(d?.total_leads || 0);
        g.append("rect")
          .attr("x", j * cellW)
          .attr("y", i * (cellH + 6))
          .attr("width", cellW - 4)
          .attr("height", cellH)
          .attr("rx", 4)
          .attr("fill", total > 0 ? color(rate) : "#f2f2f2")
          .attr("stroke", COLORS.line);
        if (total > 0) {
          g.append("text")
            .attr("x", j * cellW + (cellW - 4) / 2)
            .attr("y", i * (cellH + 6) + cellH / 2)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .attr("font-size", 12)
            .style("fill", rate > maxRate / 2 ? "#ffffff" : COLORS.ink)
            .text(num(total));
        }
      });
    });
  }

  function renderConversionTrend() {
    const el = document.querySelector('[data-chart="conversion-trend"]');
    if (!el) return;
    const raw = (DATA.mart_daily_intake_trend || [])
      .map((d) => ({
        dt: parseDate(d.created_date),
        leads_created: Number(d.leads_created || 0),
        signed_up_leads: Number(d.signed_up_leads || 0),
      }))
      .filter((d) => d.dt);
    raw.sort((a, b) => a.dt - b.dt);
    const margin = { top: 10, right: 14, bottom: 26, left: 42 };
    if (!raw.length) {
      prepareSvg(el, 140, margin);
      return;
    }
    const dense = densifyDailyIntake(raw);
    const winDays = 28;
    const minLeadsInWindow = 15;
    dense.forEach((d, i) => {
      const lo = Math.max(0, i - winDays + 1);
      let c = 0;
      let s = 0;
      for (let j = lo; j <= i; j++) {
        c += dense[j].leads_created;
        s += dense[j].signed_up_leads;
      }
      d.conv28 = c >= minLeadsInWindow ? (s / c) * 100 : null;
    });

    const { g, innerW, innerH } = prepareSvg(el, 268, margin);
    const x = d3.scaleTime().domain(d3.extent(dense, (d) => d.dt)).range([0, innerW]);
    const rates = dense.map((d) => d.conv28).filter((v) => v != null);
    const k = DATA.mart_kpis_global[0];
    const overall = k != null ? Number(k.signup_rate_pct) : null;
    const overallOk = overall != null && !Number.isNaN(overall);
    let y0;
    let y1;
    if (!rates.length) {
      y0 = 0;
      y1 = 100;
    } else {
      const loR = d3.min(rates);
      const hiR = d3.max(rates);
      const pad = Math.max(3, (hiR - loR) * 0.12);
      y0 = Math.max(0, loR - pad);
      y1 = Math.min(100, hiR + pad);
      if (overallOk) {
        y0 = Math.min(y0, overall);
        y1 = Math.max(y1, overall);
      }
    }
    const y = d3.scaleLinear().domain([y0, y1]).nice().range([innerH, 0]);

    const line = d3
      .line()
      .defined((d) => d.conv28 != null)
      .x((d) => x(d.dt))
      .y((d) => y(d.conv28))
      .curve(d3.curveMonotoneX);
    g.append("path").datum(dense).attr("fill", "none").attr("stroke", COLORS.accentDark).attr("stroke-width", 2.5).attr("d", line);

    g.append("g").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat("%b '%y")));
    g.append("g").call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${d}%`));

    if (overallOk) {
      g.append("line")
        .attr("x1", 0)
        .attr("x2", innerW)
        .attr("y1", y(overall))
        .attr("y2", y(overall))
        .attr("stroke", COLORS.accent)
        .attr("stroke-dasharray", "5 4")
        .attr("stroke-opacity", 0.85);
      g.append("text")
        .attr("x", innerW)
        .attr("y", y(overall) - 4)
        .attr("text-anchor", "end")
        .attr("font-size", 10)
        .style("fill", COLORS.muted)
        .text(`Overall ${pct1(overall)}`);
    }
  }

  function renderInsights() {
    const box = document.getElementById("insights-box");
    if (!box) return;
    const k = DATA.mart_kpis_global[0] || {};
    const bestAgent = [...(DATA.mart_conversion_by_agent || [])].sort((a, b) => (b.signup_rate_pct || 0) - (a.signup_rate_pct || 0))[0];
    const bestSource = [...(DATA.mart_conversion_by_source || [])].sort((a, b) => (b.signup_rate_pct || 0) - (a.signup_rate_pct || 0))[0];
    const chain = buildStatusSnapshotChain();
    const terminalShare = terminalWithoutSignupSharePct(chain);

    box.innerHTML = `
      <h3>Executive summary</h3>
      <p>Key findings</p>
      <ul>
        <li>Overall signup rate is <strong>${pct(k.signup_rate_pct)}</strong> across ${num(k.total_leads)} leads in this view.</li>
        <li>Top agent by signup rate: <strong>${bestAgent?.agent_name || "—"}</strong> (${pct(bestAgent?.signup_rate_pct || 0)}).</li>
        <li>Top source by signup rate: <strong>${bestSource?.lead_source || "—"}</strong> (${pct(bestSource?.signup_rate_pct || 0)}).</li>
        <li>Leads in terminal outcomes without signup (no response / rejected / unqualified): <strong>${pct(terminalShare)}</strong> of the filtered total.</li>
      </ul>
      <p style="margin-top:0.7rem">Recommended actions</p>
      <ul>
        <li>Scale practices from the highest-performing agent across the team.</li>
        <li>Review low-volume, low-signup sources for quality and fit.</li>
      </ul>
      <p style="margin-top:0.7rem">Next steps: weekly cohorts, time-in-stage, and follow-up SLAs.</p>
    `;
  }

  function renderAll() {
    renderHero();
    renderStatusDistribution();
    renderQualificationSplit();
    renderVolumeComparison();
    renderIntakeTrend();
    renderFunnelMain();
    renderPerformanceBars('[data-chart="agent-performance"]', DATA.mart_conversion_by_agent || [], "agent_name");
    renderPerformanceBars('[data-chart="source-performance"]', DATA.mart_conversion_by_source || [], "lead_source");
    renderHeatmap();
    renderConversionTrend();
    renderInsights();
    if (SHOULD_ANIMATE_NEXT_RENDER) animateDashboardCards();
    SHOULD_ANIMATE_NEXT_RENDER = false;
  }

  function animateDashboardCards() {
    const items = Array.from(
      new Set([
        ...document.querySelectorAll(".main .section"),
        ...document.querySelectorAll(".main .section .card"),
      ])
    );
    if (!items.length) return;
    const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDashboardRevealPreparing(false);
      return;
    }
    items.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translate3d(0, 36px, 0) scale(0.98)";
      el.style.filter = "blur(3px)";
    });
    requestAnimationFrame(() => {
    setDashboardRevealPreparing(false);
    items.forEach((el, idx) => {
      const delay = Math.min(idx * 75, 1200);
      const anim = el.animate(
        [
          { opacity: 0, transform: "translate3d(0, 36px, 0) scale(0.98)", filter: "blur(3px)" },
          { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)", filter: "blur(0px)" },
        ],
        {
          duration: 950,
          delay,
          easing: "cubic-bezier(0.18, 0.8, 0.25, 1)",
          fill: "both",
        }
      );
      anim.onfinish = () => {
        el.style.opacity = "";
        el.style.transform = "";
        el.style.filter = "";
      };
    });
    });
  }

  function initReadingProgress() {
    const bar = document.getElementById("reading-progress-bar");
    if (!bar) return;
    const update = () => {
      const scrollTop = window.scrollY || window.pageYOffset || 0;
      const doc = document.documentElement;
      const scrollable = Math.max(1, doc.scrollHeight - window.innerHeight);
      const pctRead = Math.max(0, Math.min(100, (scrollTop / scrollable) * 100));
      bar.style.width = `${pctRead}%`;
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
  }

  function bindFilters(options) {
    const start = document.getElementById("f-start");
    const end = document.getElementById("f-end");
    const agent = document.getElementById("f-agent");
    const source = document.getElementById("f-source");
    if (!start || !end || !agent || !source) return;
    start.min = String(options.min_date || "").slice(0, 10);
    start.max = String(options.max_date || "").slice(0, 10);
    end.min = start.min;
    end.max = start.max;

    (options.agents || []).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      agent.appendChild(opt);
    });
    (options.sources || []).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      source.appendChild(opt);
    });

    document.getElementById("f-apply").addEventListener("click", async () => {
      FILTERS = {
        start_date: start.value,
        end_date: end.value,
        agent: agent.value,
        source: source.value,
      };
      await refresh();
    });
    document.getElementById("f-reset").addEventListener("click", async () => {
      start.value = "";
      end.value = "";
      agent.value = "";
      source.value = "";
      FILTERS = { start_date: "", end_date: "", agent: "", source: "" };
      await refresh();
    });
  }

  async function refresh() {
    setLoading(false);
    SHOULD_ANIMATE_NEXT_RENDER = true;
    setDashboardRevealPreparing(true);
    try {
      DATA = await fetchJson("/api/dashboard", FILTERS);
      renderAll();
    } catch (err) {
      const insights = document.getElementById("insights-box");
      if (insights) {
        insights.innerHTML = `<p>Failed to load data from <code>${API_BASE}</code>: ${err.message}</p>`;
      }
    } finally {
      if (!SHOULD_ANIMATE_NEXT_RENDER) {
        // renderAll ran and animation handler will clear prep mode.
      } else {
        setDashboardRevealPreparing(false);
      }
      setLoading(false);
    }
  }

  async function boot() {
    if (!d3) return;
    initReadingProgress();
    setLoading(false);
    setDashboardRevealPreparing(true);
    try {
      const options = await fetchJson("/api/filter-options");
      bindFilters(options);
      await refresh();
    } catch (err) {
      setLoading(false);
      setDashboardRevealPreparing(false);
      const insights = document.getElementById("insights-box");
      if (insights) insights.innerHTML = `<p>Initialization failed: ${err.message}</p>`;
    }
  }

  window.addEventListener("resize", () => {
    clearTimeout(window.__dashResize);
    window.__dashResize = setTimeout(() => {
      if (DATA) renderAll();
    }, 120);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /** Data assistant: OpenAI + DuckDB via /api/assistant; history in SQLite on the server. */
  function initAssistantChatWidget() {
    const root = document.getElementById("ai-chat-widget");
    const launcher = document.getElementById("ai-chat-launcher");
    const panel = document.getElementById("ai-chat-panel");
    const closeBtn = document.getElementById("ai-chat-close");
    const maximizeBtn = document.getElementById("ai-chat-maximize");
    const form = document.getElementById("ai-chat-form");
    const input = document.getElementById("ai-chat-input");
    const messagesEl = document.getElementById("ai-chat-messages");
    const sendBtn = form && form.querySelector('button[type="submit"]');
    if (!root || !launcher || !panel || !closeBtn || !maximizeBtn || !form || !input || !messagesEl) return;

    const ASSISTANT_SESSION_KEY = "vineskills_assistant_conversation_id";
    root.dataset.size = root.dataset.size || "normal";
    let panelCloseTimer = null;
    let conversationHydrated = false;

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderInlineMarkdown(text) {
      let out = escapeHtml(text);
      out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
      out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return out;
    }

    function parseMarkdownTable(lines, start) {
      const table = [];
      let i = start;
      while (i < lines.length && /\|/.test(lines[i])) {
        table.push(lines[i]);
        i += 1;
      }
      if (table.length < 2) return null;
      const sep = table[1].trim();
      // Accept common markdown separator styles like:
      // | --- | --- |, ---|---, |:---|---:|
      if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(sep)) return null;
      const splitCells = (line) =>
        line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitCells(table[0]);
      const bodyRows = table.slice(2).map(splitCells).filter((row) => row.length > 0);
      const html =
        '<div class="ai-chat-table-wrap"><table><thead><tr>' +
        headers.map((h) => `<th>${renderInlineMarkdown(h)}</th>`).join("") +
        "</tr></thead><tbody>" +
        bodyRows
          .map((row) => `<tr>${row.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join("")}</tr>`)
          .join("") +
        "</tbody></table></div>";
      return { html, next: i };
    }

    function renderMarkdown(text) {
      const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
      const chunks = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
          i += 1;
          continue;
        }
        if (/^```/.test(trimmed)) {
          const codeLines = [];
          i += 1;
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            codeLines.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1;
          // Some model replies wrap markdown tables in code fences.
          // If the fenced content is actually a table, render it as table.
          const maybeTable = parseMarkdownTable(codeLines, 0);
          if (maybeTable && maybeTable.next === codeLines.length) {
            chunks.push(maybeTable.html);
            continue;
          }
          chunks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
          continue;
        }
        const table = parseMarkdownTable(lines, i);
        if (table) {
          chunks.push(table.html);
          i = table.next;
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const lvl = Math.min(6, heading[1].length);
          chunks.push(`<h${lvl}>${renderInlineMarkdown(heading[2].trim())}</h${lvl}>`);
          i += 1;
          continue;
        }
        if (/^>\s+/.test(trimmed)) {
          const quote = [];
          while (i < lines.length && /^>\s+/.test(lines[i].trim())) {
            quote.push(lines[i].trim().replace(/^>\s+/, ""));
            i += 1;
          }
          chunks.push(`<blockquote>${quote.map((q) => renderInlineMarkdown(q)).join("<br>")}</blockquote>`);
          continue;
        }
        if (/^[-*]\s+/.test(trimmed)) {
          const items = [];
          while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
            i += 1;
          }
          chunks.push(`<ul>${items.map((it) => `<li>${renderInlineMarkdown(it)}</li>`).join("")}</ul>`);
          continue;
        }
        if (/^\d+\.\s+/.test(trimmed)) {
          const items = [];
          while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
            i += 1;
          }
          chunks.push(`<ol>${items.map((it) => `<li>${renderInlineMarkdown(it)}</li>`).join("")}</ol>`);
          continue;
        }

        const para = [line];
        i += 1;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (!t || /^```/.test(t) || /^(#{1,6})\s+/.test(lines[i]) || /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t) || /^>\s+/.test(t)) break;
          if (i + 1 < lines.length && /\|/.test(lines[i]) && /^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(lines[i + 1].trim())) break;
          para.push(lines[i]);
          i += 1;
        }
        chunks.push(`<p>${renderInlineMarkdown(para.join(" ")).replace(/ {2,}/g, " ").trim()}</p>`);
      }
      return chunks.join("");
    }

    function appendBubble(role, text) {
      const wrap = document.createElement("div");
      wrap.className = `ai-chat-bubble ai-chat-bubble--${role}`;
      const meta = document.createElement("span");
      meta.className = "ai-chat-bubble-meta";
      meta.textContent = role === "user" ? "You" : "Assistant";
      const body = document.createElement("div");
      body.className = "ai-chat-bubble-body";
      body.textContent = text;
      wrap.appendChild(body);
      wrap.appendChild(meta);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /** Assistant reply with optional collapsible SQL blocks (tool_runs from API). */
    function appendAssistantBubble(text, toolRuns) {
      const runs = Array.isArray(toolRuns) ? toolRuns.filter((r) => r && (r.sql || r.sql_preview)) : [];
      const wrap = document.createElement("div");
      wrap.className = "ai-chat-bubble ai-chat-bubble--bot";
      const body = document.createElement("div");
      body.className = "ai-chat-bubble-body ai-chat-bubble-body--markdown";
      body.innerHTML = renderMarkdown(text);
      wrap.appendChild(body);

      if (runs.length > 0) {
        const stack = document.createElement("div");
        stack.className = "ai-chat-sql-stack";
        runs.forEach((run, i) => {
          const sqlText = (run.sql && String(run.sql).trim()) || String(run.sql_preview || "").trim() || "—";
          const ok = run.ok !== false && !run.error;
          const status = ok ? "ok" : "err";
          const labelN = runs.length > 1 ? ` ${i + 1}` : "";
          const summaryLine = ok
            ? `SQL query${labelN} (${run.row_count != null ? `${run.row_count} rows` : "executed"})`
            : `SQL query${labelN} (failed)`;

          const det = document.createElement("details");
          det.className = `ai-chat-sql-details ai-chat-sql-details--${status}`;

          const sum = document.createElement("summary");
          sum.className = "ai-chat-sql-summary";
          sum.textContent = summaryLine;

          const pre = document.createElement("pre");
          pre.className = "ai-chat-sql-pre";
          const code = document.createElement("code");
          code.className = "language-sql";
          code.textContent = sqlText;
          pre.appendChild(code);
          det.appendChild(sum);
          det.appendChild(pre);
          stack.appendChild(det);
        });
        wrap.appendChild(stack);
      }

      const meta = document.createElement("span");
      meta.className = "ai-chat-bubble-meta";
      meta.textContent = "Assistant";
      wrap.appendChild(meta);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function formatFetchError(res, text) {
      try {
        const d = JSON.parse(text);
        if (typeof d.detail === "string") return d.detail;
        if (Array.isArray(d.detail))
          return d.detail.map((x) => (x.msg ? x.msg : JSON.stringify(x))).join("; ");
      } catch (_) {
        /* ignore */
      }
      return text || `API ${res.status}`;
    }

    async function assistantFetch(path, opts) {
      const init = {
        method: opts.method || "GET",
        headers: { ...(opts.headers || {}) },
      };
      if (opts.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      let res;
      try {
        res = await fetch(`${API_BASE}${path}`, init);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Network error calling ${API_BASE}${path}: ${msg}`);
      }
      const text = await res.text();
      if (!res.ok) throw new Error(formatFetchError(res, text));
      return text ? JSON.parse(text) : {};
    }

    function getStoredConversationId() {
      try {
        return localStorage.getItem(ASSISTANT_SESSION_KEY) || "";
      } catch (_) {
        return "";
      }
    }

    function setStoredConversationId(id) {
      try {
        if (id) localStorage.setItem(ASSISTANT_SESSION_KEY, id);
        else localStorage.removeItem(ASSISTANT_SESSION_KEY);
      } catch (_) {
        /* ignore */
      }
    }

    async function ensureConversation() {
      let id = getStoredConversationId();
      if (id) return id;
      const data = await assistantFetch("/api/assistant/sessions", { method: "POST", body: {} });
      id = data.conversation_id;
      if (!id) throw new Error("No conversation_id from server");
      setStoredConversationId(id);
      return id;
    }

    async function loadConversationIntoPanel() {
      messagesEl.innerHTML = "";
      const id = getStoredConversationId();
      const welcome =
        "Hello! I'm your AI assistant. Ask about leads, funnel stages, agents, and sources. Answers use live SQL on the dashboard database.";
      if (!id) {
        appendBubble("bot", welcome);
        conversationHydrated = true;
        return;
      }
      try {
        const data = await assistantFetch(`/api/assistant/sessions/${encodeURIComponent(id)}/messages`);
        const list = data.messages || [];
        if (list.length === 0) appendBubble("bot", welcome);
        else {
          list.forEach((m) => {
            if (m.role === "user") appendBubble("user", m.content);
            else if (m.role === "assistant") appendAssistantBubble(m.content, m.tool_runs || []);
            else appendBubble("bot", m.content);
          });
        }
        conversationHydrated = true;
      } catch (_) {
        setStoredConversationId("");
        appendBubble("bot", welcome);
        conversationHydrated = true;
      }
    }

    function updateMaximizeButtonUi() {
      const isMax = root.dataset.size === "max";
      maximizeBtn.setAttribute("aria-label", isMax ? "Restore chat size" : "Maximize chat");
      maximizeBtn.title = isMax ? "Restore size" : "Maximize";
    }

    function toggleMaximized() {
      root.dataset.size = root.dataset.size === "max" ? "normal" : "max";
      updateMaximizeButtonUi();
    }

    async function openPanel() {
      if (panelCloseTimer) {
        clearTimeout(panelCloseTimer);
        panelCloseTimer = null;
      }
      panel.hidden = false;
      requestAnimationFrame(() => {
        root.dataset.state = "open";
      });
      launcher.setAttribute("aria-expanded", "true");
      if (!conversationHydrated) await loadConversationIntoPanel();
      input.focus();
    }

    function closePanel() {
      root.dataset.state = "closing";
      launcher.setAttribute("aria-expanded", "false");
      panelCloseTimer = setTimeout(() => {
        panel.hidden = true;
        root.dataset.state = "minimized";
        panelCloseTimer = null;
      }, 280);
      launcher.focus();
    }

    let sending = false;
    let typingBubbleEl = null;

    function showTypingIndicator() {
      if (typingBubbleEl) return;
      const wrap = document.createElement("div");
      wrap.className = "ai-chat-bubble ai-chat-bubble--bot ai-chat-bubble--typing";

      const body = document.createElement("div");
      body.className = "ai-chat-bubble-body";
      body.innerHTML = `
        <span class="ai-chat-typing" aria-label="Assistant is typing" role="status">
          <span class="ai-chat-typing-dot"></span>
          <span class="ai-chat-typing-dot"></span>
          <span class="ai-chat-typing-dot"></span>
        </span>
      `;
      wrap.appendChild(body);

      const meta = document.createElement("span");
      meta.className = "ai-chat-bubble-meta";
      meta.textContent = "Assistant";
      wrap.appendChild(meta);

      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      typingBubbleEl = wrap;
    }

    function hideTypingIndicator() {
      if (!typingBubbleEl) return;
      typingBubbleEl.remove();
      typingBubbleEl = null;
    }

    launcher.addEventListener("click", () => {
      openPanel();
    });
    closeBtn.addEventListener("click", () => closePanel());
    maximizeBtn.addEventListener("click", () => toggleMaximized());
    updateMaximizeButtonUi();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (sending) return;
      const text = input.value.trim();
      if (!text) return;
      sending = true;
      if (sendBtn) sendBtn.disabled = true;
      appendBubble("user", text);
      showTypingIndicator();
      input.value = "";
      input.style.height = "";
      try {
        const cid = await ensureConversation();
        const body = {
          message: text,
          start_date: FILTERS.start_date || null,
          end_date: FILTERS.end_date || null,
          agent: FILTERS.agent || null,
          source: FILTERS.source || null,
        };
        const data = await assistantFetch(
          `/api/assistant/sessions/${encodeURIComponent(cid)}/messages`,
          { method: "POST", body }
        );
        const reply = data.reply || "";
        const runs = data.tool_runs || [];
        hideTypingIndicator();
        appendAssistantBubble(reply, runs);
      } catch (err) {
        hideTypingIndicator();
        appendBubble("bot", err instanceof Error ? err.message : String(err));
      } finally {
        sending = false;
        if (sendBtn) sendBtn.disabled = false;
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAssistantChatWidget);
  } else {
    initAssistantChatWidget();
  }
})();
