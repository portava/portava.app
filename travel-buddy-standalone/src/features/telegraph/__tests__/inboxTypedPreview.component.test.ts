/**
 * Telegraph §2.1 — what the conversation list says a typed message WAS.
 *
 * THE DEFECT THIS PINS. Every §6.2 typed kind stores a validated JSON envelope
 * in `messages.body`. The inbox's preview resolver labelled the OLDER shared
 * cards (post_card, discovery_card, meetup …) and had no entry for any of the
 * §6.2 kinds, so the last line of a conversation in which someone had sent a
 * location, a GIF, an announcement, a Memory Note, a safety check-in or a
 * voice note was the envelope itself:
 *
 *   {"kind":"VOICE","envelopeVersion":"1","payload":{"url":"post-media/…
 *
 * That is the exact failure the resolver's own header describes — "showing it
 * raw leaks `{"postId":"..."}` into the conversation list" — reappearing on a
 * newer set of kinds.
 *
 * THE SECOND HALF, which is the part a careless fix gets wrong: the shared-card
 * path resolves `subtype ?? msgType`, because for a shared card the `subtype`
 * IS the kind. For a §6.2 typed kind `subtype` is a discriminator WITHIN the
 * kind — LOCATION's precision, GIF's provider, ACTION's verb — so consulting it
 * first finds `area`, matches nothing, and falls straight back to the raw
 * envelope. The typed kinds are therefore resolved BEFORE the shared cards and
 * on `msgType`, and the cases below fail if that order is reversed.
 *
 * SHOWN RED before commit — counts at the bottom.
 */
import { systemMessageInboxPreview } from '../../../components/TelegraphInboxScreen.tsx';

type Lmp = Parameters<typeof systemMessageInboxPreview>[0];

const envelope = (kind: string, payload: unknown) =>
  JSON.stringify({ kind, envelopeVersion: '1', payload });

function lmp(over: Partial<Lmp> & { body: string }): Lmp {
  return {
    displayBody: over.body,
    senderId: 'u1',
    createdAt: '2026-09-16T10:00:00.000Z',
    ...over,
  } as Lmp;
}

describe('§6.2 typed kinds are LABELLED in the inbox, never shown as their envelope', () => {
  it('a VOICE message reads as a voice message', () => {
    const row = lmp({
      msgType: 'voice',
      subtype: null as any,
      body: envelope('VOICE', { url: 'post-media/u1/voice/1.m4a', durationSeconds: 9 }),
    });
    expect(systemMessageInboxPreview(row, false)).toBe('Voice message');
    expect(systemMessageInboxPreview(row, true)).toBe('You: Voice message');
  });

  it('every §6.2 typed kind resolves to a sentence, and none of them leaks JSON', () => {
    const cases: Array<[string, string | null, string]> = [
      ['voice', null, 'Voice message'],
      // `area` is LOCATION's precision, not a card kind — the case that breaks
      // if the resolver consults `subtype` first.
      ['location', 'area', 'Shared a location'],
      ['gif', 'giphy', 'GIF'],
      ['media_album', null, 'Shared photos'],
      ['announcement', null, 'Announcement'],
      ['memory_note', null, 'Memory Note'],
      ['action', 'add_to_trip', 'Suggested a plan'],
      ['portava_object', 'hidden_gem', 'Shared a Portava item'],
    ];
    for (const [msgType, subtype, expected] of cases) {
      const out = systemMessageInboxPreview(
        lmp({ msgType, subtype: subtype as any, body: envelope(msgType.toUpperCase(), { x: 1 }) }),
        false,
      );
      expect(out).toBe(expected);
      expect(out).not.toContain('{');
      expect(out).not.toContain('envelopeVersion');
    }
  });

  it('an ACTION whose verb COLLIDES with a shared-card kind is still a PROPOSAL', () => {
    // The collision is reachable today. `subtypeFor(ACTION)` is the action verb
    // lower-cased, and `meetup` is a key of SYSTEM_MESSAGE_LABELS. Resolving
    // `subtype ?? msgType` FIRST would find that key and tell the inbox
    // "Created a meetup" — stating that a meetup EXISTS when §8.2 says an
    // ACTION message is a PROPOSAL until someone confirms it. This is the case
    // that makes the typed-kind lookup's position load-bearing rather than
    // merely tidy.
    expect(
      systemMessageInboxPreview(
        lmp({
          msgType: 'action',
          subtype: 'meetup' as any,
          body: envelope('ACTION', { action: 'MEETUP', title: 'Rooftop at eight' }),
        }),
        false,
      ),
    ).toBe('Suggested a plan');
  });

  it('SAFETY is labelled from its CLASS — "Asked for help" must not read as "Safety update"', () => {
    const at = (subtype: string) =>
      systemMessageInboxPreview(
        lmp({ msgType: 'safety', subtype: subtype as any, body: envelope('SAFETY', { kind: subtype }) }),
        false,
      );
    expect(at('need_help')).toBe('Asked for help');
    expect(at('all_clear')).toBe('All clear');
    expect(at('check_in')).toBe('Checked in');
    expect(at('heads_up')).toBe('Heads up');
    // An unknown class degrades to the generic word rather than to the envelope.
    expect(at('something_new')).toBe('Safety update');
  });
});

