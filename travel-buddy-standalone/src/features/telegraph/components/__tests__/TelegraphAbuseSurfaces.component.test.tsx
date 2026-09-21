/**
 * Telegraph §22 — the two traveller-facing abuse surfaces.
 *
 * §22: "Stranger media can be blurred / no autoplay until accepted." and
 * "Travel scam signals: Off-platform payment, fake taxi, visa help, ticket
 * resale, fake hotel, urgent money request."
 *
 * THE CLIENT DECIDES NOTHING HERE, AND THAT IS WHAT IS TESTED
 * ==========================================================
 * Both components render a server answer. `safetySignals` is computed by
 * `domain/telegraph/policies/travelScamSignals.ts` for the RECIPIENT only;
 * `senderConnected` by `domain/telegraph/policies/senderConnectedness.ts`,
 * which fails closed. So every assertion below is about PRESENCE, ABSENCE and
 * what is NOT mounted — never about a classification this tree performs.
 *
 * WHAT TURNS THIS RED
 *   • render the shielded children anyway (a blur instead of a cover) → the
 *     "does not mount the media" test fails, and that is the whole control:
 *     a blur has already fetched the bytes.
 *   • treat an absent `signals` as an empty object and render a chrome-only
 *     banner → the "renders nothing" tests fail.
 *   • drop the dismiss control → the dismissal test fails; an undismissable
 *     warning is one people learn to scroll past.
 *   • reveal all of a sender's media on one tap → the second-message test
 *     fails.
 *
 * Queries come from each `render`'s own return value rather than the module
 * `screen`, because several cases render twice and a shared `screen` makes it
 * ambiguous which tree an assertion is about.
 */

import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';

import { MessageSafetyBanner } from '../MessageSafetyBanner.tsx';
import { StrangerMediaShield } from '../StrangerMediaShield.tsx';
import type { MessageSafetySignals } from '../../types/index.ts';

function signals(over: Partial<MessageSafetySignals> = {}): MessageSafetySignals {
  return {
    scam: [{ family: 'URGENT_MONEY_REQUEST', severity: 'warning', matched: 'wire money today' }],
    links: [],
    severity: 'warning',
    ...over,
  };
}

