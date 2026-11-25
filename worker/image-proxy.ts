interface Env {
  ALLOWED_ORIGIN: string;
  IMAGE_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const IMAGE_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/heic', 'image/heic-sequence',
  'image/heif', 'image/heif-sequence', 'image/jpeg', 'image/png', 'image/webp',
  'image/x-ms-bmp',
]);

function rasterType(prefix: Uint8Array): string {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => prefix[i] === byte)) {
    return 'image/png';
  }
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  const magic = String.fromCharCode(...prefix);
  if (magic.startsWith('GIF87a') || magic.startsWith('GIF89a')) return 'image/gif';
  if (magic.startsWith('RIFF') && magic.slice(8, 12) === 'WEBP') return 'image/webp';
  return '';
}

class ProxyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function publicUrl(value: string, base?: URL): URL {
  const url = URL.parse(value, base);
  const hostname = url?.hostname.replace(/\.$/, '') ?? '';
  const labels = hostname.split('.');
  if (
    !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
    labels.length < 2 || !/[a-z]/.test(labels.at(-1)!) ||
    !labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
    /\.(?:localhost|local|internal|test|invalid|example|onion|home\.arpa)$/.test(hostname)
  ) {
    throw new ProxyError(400, 'Expected a public HTTP(S) image URL');
  }
  url.hash = '';
  return url;
}

function publicIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function publicIPv6(address: string): boolean {
  const host = URL.parse(`http://[${address}]/`)?.hostname;
  if (!host) return false;
  const [first, second] = host.slice(1, -1).split(':').map((part) => parseInt(part, 16));
  return first >= 0x2000 && first < 0x4000 &&
    first !== 0x2002 && first !== 0x3fff &&
    !(first === 0x2001 && (!second || second < 0x0200 || second === 0x0db8));
}

async function validateDns(hostname: string, signal: AbortSignal, fetchUpstream: typeof fetch) {
  // Check both address families, including CNAMEs resolved by the public resolver.
  // The outbound fetch also uses the Workers runtime's public-network egress.
  const families = await Promise.all(([1, 28] as const).map(async (type) => {
    const query = new URL('https://cloudflare-dns.com/dns-query');
    query.searchParams.set('name', hostname);
    query.searchParams.set('type', String(type));
    const response = await fetchUpstream(query, {
      headers: { Accept: 'application/dns-json' },
      redirect: 'manual',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProxyError(502, 'DNS lookup failed');
    }
    const result: { Status: number; Answer?: { type: number; data: string }[] } = await response.json();
    if (result.Status !== 0) throw new ProxyError(400, 'Image host did not resolve');
    return (result.Answer ?? []).filter((record) => record.type === type).map((record) => record.data);
  }));
  const [ipv4, ipv6] = families;
  if ((!ipv4.length && !ipv6.length) || !ipv4.every(publicIPv4) || !ipv6.every(publicIPv6)) {
    throw new ProxyError(400, 'Image host must resolve to public addresses');
  }
}

async function retrieveImage(url: URL, signal: AbortSignal, fetchUpstream: typeof fetch) {
  for (let redirects = 0; ; redirects++) {
    await validateDns(url.hostname, signal, fetchUpstream);
    const response = await fetchUpstream(url, {
      headers: { Accept: 'image/avif,image/webp,image/*;q=0.8' },
      redirect: 'manual',
      signal,
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= MAX_REDIRECTS) throw new ProxyError(502, 'Image redirect failed');
      url = publicUrl(location, url);
      continue;
    }

    const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const inferType = !declared || declared === 'application/octet-stream';
    if (!response.ok || !response.body || (!inferType && !IMAGE_TYPES.has(declared))) {
      await response.body?.cancel();
      throw new ProxyError(415, 'Image is unavailable or unsupported');
    }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      await response.body.cancel();
      throw new ProxyError(413, 'Image is too large');
    }

    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const reader = response.body.getReader();
    const prefix = inferType ? new Uint8Array(12) : undefined;
    let type = inferType ? '' : declared;
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (!type) throw new ProxyError(415, 'Image is unavailable or unsupported');
          return new Blob(chunks, { type });
        }
        const offset = size;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new ProxyError(413, 'Image is too large');
        }
        if (prefix && offset < prefix.length) {
          prefix.set(value.subarray(0, prefix.length - offset), offset);
          if (size >= prefix.length) {
            type = rasterType(prefix);
            if (!type) {
              await reader.cancel();
              throw new ProxyError(415, 'Image is unavailable or unsupported');
            }
          }
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export async function imageProxy(request: Request, env: Env, fetchUpstream: typeof fetch = fetch) {
  const endpoint = new URL(request.url);
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('origin');
  if (!origin || origin !== env.ALLOWED_ORIGIN) {
    return new Response('Origin not allowed', { status: 403, headers });
  }
  headers.set('Access-Control-Allow-Origin', origin);
  if (endpoint.pathname !== '/image') return new Response('Not found', { status: 404, headers });
  if (request.method !== 'GET') {
    headers.set('Allow', 'GET');
    return new Response('Method not allowed', { status: 405, headers });
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  try {
    const value = endpoint.searchParams.get('url');
    if (!value || value.length > 8_192) throw new ProxyError(400, 'Invalid image URL');
    const target = publicUrl(value);
    const key = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!(await env.IMAGE_RATE_LIMIT.limit({ key })).success) {
      throw new ProxyError(429, 'Image request limit reached');
    }
    const image = await retrieveImage(target, signal, fetchUpstream);
    headers.set('Content-Type', image.type);
    headers.set('Content-Disposition', 'attachment');
    return new Response(image, { headers });
  } catch (error) {
    if (error instanceof ProxyError) return new Response(error.message, { status: error.status, headers });
    return signal.aborted
      ? new Response('Image request timed out or was cancelled', { status: 504, headers })
      : new Response('Image request failed', { status: 502, headers });
  }
}

export default {
  fetch(request: Request, env: Env) {
    return imageProxy(request, env);
  },
};
