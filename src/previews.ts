/** The queue is ordered by completion time; dismissal never deletes results. */
export function enqueuePreviews(queue: string[], ids: string[]): string[] {
  return [...queue, ...ids.filter(id => !queue.includes(id))];
}
export function dismissPreview(queue: string[]): string[] { return queue.slice(1); }
export function retainPreviews(queue: string[], remaining: Set<string>): string[] {
  return queue.filter(id => remaining.has(id));
}
