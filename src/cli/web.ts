import { getDb } from "../store/db.js";
import { getPnLSummary } from "../settlement/pnl.js";
import { logger } from "../logger.js";

const PORT = 3456;

/**
 * Simple web dashboard served by Bun.
 * Reads from SQLite, renders equity curve + positions + stats.
 */
export function startWebDashboard(): void {
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/data") {
        return Response.json(getDashboardData());
      }

      return new Response(HTML, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  logger.info({ port: PORT }, "Web dashboard started");
}

function getDashboardData() {
  const db = getDb();
  const pnl = getPnLSummary();

  const positions = db.query(
    `SELECT * FROM positions ORDER BY entry_time DESC LIMIT 100`,
  ).all() as any[];

  const signals = db.query(
    `SELECT * FROM signals ORDER BY created_at DESC LIMIT 50`,
  ).all() as any[];

  // Build equity curve from settled positions
  const settled = db.query(
    `SELECT settle_time, pnl FROM positions WHERE status IN ('won','lost') ORDER BY settle_time ASC`,
  ).all() as any[];

  let cumPnl = 0;
  const equityCurve = settled.map((p) => {
    cumPnl += p.pnl ?? 0;
    return { time: p.settle_time, pnl: cumPnl };
  });

  // City breakdown
  const cityStats = db.query(`
    SELECT city,
      COUNT(*) as total,
      SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) as losses,
      SUM(COALESCE(pnl,0)) as pnl
    FROM positions WHERE status IN ('won','lost')
    GROUP BY city
  `).all() as any[];

  return {
    pnl,
    positions: positions.map(mapPos),
    signals,
    equityCurve,
    cityStats,
  };
}

function mapPos(r: any) {
  return {
    id: r.id,
    city: r.city,
    date: r.date,
    metric: r.metric,
    bracketType: r.bracket_type,
    bracketMin: r.bracket_min,
    bracketMax: r.bracket_max,
    side: r.side,
    entryPrice: r.entry_price,
    size: r.size,
    edge: r.edge,
    status: r.status,
    pnl: r.pnl,
    actualTemp: r.actual_temp,
    entryTime: r.entry_time,
    settleTime: r.settle_time,
    modelProbability: r.model_probability,
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeatherClaw Dashboard</title>
<style>
  :root {
    --bg: #0a0e17; --surface: #111827; --border: #1e293b;
    --text: #e2e8f0; --dim: #64748b; --green: #22c55e;
    --red: #ef4444; --yellow: #eab308; --cyan: #06b6d4;
    --purple: #a855f7;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: var(--bg); color: var(--text);
    padding: 24px; min-height: 100vh;
  }
  h1 { color: var(--cyan); font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px;
  }
  .card-label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .chart-container { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .chart-title { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  canvas { width: 100%; height: 200px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { color: var(--dim); text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .won { color: var(--green); }
  .lost { color: var(--red); }
  .open { color: var(--yellow); }
  .section { margin-bottom: 24px; }
  .section-title { color: var(--cyan); font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600;
  }
  .badge-won { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-lost { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-open { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .heatmap { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  .heat-cell {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; text-align: center;
  }
  .heat-city { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
  .heat-stat { font-size: 20px; font-weight: 700; }
  .refresh { color: var(--dim); font-size: 11px; margin-top: 16px; }
</style>
</head>
<body>
<h1>WeatherClaw</h1>
<p class="subtitle">Weather Prediction Market Bot — Polymarket</p>

<div id="stats" class="grid"></div>

<div class="chart-container">
  <div class="chart-title">Equity Curve</div>
  <canvas id="equityChart"></canvas>
</div>

<div class="section">
  <div class="section-title">City Performance</div>
  <div id="heatmap" class="heatmap"></div>
</div>

<div class="section">
  <div class="section-title">Positions</div>
  <div class="card">
    <table>
      <thead><tr>
        <th>City</th><th>Date</th><th>Side</th><th>Entry</th><th>Size</th>
        <th>Edge</th><th>Actual</th><th>P&L</th><th>Status</th>
      </tr></thead>
      <tbody id="positions"></tbody>
    </table>
  </div>
</div>

<p class="refresh">Auto-refreshes every 30s</p>

<script>
async function load() {
  const res = await fetch('/api/data');
  const d = await res.json();

  // Stats cards
  document.getElementById('stats').innerHTML =
    card('Total P&L', fmt(d.pnl.totalPnl), d.pnl.totalPnl >= 0) +
    card('Win Rate', d.pnl.totalTrades > 0 ? (d.pnl.winRate * 100).toFixed(1) + '%' : 'N/A') +
    card('Trades', d.pnl.totalTrades) +
    card('Open', d.pnl.openPositions) +
    card('Exposure', '$' + d.pnl.openExposure.toFixed(2));

  // Positions table
  document.getElementById('positions').innerHTML = d.positions.map(p =>
    '<tr>' +
    '<td>' + p.city + '</td>' +
    '<td>' + p.date + '</td>' +
    '<td>' + p.side + '</td>' +
    '<td>' + (p.entryPrice * 100).toFixed(1) + '¢</td>' +
    '<td>$' + p.size.toFixed(2) + '</td>' +
    '<td>' + (p.edge * 100).toFixed(1) + '%</td>' +
    '<td>' + (p.actualTemp != null ? p.actualTemp + '°F' : '—') + '</td>' +
    '<td class="' + (p.pnl >= 0 ? 'positive' : 'negative') + '">' +
      (p.pnl != null ? fmt(p.pnl) : '—') + '</td>' +
    '<td><span class="badge badge-' + p.status + '">' + p.status.toUpperCase() + '</span></td>' +
    '</tr>'
  ).join('');

  // City heatmap
  document.getElementById('heatmap').innerHTML = d.cityStats.map(c =>
    '<div class="heat-cell">' +
    '<div class="heat-city">' + c.city.toUpperCase() + '</div>' +
    '<div class="heat-stat ' + (c.pnl >= 0 ? 'positive' : 'negative') + '">' + fmt(c.pnl) + '</div>' +
    '<div style="color:var(--dim);font-size:11px">' + c.wins + 'W / ' + c.losses + 'L</div>' +
    '</div>'
  ).join('');

  // Equity chart
  drawChart(d.equityCurve);
}

function fmt(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
}

function card(label, value, positive) {
  const cls = positive === true ? 'positive' : positive === false ? 'negative' : '';
  return '<div class="card"><div class="card-label">' + label +
    '</div><div class="card-value ' + cls + '">' + value + '</div></div>';
}

function drawChart(data) {
  const canvas = document.getElementById('equityChart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * 2;
  canvas.height = 400;
  ctx.scale(2, 2);

  const w = canvas.offsetWidth;
  const h = 200;

  if (data.length < 2) {
    ctx.fillStyle = '#64748b';
    ctx.font = '14px monospace';
    ctx.fillText('Waiting for settlements...', w / 2 - 100, h / 2);
    return;
  }

  const pnls = data.map(d => d.pnl);
  const min = Math.min(0, ...pnls);
  const max = Math.max(0, ...pnls);
  const range = max - min || 1;
  const pad = 20;

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 0.5;
  const zeroY = pad + (max / range) * (h - 2 * pad);
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();

  ctx.strokeStyle = pnls[pnls.length - 1] >= 0 ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = pad + ((max - d.pnl) / range) * (h - 2 * pad);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
