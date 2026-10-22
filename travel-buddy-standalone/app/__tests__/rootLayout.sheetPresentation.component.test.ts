/**
 * Root Stack presentation of /create and /media/add-gem — read off disk.
 *
 * WHAT THE OWNER SAW (iPhone, 2026-10-22, "the upload page has wrong
 * navigation settings"):
 *   - /create (the composer: an X close, no back arrow) slid in as a card,
 *     because a refactor dropped its `presentation` from the root Stack. The
 *     iOS edge-swipe then dismissed it and silently lost a captured photo or
 *     video. It must be a full-screen modal with the gesture off, so only its
 *     own X — which asks before discarding — closes it.
 *   - /media/add-gem draws a dimmed backdrop and a rounded bottom sheet, but was
 *     never registered, so it pushed as an opaque card on the Stack's paper
 *     background: a grey band where the Media tab should have shown through.
 *     It must be a transparent modal with a transparent content background.
 *
 * WHY IT READS THE SOURCE INSTEAD OF RENDERING. A component test cannot mount
 * the root layout: it wires ~50 providers, native tasks and telemetry
 * installers (see src/features/telegraph/media/__tests__/compactPlaybackMount.test.ts
 * for the same call). So this parses app/_layout.tsx with the TypeScript
 * compiler, takes the ONE <Stack> element's <Stack.Screen> children, and reads
 * each screen's `options` object as literal values. A value that is not a
 * literal is reported as `{ expr }`, so a refactor to a computed option fails
 * here loudly rather than passing on a guess.
 *
 * Run with: npx jest --forceExit app/__tests__/rootLayout.sheetPresentation.component.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// …/app/__tests__ → the standalone app root.
const APP_ROOT = join(__dirname, '..', '..');
const LAYOUT = join(APP_ROOT, 'app', '_layout.tsx');

type Literal = string | number | boolean | { expr: string } | { [key: string]: Literal };

function literal(node: ts.Expression, sf: ts.SourceFile): Literal {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isObjectLiteralExpression(node)) {
    const out: { [key: string]: Literal } = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) out[prop.name.getText(sf)] = literal(prop.initializer, sf);
      else out[`<${ts.SyntaxKind[prop.kind]}>`] = { expr: prop.getText(sf) };
    }
    return out;
  }
  return { expr: node.getText(sf) };
}

/** name → options for every <Stack.Screen> directly inside the root layout's <Stack>. */
function rootStackScreens(): Map<string, Literal> {
  const sf = ts.createSourceFile(LAYOUT, readFileSync(LAYOUT, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const stacks: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === 'Stack') stacks.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  expect(stacks).toHaveLength(1);

  const screens = new Map<string, Literal>();
  for (const child of stacks[0]!.children) {
    if (!ts.isJsxSelfClosingElement(child) || child.tagName.getText(sf) !== 'Stack.Screen') continue;
    let name: string | undefined;
    let options: Literal = {};
    for (const attr of child.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
      const key = attr.name.getText(sf);
      const init = attr.initializer;
      if (key === 'name' && ts.isStringLiteral(init)) name = init.text;
      if (key === 'options' && ts.isJsxExpression(init) && init.expression) options = literal(init.expression, sf);
    }
    expect(name).toBeDefined();
    expect(screens.has(name!)).toBe(false); // a second registration would silently win or lose
    screens.set(name!, options);
  }
  return screens;
}

describe('root Stack — the create surfaces are presented as what they draw', () => {
  const screens = rootStackScreens();

  it('reads a real Stack (not vacuous)', () => {
    expect(screens.get('(tabs)')).toEqual({});
    expect(screens.get('notifications')).toEqual({ presentation: 'modal' });
  });

  it('/create is a full-screen modal that no gesture can dismiss', () => {
    expect(existsSync(join(APP_ROOT, 'app', 'create.tsx'))).toBe(true);
    expect(screens.get('create')).toMatchObject({ presentation: 'fullScreenModal', gestureEnabled: false });
  });

  it('/media/add-gem is a transparent modal, so the Media tab shows under its backdrop', () => {
    // The name only reaches the screen while app/media has no _layout of its own;
    // with one, the root Stack's child would be `media` and these options would not apply.
    expect(existsSync(join(APP_ROOT, 'app', 'media', 'add-gem.tsx'))).toBe(true);
    expect(existsSync(join(APP_ROOT, 'app', 'media', '_layout.tsx'))).toBe(false);
    expect(screens.get('media/add-gem')).toMatchObject({
      presentation: 'transparentModal',
      contentStyle: { backgroundColor: 'transparent' },
    });
  });
});
