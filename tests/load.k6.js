import http from 'k6/http';import {check,sleep} from 'k6';
if(!__ENV.BASE_URL)throw new Error('Set BASE_URL, e.g. k6 run -e BASE_URL=https://staging.example.com tests/load.k6.js');
export const options={vus:10,duration:'1m',thresholds:{http_req_failed:['rate<0.01'],http_req_duration:['p(95)<1500']}};
// NOTE: this starter only exercises the public /api/health endpoint. It does
// NOT measure send/inbox/auth load. Extend with authenticated scenarios
// (login, send, inbox list) before treating any result as a load-test pass.
export default function(){const r=http.get(`${__ENV.BASE_URL}/api/health`);check(r,{'health status 200':x=>x.status===200});sleep(1)}
