/* global __ENV, __VU, __ITER -- provided by k6 */
// k6 load test: a mix of what the counter staff do, including posting money.
//   docker run --rm -i --network host -e BASE_URL=http://localhost:4000 grafana/k6 run - < smoke.js
// Run against a seeded environment that is not production. It creates real payments.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = `${__ENV.BASE_URL}/api/v1`;

export const options = {
  scenarios: {
    counter: {
      executor: 'ramping-vus',
      stages: [
        { duration: '15s', target: 20 },
        { duration: '45s', target: 20 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<1000'] },
};

export function setup() {
  const login = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const token = login.json('data.accessToken');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const first = (path) => http.get(`${BASE}${path}`, { headers }).json('data.0.id');
  return {
    headers,
    // A party on a sanctions hold is refused, correctly, so one that is clear is needed.
    partyId: http
      .get(`${BASE}/parties?limit=200`, { headers })
      .json('data')
      .find((party) => party.sanctionsStatus !== 'POTENTIAL_MATCH').id,
    branchId: first('/branches'),
    financialAccountId: first('/financial-accounts?q=BANK'),
    methodId: first('/payment-methods'),
  };
}

export default function counter(data) {
  const { headers, ...payment } = data;
  check(http.get(`${BASE}/stock/balances`, { headers }), { stock: (r) => r.status === 200 });
  check(http.get(`${BASE}/dashboard`, { headers }), { dashboard: (r) => r.status === 200 });
  check(http.get(`${BASE}/parties?limit=25`, { headers }), { parties: (r) => r.status === 200 });
  const paid = http.post(
    `${BASE}/payments`,
    JSON.stringify({
      ...payment,
      direction: 'RECEIPT',
      amount: '1.00',
      paymentDate: new Date().toISOString().slice(0, 10),
      allocations: [],
    }),
    { headers: { ...headers, 'Idempotency-Key': `${__VU}-${__ITER}-${Date.now()}` } },
  );
  check(paid, { payment: (r) => r.status === 201 });
  sleep(1);
}
