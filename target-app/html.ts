import type { TenantConfig } from './tenants.js';

/**
 * Markup is deliberately hostile, in the way real back-office apps are hostile:
 *  - frameset shell (no SPA router, no history)
 *  - table-based layout, labels are sibling <td> text rather than <label for>
 *  - no id or data-testid attributes anywhere
 *  - submit controls are <input type="submit" value="...">
 *  - class names are presentational and reused
 * What IS available is the accessibility tree: links, buttons and headings still
 * expose roles and names. That asymmetry is the whole point of the locator design.
 */

export function chrome(t: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>
 body{font-family:Verdana,Geneva,sans-serif;font-size:11px;margin:0;background:#fff;color:#111}
 .bar{background:${t.theme.bar};color:#fff;padding:5px 8px;font-weight:bold;font-size:12px}
 .sub{background:${t.theme.accent};padding:3px 8px;border-bottom:1px solid #888}
 table.form{border-collapse:collapse;margin:10px}
 table.form td{padding:3px 6px;font-size:11px}
 table.grid{border-collapse:collapse;margin:10px;border:1px solid #666}
 table.grid td,table.grid th{border:1px solid #999;padding:3px 8px;font-size:11px;text-align:left}
 table.grid th{background:${t.theme.accent}}
 .err{color:#a00;font-weight:bold;margin:10px;border:1px solid #a00;background:#fee;padding:6px}
 .warn{color:#7a4a00;margin:10px;border:1px solid #c89a00;background:#fffbe6;padding:6px}
 .ok{color:#063;margin:10px;border:1px solid #063;background:#eefaf0;padding:6px}
 input,select{font-family:inherit;font-size:11px}
 h2{font-size:13px;margin:10px}
 a{color:#1a3e8c}
 .foot{margin:12px;color:#666;font-size:10px}
</style></head>
<body>
<div class="bar">${t.institution} &nbsp;&#183;&nbsp; MemberLink Core Servicing ${t.productVersion}</div>
<div class="sub">${title}</div>
${body}
<div class="foot">MemberLink&reg; ${t.productVersion} &#183; training instance &#183; synthetic data only</div>
</body></html>`;
}

export function money(n: number): string {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-$' : '$') + s;
}
