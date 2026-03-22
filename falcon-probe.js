// Run this on the VPS: node /tmp/falcon-probe.js
// Tests: correct HTTP method + format, rate limits, response time
'use strict';
const https = require('https');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzc5MzgyNTE2LCJpYXQiOjE3NzQxOTg1MTYsImp0aSI6ImY0MzVmZTYxZTYxODQxMWE5YWMxYTNkZDI4NzRlNGM1IiwidXNlcl9pZCI6Njk4LCJzY29wZSI6ImxhdW5jaHBhZDphZ2VudC1yZWFkLHJldHJpZXZlcjplY2hvLWdlbmVyYXRpb24scmV0cmlldmVyOmZlYXR1cmUtZXh0cmFjdGlvbix1c2VyOnJlYWQscmV0cmlldmVyOmFnZW50LW9wdGlvbi1yZXRyaWV2YWwsbGF1bmNocGFkOmFnZW50LWNyZWF0aW9uLGxhdW5jaHBhZDphZ2VudC11cGRhdGUsdXNlcjp3cml0ZSxyZXRyaWV2ZXI6c2VtYW50aWMtcmV0cmlldmFsLGxhdW5jaHBhZDplY2hvLXN0eWxlLWNyZWF0aW9uIiwidG9rZW5fbmFtZSI6ImJhc2VfbG9naW4ifQ.D9ykx0Zi01rdR4noo7gq85GXR0Qfp-Qp0Mgw3eCYFFY';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function call(method, path, body) {
  return new Promise((resolve) => {
    const start = Date.now();
    const hdrs = {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    if (body) {
      const b = JSON.stringify(body);
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(b);
    }
    const req = https.request({
      hostname: 'narrative.agent.heisenberg.so',
      path, method, headers: hdrs, timeout: 20000,
    }, (res) => {
      const elapsed = Date.now() - start;
      let d = ''; let cut = false;
      res.on('data', c => { d += c; if (d.length > 3000 && !cut) { cut = true; req.destroy(); } });
      res.on('end', () => {
        const rl = {};
        for (const h of ['x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset','retry-after','x-rate-limit-limit','x-rate-limit-remaining']) {
          if (res.headers[h] !== undefined) rl[h] = res.headers[h];
        }
        resolve({ method, path, status: res.statusCode, elapsed, rateLimit: rl, body: d.slice(0, 800) });
      });
    });
    req.on('error', e => resolve({ method, path, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ method, path, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const body584 = { agent_id: 584, params: { wallet_address: 'ALL' }, pagination: { limit: 3, offset: 0 }, formatter_config: { format_type: 'raw' } };
const body581 = { agent_id: 581, params: { wallet_address: '0x0000000000000000000000000000000000000001' }, formatter_config: { format_type: 'raw' } };

async function main() {
  console.log('\n=== FORMAT DISCOVERY ===');
  // Try different methods/paths
  const formats = [
    call('GET', '/sse', null),
    call('POST', '/sse', body584),
    call('GET', '/sse?agent_id=584&wallet_address=ALL&limit=3', null),
    call('POST', '/api/sse', body584),
    call('POST', '/v2/sse', body584),
    call('GET', '/api/sse', null),
  ];
  const fmtResults = await Promise.all(formats);
  fmtResults.forEach(r => console.log(JSON.stringify(r)));

  // Find which worked (status 200)
  const working = fmtResults.find(r => r.status === 200);
  if (!working) {
    console.log('\n!!! No 200 response found — all formats failed');
    return;
  }
  console.log(`\n=== WORKING FORMAT: ${working.method} ${working.path} ===`);

  console.log('\n=== RATE LIMIT TEST (5 rapid calls) ===');
  const times = [];
  for (let i = 0; i < 5; i++) {
    const r = await call(working.method, working.path, working.method === 'POST' ? body584 : null);
    times.push(r.elapsed);
    console.log(`Call ${i+1}: status=${r.status} elapsed=${r.elapsed}ms rateLimit=${JSON.stringify(r.rateLimit)}`);
    // no sleep between calls to test throttling
  }

  console.log('\n=== RATE LIMIT TEST (5 calls with 200ms gap) ===');
  for (let i = 0; i < 5; i++) {
    const r = await call(working.method, working.path, working.method === 'POST' ? body584 : null);
    console.log(`Call ${i+1}: status=${r.status} elapsed=${r.elapsed}ms rateLimit=${JSON.stringify(r.rateLimit)}`);
    await sleep(200);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\nAvg response time: ${Math.round(avg)}ms`);
  console.log(`Est. calls/min: ${Math.round(60000 / avg)}`);
  console.log(`Est. time for 30k wallets (2 calls each, 300ms gap): ${Math.round(30000 * 2 * (avg + 300) / 1000 / 3600)}h`);
}
main().catch(console.error);
