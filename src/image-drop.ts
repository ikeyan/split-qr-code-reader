type ImageDrop = { files: File[] } | { url: URL };

export function acceptsImageDrop(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).some((type) =>
    ['Files', 'text/html', 'text/uri-list', 'text/plain'].includes(type)
  );
}

function imageUrl(value: string): URL | null {
  const text = value.trim();
  if (/[\r\n]/.test(text) || !/^(https?:\/\/|data:)/i.test(text)) return null;
  const url = URL.parse(text);
  return url && !url.username && !url.password ? url : null;
}

export function imageDrop(data: Pick<DataTransfer, 'files' | 'getData'>): ImageDrop | null {
  const files = Array.from(data.files);
  if (files.length) return { files };

  const html = data.getData('text/html');
  if (html) {
    // Parsing into a template keeps the dropped markup inert.
    const template = document.createElement('template');
    template.innerHTML = html;
    const src = template.content.querySelector('img[src]')?.getAttribute('src');
    const url = src && imageUrl(src);
    if (url) return { url };
  }

  const url = imageUrl(data.getData('text/uri-list').trim() || data.getData('text/plain'));
  return url ? { url } : null;
}

async function fetchImage(url: URL, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) {
    await response.body?.cancel();
    throw new Error('Expected an image');
  }
  return await response.blob();
}

export async function fetchDroppedImage(
  url: URL,
  proxy: string | undefined,
  signal: AbortSignal,
): Promise<Blob> {
  try {
    return await fetchImage(url, AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
  } catch (error) {
    if (!proxy || url.protocol === 'data:' || signal.aborted) throw error;
  }

  const endpoint = new URL(proxy);
  const target = new URL(url);
  target.hash = '';
  endpoint.searchParams.set('url', target.href);
  return await fetchImage(endpoint, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
}