describe('the older shared cards are UNAFFECTED — this is an addition, not a replacement', () => {
  it('a post card still resolves through its subtype', () => {
    expect(
      systemMessageInboxPreview(
        lmp({ msgType: 'system', subtype: 'post_card' as any, body: '{"postId":"p1"}' }),
        false,
      ),
    ).toBe('Shared a post');
  });

  it('a discovery card and a meetup still resolve through their subtypes', () => {
    expect(
      systemMessageInboxPreview(
        lmp({ msgType: 'system', subtype: 'discovery_card' as any, body: '{"sourceId":"g1"}' }),
        false,
      ),
    ).toBe('Shared a place');
    expect(
      systemMessageInboxPreview(
        lmp({ msgType: 'system', subtype: 'meetup' as any, body: '{"meetupId":"m1"}' }),
        true,
      ),
    ).toBe('You: Created a meetup');
  });

  it('an ordinary TEXT message is still its own text', () => {
    expect(
      systemMessageInboxPreview(
        lmp({ msgType: 'text', subtype: null as any, body: 'see you at eight' }),
        false,
      ),
    ).toBe('see you at eight');
  });

  it('a photo message still shows its caption, not a label', () => {
    // `media` deliberately has NO entry: a photo's caption is better than the
    // word "Photo", and an empty caption is an honest empty preview.
    expect(
      systemMessageInboxPreview(
        lmp({ msgType: 'media', subtype: null as any, body: 'the rooftop' }),
        false,
      ),
    ).toBe('the rooftop');
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 8/8. Each restored.
 *
 *   • `TYPED_KIND_LABELS` emptied → 5/3.
 *   • The typed-kind lookup moved BELOW the `subtype ?? msgType` shared-card
 *     resolution → 7/1: the ACTION-verb collision case, and ONLY it.
 *
 * THE SECOND ONE IS WHY THIS COMMENT IS WORTH READING. The first time that
 * mutation was run, the suite STAYED GREEN at 7/7 — the ordering was defensive
 * and nothing in the file could tell the two orders apart, because no §6.2
 * subtype then under test collided with a SYSTEM_MESSAGE_LABELS key. A rule
 * with no case that can fail is not tested, however carefully it is commented,
 * so the ACTION-verb case above was added to make the order decidable. It is
 * not hypothetical: `subtypeFor(ACTION)` in
 * `artifacts/api-server/src/services/telegraph/messageKinds.ts` writes the
 * action verb, lower-cased, into `subtype`, and `meetup` is a key of the older
 * table.
 */
