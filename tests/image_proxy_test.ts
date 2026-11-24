import assert from 'node:assert/strict';
import { imageProxy } from '../worker/image-proxy.ts';

const origin = 'https://reader.example.com';
const env = {
  ALLOWED_ORIGIN: origin,
  IMAGE_RATE_LIMIT: { limit: () => Promise.resolve({ success: true }) },
};

function imageRequest(target: string, requestOrigin = origin) {
  const url = new URL('https://proxy.example.com/image');
  url.searchParams.set('url', target);
  return new Request(url, {
    headers: { Origin: requestOrigin, Cookie: 'reader-session', Authorization: 'Bearer reader-token' },
  });
}

function dnsAnswer(query: URL, ipv4 = '93.184.216.34') {
  const type = Number(query.searchParams.get('type'));
  return Response.json({ Status: 0, Answer: type === 1 ? [{ type, data: ipv4 }] : [] });
}

Deno.test('proxy validates every redirect and returns the original image bytes with CORS', async () => {
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const requested: string[] = [];
  const response = await imageProxy(
    imageRequest('https://first.example.com/image?key=a%2Bb&version=2'),
    env,
    (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.redirect, 'manual');
      const headers = new Headers(init?.headers);
      for (const name of ['cookie', 'authorization', 'origin']) assert.equal(headers.get(name), null);
      if (url.hostname === 'cloudflare-dns.com') {
        requested.push(url.searchParams.get('name')!);
        return Promise.resolve(dnsAnswer(url));
      }
      if (url.hostname === 'first.example.com') {
        assert.equal(url.search, '?key=a%2Bb&version=2');
        return Promise.resolve(Response.redirect('https://second.example.com/qr.png'));
      }
      assert.equal(url.href, 'https://second.example.com/qr.png');
      return Promise.resolve(new Response(original, { headers: { 'Content-Type': 'image/png' } }));
    },
  );
  assert.deepEqual(requested, [
    'first.example.com', 'first.example.com', 'second.example.com', 'second.example.com',
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);
});

Deno.test('proxy rejects other browser origins before requesting the image', async () => {
  const response = await imageProxy(
    imageRequest('https://images.example.com/qr.png', 'https://other.example.com'),
    env,
    () => { throw new Error('Unexpected upstream request'); },
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
});

Deno.test('proxy declines redirects to hostnames that resolve to private addresses', async () => {
  const response = await imageProxy(imageRequest('https://images.example.com/qr.png'), env, (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloudflare-dns.com') {
      const local = url.searchParams.get('name') === 'unavailable.example.com';
      return Promise.resolve(dnsAnswer(url, local ? '10.0.0.1' : undefined));
    }
    assert.equal(url.hostname, 'images.example.com');
    return Promise.resolve(Response.redirect('https://unavailable.example.com/qr.png'));
  });
  assert.equal(response.status, 400);
});

Deno.test('proxy rejects non-images and enforces the byte limit for streamed images', async () => {
  const target = imageRequest('https://images.example.com/qr.png');
  const serve = (response: Response): typeof fetch => (input) => {
    const url = new URL(String(input));
    return Promise.resolve(url.hostname === 'cloudflare-dns.com' ? dnsAnswer(url) : response);
  };
  const html = new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
  assert.equal((await imageProxy(target, env, serve(html))).status, 415);

  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const large = new Response(chunks, { headers: { 'Content-Type': 'image/png' } });
  assert.equal((await imageProxy(target, env, serve(large))).status, 413);
});
