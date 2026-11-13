/** Diagnostics are not product storage. Keep code locations and timing, never
 * raw error messages, input, request bodies, media references or SDK extras. */
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, max = 120) => typeof value === 'string' && value.length <= max ? value : undefined;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{16,32}$/i.test(value) ? value : undefined;
const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'UnhandledRejection']);
function stack(value: unknown) {
    const source = object(value);
    return { frames: Array.isArray(source.frames) ? source.frames.slice(-100).map(value => {
            const frame = object(value);
            const file = typeof frame.filename === 'string' ? frame.filename.split(/[?#]/)[0]!.split('/').pop() : undefined;
            // User-selected image/video names are never diagnostic code filenames.
            const codeFile = file && /^(?:index|main|app|[a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9_-]+)*\.(?:js|ts|tsx|bundle)$/.test(file) ? file : undefined;
            return { filename: codeFile, function: identifier(frame.function), lineno: finite(frame.lineno), colno: finite(frame.colno), in_app: typeof frame.in_app === 'boolean' ? frame.in_app : undefined };
        }) : [] };
}
function trace(value: unknown) {
    const source = object(value);
    return { trace_id: hex(source.trace_id), span_id: hex(source.span_id), parent_span_id: hex(source.parent_span_id), op: identifier(source.op) };
}
export function redactCrashBreadcrumb<T>(breadcrumb: T): T {
    const source = object(breadcrumb);
    return { category: identifier(source.category), type: identifier(source.type), level: identifier(source.level), timestamp: finite(source.timestamp) } as T;
}
export function redactCrashInput<T>(event: T): T {
    const source = object(event);
    const result: ObjectValue = {
        event_id: hex(source.event_id), timestamp: finite(source.timestamp), platform: identifier(source.platform),
        level: identifier(source.level), release: text(source.release), dist: identifier(source.dist), environment: identifier(source.environment),
        contexts: { trace: trace(object(source.contexts).trace) },
    };
    const images = object(source.debug_meta).images;
    if (Array.isArray(images)) result.debug_meta = { images: images.flatMap(value => {
        const image = object(value);
        return image.type === 'sourcemap' && typeof image.debug_id === 'string' && /^[a-f0-9-]{36}$/i.test(image.debug_id) ? [{ type: 'sourcemap', debug_id: image.debug_id }] : [];
    }) };
    const values = object(source.exception).values;
    if (Array.isArray(values))
        result.exception = { values: values.slice(0, 10).map(value => {
                const error = object(value);
                return { type: ERROR_TYPES.has(String(error.type)) ? error.type : 'Error', value: 'Error details removed for input privacy', stacktrace: stack(error.stacktrace), mechanism: { type: identifier(object(error.mechanism).type), handled: typeof object(error.mechanism).handled === 'boolean' ? object(error.mechanism).handled : undefined } };
            }) };
    if (Array.isArray(source.breadcrumbs))
        result.breadcrumbs = source.breadcrumbs.slice(-50).map(redactCrashBreadcrumb);
    if (source.type === 'transaction') {
        result.type = 'transaction';
        result.transaction = 'app';
        result.start_timestamp = finite(source.start_timestamp);
        if (Array.isArray(source.spans))
            result.spans = source.spans.slice(0, 200).map(value => {
                const span = object(value);
                return { ...trace(span), start_timestamp: finite(span.start_timestamp), timestamp: finite(span.timestamp) };
            });
    }
    // A message-only event still has a safe grouping label, never the raw text.
    if (typeof source.message === 'string')
        result.message = 'Application diagnostic';
    return result as T;
}

/** SDK attachments are a separate export channel from the event JSON. */
export function redactCrashEvent<T>(event: T, hint?: { attachments?: unknown[] }): T {
  if (hint) hint.attachments = [];
  return redactCrashInput(event);
}
