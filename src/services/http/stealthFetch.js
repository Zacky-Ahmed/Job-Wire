import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/stealth-fetch.py', import.meta.url));

export async function stealthFetch(url) {
  const { stdout } = await run('/opt/stealth/bin/python', [script, String(url)], {
    timeout: 23000, maxBuffer: 8 * 1024 * 1024,
    // Do not pass database, mail or application secrets into this subprocess.
    env: { PATH: '/usr/bin:/bin', PYTHONUTF8: '1' },
  });
  const result = JSON.parse(stdout);
  return new Response([204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, 'base64'), {
    status: result.status, headers: result.headers,
  });
}
