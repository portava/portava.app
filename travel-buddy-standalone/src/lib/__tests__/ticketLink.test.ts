/**
 * ticketLink — the app's side of the ticket-link rule (REV-020).
 *
 * Before this file existed the composer sent `priceUrl: undefined` whenever the
 * price was Free or the link field was empty, and re-sent the stored link with
 * every other edit. Against a server that holds the link to an allowlist that
 * meant: any edit of an event whose stored link was off the allowlist failed,
 * and a link, once saved, could not be taken off. And the event screen handed
 * whatever string was stored to Linking.openURL.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/ticketLink.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TICKET_LINK_REFUSAL_PREFIX, isTicketLinkRefusal, openableTicketLink, ticketLinkForSave,
} from '../ticketLink.ts';

// From src/lib/__tests__/ back to the repository root.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

describe('openableTicketLink — only an https link is ever handed to the OS', () => {
  it('passes an https link through, trimmed and otherwise untouched', () => {
    assert.equal(openableTicketLink('https://www.eventbrite.com/e/123?aff=x#tickets'), 'https://www.eventbrite.com/e/123?aff=x#tickets');
    assert.equal(openableTicketLink('  https://dice.fm/event/abc  '), 'https://dice.fm/event/abc');
    assert.equal(openableTicketLink('HTTPS://ra.co/events/1'), 'HTTPS://ra.co/events/1');
  });

  it('refuses every other scheme, including the two that carry an allowlisted host', () => {
    for (const link of [
      'javascript://eventbrite.com/%0aalert(1)',
      'intent://eventbrite.com/#Intent;scheme=https;package=com.evil;end',
      'http://eventbrite.com/e/123',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'tel:+15555550100',
      'portava://event/1',
      '//eventbrite.com/e/123',
      'eventbrite.com/e/123',
    ]) {
      assert.equal(openableTicketLink(link), null, `${link} would be opened`);
    }
  });

  it('refuses a string a lenient parser would tidy into https, and one that is not a link at all', () => {
    for (const link of ['ht\ttps://eventbrite.com/e/1', 'https://eventbrite.com/e/1\njavascript:alert(1)', 'https://event brite.com', 'https://', 'https:/eventbrite.com', 'https:///eventbrite.com', '']) {
      assert.equal(openableTicketLink(link), null, `${JSON.stringify(link)} would be opened`);
    }
    assert.equal(openableTicketLink(null), null);
    assert.equal(openableTicketLink(undefined), null);
    assert.equal(openableTicketLink(42 as unknown as string), null);
  });
});

describe('ticketLinkForSave — Free, or an emptied field, REMOVES the link', () => {
  it('sends the typed link, trimmed, when the price is an external link', () => {
    assert.equal(ticketLinkForSave('external', '  https://dice.fm/event/abc '), 'https://dice.fm/event/abc');
  });

  it('sends null — never undefined — when the price is Free or the field is empty', () => {
    // `undefined` drops out of the JSON body, and PATCH /events/:id reads a
    // missing priceUrl as "leave the stored link alone".
    assert.equal(ticketLinkForSave('free', 'https://dice.fm/event/abc'), null);
    assert.equal(ticketLinkForSave('free', ''), null);
    assert.equal(ticketLinkForSave('external', ''), null);
    assert.equal(ticketLinkForSave('external', '   '), null);
    assert.deepEqual(JSON.parse(JSON.stringify({ priceUrl: ticketLinkForSave('free', 'https://x.example') })), { priceUrl: null },
      'the key must survive serialisation: a dropped key is how the stored link stayed');
  });
});

describe('isTicketLinkRefusal — recognises exactly the refusals the server sends about the link', () => {
  const server = read('artifacts/api-server/src/routes/events.ts');

  it('every message checkTicketUrl can return begins with the prefix', () => {
    const fn = server.slice(server.indexOf('function checkTicketUrl('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const messages = [...body.matchAll(/return\s+[`"]([^`"]+)[`"]/g)].map((m) => m[1]!);
    assert.equal(messages.length, 3, `expected checkTicketUrl's three refusals (scheme, host, not a URL), found ${messages.length}: the server changed and this pin must be re-read`);
    for (const m of messages) assert.ok(m.startsWith(TICKET_LINK_REFUSAL_PREFIX), `the server refuses with "${m}", which the composer would show as a general failure`);
    for (const m of messages) assert.equal(isTicketLinkRefusal(m), true);
  });

  it('the publish refusal is the same message with the way out appended, so it is recognised too', () => {
    assert.match(server, /sendError\(res, "invalid_payload", `\$\{publishErr\}\. Remove the ticket link or replace it with an allowed one, then publish\.`\)/);
    assert.equal(isTicketLinkRefusal('Ticket URL host is not on the allowlist (eventbrite.com). Remove the ticket link or replace it with an allowed one, then publish.'), true);
  });

  it('the create schema refuses a non-https link with a message of the same family', () => {
    assert.match(server, /\.refine\(isHttpsUrl, "Ticket URL must be an https link"\)/);
  });

  it('is false for every other failure, and for no message', () => {
    for (const m of ['Title is required', 'Failed to save event', 'endsAt must be after startsAt', 'Invalid url', 'the Ticket URL is wrong', '', null, undefined]) {
      assert.equal(isTicketLinkRefusal(m), false, String(m));
    }
  });
});

describe('the screens use it', () => {
  const composer = read('travel-buddy-standalone/src/components/EventComposerSheet.tsx');
  const eventScreen = read('travel-buddy-standalone/app/event/[id].tsx');
  const createScreen = read('travel-buddy-standalone/app/events/create/index.tsx');

  it('the composer sends ticketLinkForSave, and nowhere sends the link as `undefined`', () => {
    assert.match(composer, /priceUrl:\s+ticketLinkForSave\(priceType, priceUrl\),/);
    assert.doesNotMatch(composer, /priceUrl[^\n]*:\s*undefined/, 'the composer can again leave a stored link in place when the host removed it');
  });

  it('the composer shows a link refusal at the link field, with a control that removes the link, on every save path', () => {
    // Each of the three saves (edit, the AI draft, create) takes the host to the step that holds the field.
    const jumps = [...composer.matchAll(/setError\(res\.message \?\? '[^']+'\); if \(isTicketLinkRefusal\(res\.message\)\) setStep\('settings'\);/g)];
    assert.equal(jumps.length, 3, `expected the three save paths to lead to the link field, found ${jumps.length}`);
    const settings = composer.slice(composer.indexOf("{step === 'settings' && ("), composer.indexOf("{step === 'review' && ("));
    assert.match(settings, /\{isTicketLinkRefusal\(error\) && \(/, 'the refusal is not rendered in the step that holds the link field');
    assert.match(settings, /onPress=\{\(\) => \{ setPriceUrl\(''\); setPriceType\('free'\); setError\(null\); \}\}/, 'the refusal offers no way to remove the link');
    assert.match(settings, /<Text style=\{s\.linkRefusalText\}>\{error\}<\/Text>/, 'the server\'s own sentence is not what is shown');
    // …and it is not shown a second time as a general failure.
    assert.match(composer, /\{error && !isTicketLinkRefusal\(error\) \? <Text style=\{s\.errorText\}>\{error\}<\/Text> : null\}/);
  });

  it('the event screen opens the link only through openableTicketLink', () => {
    assert.match(eventScreen, /const url = openableTicketLink\(event\.priceUrl\);\s*\n\s*if \(!url\) \{ Alert\.alert\(/);
    assert.doesNotMatch(eventScreen, /const url = event\.priceUrl!;/, 'the stored link is handed to the OS unchecked again');
    const opens = [...eventScreen.matchAll(/Linking\.(?:openURL|canOpenURL)\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    assert.ok(opens.length >= 2, 'the event screen no longer opens any link: this pin proves nothing');
    assert.ok(!opens.some((arg) => /priceUrl/.test(arg)), `Linking is called on the stored link directly: ${opens.join(' | ')}`);
  });

  it('the create screen asks for the scheme the server will accept', () => {
    assert.match(createScreen, /priceType === 'external' && priceUrl\.trim\(\) && !\/\^https:\\\/\\\/\/i\.test\(priceUrl\.trim\(\)\)/);
    assert.doesNotMatch(createScreen, /priceUrl\.startsWith\('http'\)/);
  });
});
