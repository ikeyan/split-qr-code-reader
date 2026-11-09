import {contains, type Point} from './geometry.ts';
export class Pointers {
  private positions = new Map<number, Point>();
  update(id: number, point: Point) { this.positions.set(id, point); }
  has(id: number) { return this.positions.has(id); }
  remove(id: number) { this.positions.delete(id); }
  clear() { this.positions.clear(); }
  select<T>(items: T[], polygon: (item: T) => Point[]): T[] {
    const chosen: T[] = [];
    for (const point of this.positions.values()) {
      const item = items.find(candidate => contains(polygon(candidate), point));
      if (item !== undefined) chosen.push(item);
    }
    return chosen;
  }
}
