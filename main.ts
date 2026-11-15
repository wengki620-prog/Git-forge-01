/**
 * main.ts — titik masuk forge: ikat port ephemeral, daftarkan diri ke
 * environment harness, layani suite sampai environment berkata selesai,
 * lalu keluar dengan kode 0.
 *
 * Siklus hidup ini mengikuti kontrak RULES: listen(0) (tidak pernah port
 * tetap), POST {"port": N} ke $MAKEFUN_ENV_URL/register, lalu polling
 * GET $MAKEFUN_ENV_URL/done sampai {"done": true}.
 */

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { Forge } from './forge.ts';

const REGISTER_TIMEOUT_MS = 30000;
const DONE_TIMEOUT_MS = 30000;
const REGISTER_DEADLINE_MS = 18000;
const POLL_START_MS = 250;
const POLL_MAX_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** Daftarkan port ke environment; 200/409 diterima, 400/405 fatal, sisanya diulang. */
async function register(port: number): Promise<void> {
  const started = Date.now();
  let delay = POLL_START_MS;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl()}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register ditolak environment dengan status ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register ditolak')) throw err;
      // Galat jaringan/timeout: ulangi sampai tenggat.
    }
    if (Date.now() - started > REGISTER_DEADLINE_MS) {
      throw new Error('register tidak berhasil dalam tenggat boot');
    }
    await sleep(delay);
    delay = Math.min(POLL_MAX_MS, delay * 2);
  }
}

/** Polling /done sampai environment menandai selesai. */
async function waitUntilDone(): Promise<void> {
  let delay = POLL_START_MS;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl()}/done`, {
        signal: AbortSignal.timeout(DONE_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Environment belum siap atau jaringan tersendat: ulangi dengan backoff.
    }
    await sleep(delay);
    delay = Math.min(POLL_MAX_MS, delay * 2);
  }
}

async function main(): Promise<void> {
  if (!process.env.MAKEFUN_ENV_URL) {
    console.error('MAKEFUN_ENV_URL tidak diatur; forge tidak dapat mendaftar.');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  const forge = new Forge();
  const server = createApp(forge, { token });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address() as AddressInfo | string | null;
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('server tidak mendapatkan alamat listen'));
    });
  });

  await register(port);
  await waitUntilDone();

  try {
    server.closeAllConnections();
  } catch {
    // closeAllConnections tidak tersedia di runtime yang sangat lama; abaikan.
  }
  server.close();
  process.exit(0);
}

// Galat tak tertangani dicatat tetapi tidak mematikan proses di tengah suite:
// satu permintaan yang gagal tidak boleh menggugurkan seluruh trial.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason instanceof Error ? reason.message : String(reason));
});

main().catch((err: unknown) => {
  console.error('forge gagal start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