describe('MessageSafetyBanner — §22 travel scam signals, rendered for the recipient', () => {
  it('renders nothing when the server sent no signals', async () => {
    const v = await render(<MessageSafetyBanner messageId="m1" signals={null} />);
    expect(v.queryByTestId('safety-banner-m1')).toBeNull();
  });

  it('renders nothing for an empty signal object rather than an empty box', async () => {
    const v = await render(
      <MessageSafetyBanner messageId="m1" signals={{ scam: [], links: [], severity: null }} />,
    );
    expect(v.queryByTestId('safety-banner-m1')).toBeNull();
  });

  it('names the pattern and gives advice a traveller can act on', async () => {
    const v = await render(<MessageSafetyBanner messageId="m1" signals={signals()} />);
    expect(v.getByTestId('safety-banner-m1')).toBeTruthy();
    expect(v.getByText('Urgent request for money')).toBeTruthy();
    expect(v.getByTestId('safety-advice-URGENT_MONEY_REQUEST')).toBeTruthy();
  });

  it('never shows the matched phrase back as an accusation — it shows advice', async () => {
    const v = await render(<MessageSafetyBanner messageId="m1" signals={signals()} />);
    // The raw match is deliberately not rendered: repeating the scammer's own
    // words as a headline reads as the app endorsing them.
    expect(v.queryByText('wire money today')).toBeNull();
  });

  it('describes a suspicious link in plain words', async () => {
    const v = await render(
      <MessageSafetyBanner
        messageId="m2"
        signals={{
          scam: [],
          links: [{ raw: 'https://bit.ly/x', host: 'bit.ly', findings: ['SHORTENER'], suspicious: true }],
          severity: 'caution',
        }}
      />,
    );
    expect(v.getByTestId('safety-link-note-m2')).toBeTruthy();
    expect(v.getByText(/shortened link that hides where it goes/)).toBeTruthy();
  });

  it('is dismissible, and stays dismissed', async () => {
    const v = await render(<MessageSafetyBanner messageId="m3" signals={signals()} />);
    await act(async () => {
      fireEvent.press(v.getByTestId('safety-banner-dismiss-m3'));
    });
    expect(v.queryByTestId('safety-banner-m3')).toBeNull();
  });

  it('offers Report when the screen gave it a handler', async () => {
    const onReport = jest.fn();
    const v = await render(<MessageSafetyBanner messageId="m4" signals={signals()} onReport={onReport} />);
    await act(async () => {
      fireEvent.press(v.getByTestId('safety-banner-report-m4'));
    });
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('omits Report when no handler was given', async () => {
    const v = await render(<MessageSafetyBanner messageId="m5" signals={signals()} />);
    expect(v.queryByTestId('safety-banner-report-m5')).toBeNull();
  });

  it('announces itself to a screen reader as an alert', async () => {
    const v = await render(<MessageSafetyBanner messageId="m6" signals={signals()} />);
    expect(v.getByTestId('safety-banner-m6').props.accessibilityRole).toBe('alert');
  });
});

describe('StrangerMediaShield — §22 stranger media, covered rather than blurred', () => {
  const Media = () => <Text testID="the-media">MEDIA</Text>;

  it('renders the media directly for a connected sender', async () => {
    const v = await render(
      <StrangerMediaShield messageId="s1" mediaKind="image" senderConnected>
        <Media />
      </StrangerMediaShield>,
    );
    expect(v.getByTestId('the-media')).toBeTruthy();
    expect(v.queryByTestId('stranger-media-shield-s1')).toBeNull();
  });

  it('DOES NOT MOUNT the media for an unconnected sender', async () => {
    const v = await render(
      <StrangerMediaShield messageId="s2" mediaKind="image" senderConnected={false}>
        <Media />
      </StrangerMediaShield>,
    );
    expect(v.getByTestId('stranger-media-shield-s2')).toBeTruthy();
    expect(v.queryByTestId('the-media')).toBeNull();
  });

  it('reveals on one tap, for that message only', async () => {
    const v = await render(
      <>
        <StrangerMediaShield messageId="a" mediaKind="image" senderConnected={false}>
          <Text testID="media-a">A</Text>
        </StrangerMediaShield>
        <StrangerMediaShield messageId="b" mediaKind="image" senderConnected={false}>
          <Text testID="media-b">B</Text>
        </StrangerMediaShield>
      </>,
    );
    await act(async () => {
      fireEvent.press(v.getByTestId('stranger-media-reveal-a'));
    });
    expect(v.getByTestId('media-a')).toBeTruthy();
    expect(v.queryByTestId('media-b')).toBeNull();
  });

  it('says the honest thing when the server could not establish the relationship', async () => {
    const v = await render(
      <StrangerMediaShield messageId="s3" mediaKind="video" senderConnected={false} degraded>
        <Media />
      </StrangerMediaShield>,
    );
    expect(v.getByText(/couldn't check how you know this person/i)).toBeTruthy();
  });

  it('labels a video as a video, so the reveal button says what it opens', async () => {
    const v = await render(
      <StrangerMediaShield messageId="s4" mediaKind="video" senderConnected={false}>
        <Media />
      </StrangerMediaShield>,
    );
    expect(v.getByText('Video hidden')).toBeTruthy();
    expect(v.getByLabelText('Show video')).toBeTruthy();
  });

  it('withholds media for §16.2 data saver, with its own reason', async () => {
    const v = await render(
      <StrangerMediaShield messageId="s5" mediaKind="image" senderConnected dataSaverOn>
        <Media />
      </StrangerMediaShield>,
    );
    expect(v.queryByTestId('the-media')).toBeNull();
    expect(v.getByTestId('stranger-media-reason-data_saver')).toBeTruthy();
  });

  it('a stranger outranks data saver in the copy — the risk reason wins', async () => {
    const v = await render(
      <StrangerMediaShield messageId="s6" mediaKind="image" senderConnected={false} dataSaverOn>
        <Media />
      </StrangerMediaShield>,
    );
    expect(v.getByTestId('stranger-media-reason-stranger')).toBeTruthy();
    expect(v.queryByTestId('stranger-media-reason-data_saver')).toBeNull();
  });
});
