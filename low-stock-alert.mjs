// Sends a summary of low and out-of-stock parts to your phone via ntfy.
// Run by .github/workflows/low-stock-alert.yml. Needs Node 18 or newer.

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  NTFY_TOPIC,
  APP_URL = '',
  NTFY_SERVER = 'https://ntfy.sh',
} = process.env;

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, NTFY_TOPIC })) {
  if (!value) {
    console.error(`Missing ${name}. Add it under Settings > Secrets and variables > Actions.`);
    process.exit(1);
  }
}

const headers = { apikey: SUPABASE_SERVICE_KEY };
// Legacy service_role keys are JWTs and also go in Authorization.
// Newer sb_secret_ keys only go in the apikey header.
if (SUPABASE_SERVICE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`;

const query = new URLSearchParams({
  select: 'name,quantity,unit,reorder_at,status,bin_ids',
  status: 'in.(low,out)',
  order: 'status_rank,name',
});
const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/part_status?${query}`, { headers });
if (!res.ok) {
  console.error(`Supabase returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const parts = await res.json();

if (parts.length === 0) {
  console.log('Everything is above its reorder point. No alert sent.');
  process.exit(0);
}

const out = parts.filter((p) => p.status === 'out');
const low = parts.filter((p) => p.status === 'low');
const line = (p) => {
  const where = p.bin_ids ? `, bin ${p.bin_ids}` : '';
  return p.status === 'out'
    ? `- ${p.name}${where}`
    : `- ${p.name}: ${p.quantity} ${p.unit} left (reorder at ${p.reorder_at})${where}`;
};

const sections = [];
if (out.length) sections.push(`Out of stock (${out.length})\n${out.map(line).join('\n')}`);
if (low.length) sections.push(`Running low (${low.length})\n${low.map(line).join('\n')}`);
let body = sections.join('\n\n');
if (body.length > 3800) body = `${body.slice(0, 3800)}\n…and more. Open the app for the full list.`;

const title = `${parts.length} part${parts.length === 1 ? ' needs' : 's need'} reordering`;
const ntfyHeaders = {
  Title: title,
  Tags: 'package',
  Priority: out.length ? 'high' : 'default',
};
if (APP_URL) ntfyHeaders.Click = `${APP_URL.replace(/#.*$/, '')}#/reorder`;

const sent = await fetch(`${NTFY_SERVER.replace(/\/$/, '')}/${encodeURIComponent(NTFY_TOPIC)}`, {
  method: 'POST',
  headers: ntfyHeaders,
  body,
});
if (!sent.ok) {
  console.error(`ntfy returned ${sent.status}: ${await sent.text()}`);
  process.exit(1);
}
console.log(`${title}. Alert sent.`);
