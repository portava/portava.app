/**
 * RATCHET — route param normalization must never manufacture `any`.
 *
 * The banned shape is a conditional whose test is `Array.isArray(E)` and whose
 * true-branch indexes that same `E`:
 *
 *     Array.isArray(params.x) ? params.x[0] : params.x
 *
 * When `params.x` is `string | undefined`, `Array.isArray` narrows it to an
 * array type and the index yields `any` — so the expression is `any` and every
 * contract downstream of it stops being checked. That is how §35's
 * `map_opened.entry` shipped a value outside its own union.
 *
 * WHY AN AST AND NOT A GREP. A grep for the exact old line is bypassed by
 * whitespace, a different fallback, `.at(0)`, or an intermediate variable. This
 * walks the real syntax tree, so it catches the SHAPE regardless of spelling.
 *
 * SCOPE, deliberately narrow. Only files that actually read Expo Router search
 * params are examined, and only when the value under `Array.isArray` is reached
 * from the params object. `Array.isArray` is used ~129 times in this app for
 * ordinary reasons; none of those is the defect and none of them is flagged.
 *
 * LIMITS, stated rather than implied:
 *   - A params value first assigned to an intermediate local and THEN passed
 *     through the idiom is not detected; the alias is not followed.
 *   - A screen that reads params through a helper this test cannot see is not
 *     examined.
 *   - It cannot prove the absence of `any`; it bans the one shape known to
 *     produce it. The compiler proof lives in the probe/control method
 *     recorded in the PR, not here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOTS = ['app', 'src'];
const PARAM_HOLDERS = new Set(['params', 'searchParams', 'query', 'routeParams', 'localParams']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.expo' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** `params.x` / `params['x']` — a read off a params-like object. */
function isParamRead(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = node.expression;
    return ts.isIdentifier(base) && PARAM_HOLDERS.has(base.text);
  }
  return false;
}

function isArrayIsArrayCall(node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const fn = node.expression;
  if (
    ts.isPropertyAccessExpression(fn) &&
    ts.isIdentifier(fn.expression) &&
    fn.expression.text === 'Array' &&
    fn.name.text === 'isArray' &&
    node.arguments.length === 1
  ) {
    return node.arguments[0]!;
  }
  return null;
}

/** Does `node` index into something spelled the same as `subject`? */
function indexesSameSubject(node: ts.Node, subjectText: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isElementAccessExpression(n) && n.expression.getText() === subjectText) found = true;
    // `.at(0)` and `[0]` are the same defect wearing different clothes.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'at' &&
      n.expression.expression.getText() === subjectText
    ) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function violationsIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('useLocalSearchParams') && !text.includes('useSearchParams')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isConditionalExpression(n)) {
      const subject = isArrayIsArrayCall(n.condition);
      if (subject && isParamRead(subject) && indexesSameSubject(n.whenTrue, subject.getText())) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
        hits.push(`${relative(ROOT, file)}:${line + 1}  ${subject.getText()}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe('route param normalization must not manufacture any', () => {
  test('no screen reintroduces the Array.isArray(params.x) ? params.x[0] : … idiom', () => {
    const files = ROOTS.flatMap((r) => sourceFiles(join(ROOT, r)));
    const offenders = files.flatMap(violationsIn);
    assert.deepEqual(
      offenders,
      [],
      'Use firstParam() from src/lib/routeParams.ts. This idiom yields `any`: ' +
        'Array.isArray narrows a `string | undefined` param to an array type and ' +
        'the index comes back `any`, silently disabling every downstream ' +
        `contract. Offenders:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('the detector actually detects — it is not vacuously green', () => {
    // A file that does NOT read router params must be ignored, and one that
    // does must be caught. Both directions, so a broken walker cannot pass.
    const sf = (src: string) =>
      ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const walk = (src: string): number => {
      let n = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isConditionalExpression(node)) {
          const s = isArrayIsArrayCall(node.condition);
          if (s && isParamRead(s) && indexesSameSubject(node.whenTrue, s.getText())) n += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf(src));
      return n;
    };
    assert.equal(walk('const a = Array.isArray(params.x) ? params.x[0] : params.x;'), 1, 'bracket form');
    assert.equal(walk('const a = Array.isArray(params.x) ? params.x.at(0) : params.x;'), 1, '.at(0) form');
    assert.equal(walk('const a = Array.isArray(params.x)\n  ? params.x[0]\n  : (params.x ?? null);'), 1, 'multi-line');
    assert.equal(walk('const a = Array.isArray(rows) ? rows[0] : rows;'), 0, 'not a params read');
    assert.equal(walk('const a = Array.isArray(params.x) ? firstParam(params.x) : null;'), 0, 'no self-index');
  });
});
