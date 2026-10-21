/** Request-local DAG cache. A node is reusable only when its complete dependency values match. */
type NodeValue = { key: string; value: unknown };
export class ConstraintDerivation {
  private readonly values = new Map<string, NodeValue>();
  private readonly computed = new Set<string>();
  private readonly retained = new Set<string>();
  constructor(private readonly previous?: ConstraintDerivation) {}
  run<T>(id: string, dependencies: unknown, compute: () => T): T {
    const key = dependencyKey(dependencies);
    const current = this.values.get(id);
    if (current?.key === key) return structuredClone(current.value) as T;
    const prior = this.previous?.values.get(id);
    if (prior?.key === key) {
      this.values.set(id, prior);
      this.retained.add(id);
      return structuredClone(prior.value) as T;
    }
    const value = compute();
    this.values.set(id, { key, value: structuredClone(value) });
    this.computed.add(id);
    return value;
  }
  trace(): { recomputed: string[]; reused: string[] } {
    return { recomputed: [...this.computed], reused: [...this.retained] };
  }
}

export function deriveConstraintNode<T>(graph: ConstraintDerivation | undefined, id: string, dependencies: unknown, compute: () => T): T {
  return graph ? graph.run(id, dependencies, compute) : compute();
}

function dependencyKey(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map(dependencyKey).join(',')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${dependencyKey(v)}`).join(',')}}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}
