type Delivery = { id: string; task_id: string; email: string; lease: string };
type Result = 'sent' | 'retry' | 'failed' | 'rate_limit' | 'daily_quota' | 'monthly_quota';

async function send(delivery: Delivery, key: string, from: string, workspace: string): Promise<[Result, string]> {
  const link = new URL(workspace);
  link.searchParams.set('task', delivery.task_id);
  link.hash = 'tasks';
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `exo-task/${delivery.id}`,
      },
      body: JSON.stringify({
        from,
        to: [delivery.email],
        subject: 'New task in EXO Workspace',
        text: `Hey! Check the Workspace. You have a new task.\n\n${link.href}`,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body.id === 'string') return ['sent', body.id];
    if (body.name === 'daily_quota_exceeded') return ['daily_quota', body.name];
    if (body.name === 'monthly_quota_exceeded') return ['monthly_quota', body.name];
    if (response.status === 429) return ['rate_limit', 'Resend rate limit'];
    if (response.ok || response.status >= 500 || body.name === 'concurrent_idempotent_requests') {
      return ['retry', `Resend HTTP ${response.status}`];
    }
    return ['failed', `Resend HTTP ${response.status}`];
  } catch {
    return ['retry', 'Resend request did not complete'];
  }
}

Deno.serve(async request => {
  const secret = Deno.env.get('TASK_EMAIL_WORKER_SECRET');
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
    return new Response(null, { status: 401 });
  }
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('TASK_EMAIL_FROM');
  const workspace = Deno.env.get('TASK_EMAIL_WORKSPACE_URL');
  if (!url || !serviceKey || !key || !from || !workspace || !workspace.startsWith('https://')) {
    return Response.json({ error: 'Email worker configuration is incomplete' }, { status: 503 });
  }
  try { new URL(workspace); } catch {
    return Response.json({ error: 'Invalid workspace URL' }, { status: 503 });
  }
  async function rpc(name: string, params: Record<string, string> = {}) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  let sent = 0;
  try {
    const deadline = Date.now() + 40_000;
    for (let i = 0; i < 20 && Date.now() < deadline; i += 1) {
      const [delivery] = await rpc('claim_task_email') as Delivery[];
      if (!delivery) break;
      const [result, detail] = await send(delivery, key, from, workspace);
      await rpc('finish_task_email', {
        p_id: delivery.id, p_lease: delivery.lease, p_result: result, p_detail: detail,
      });
      if (result === 'sent') sent += 1;
      if (result !== 'sent' && result !== 'failed') break;
    }
    return Response.json({ sent });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Email worker failed');
    return Response.json({ sent, error: 'Email worker failed' }, { status: 500 });
  }
});
