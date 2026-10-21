import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';
import { LayoverTimingEvidenceCard, LayoverActivityTimingNote } from '../LayoverTimingEvidenceCard.tsx';
afterEach(cleanup);
const now=Date.parse('2030-06-14T09:00:00Z');
const stages=['deplane','arrival_immigration','baggage_claim','airport_exit','outbound_transport','return_transport','security_reentry','baggage_recheck','terminal_transfer','boarding_buffer','contingency'];
const estimate={valueMinutes:10,p50Minutes:10,p75Minutes:15,p90Minutes:22,confidence:'MEDIUM',sourceClass:'HISTORICAL',observedAt:'2030-06-14T08:00:00Z',expiresAt:'2030-06-14T10:00:00Z',sourceRefs:['https://example.test/observed-data']};
const estimates=(value:unknown=estimate)=>({stageLadder:{percentile:'p90',stages:stages.map(stage=>({stage,estimate:stage==='deplane'?value:null}))}});
test('source-backed stage quantiles and each absent stage are disclosed without a whole-journey claim',async()=>{
 const r=await render(<LayoverTimingEvidenceCard estimates={estimates()} nowMs={now}/>);await fireEvent.press(r.getByLabelText('Timing evidence by journey stage'));
 expect(r.getByText('Observed p50 10 min · p75 15 min · p90 22 min')).toBeTruthy();expect(r.getByText('https://example.test/observed-data')).toBeTruthy();expect(r.getByText('Reach the terminal and gate')).toBeTruthy();expect(r.getAllByText(/No current stage observations/)).toHaveLength(10);expect(r.getByText(/Separate stage percentiles are not a whole-journey percentile/)).toBeTruthy();
});
test('expired or malformed samples never show current percentile numbers',async()=>{
 for(const invalid of [{...estimate,expiresAt:'2030-06-14T08:59:59Z'},{...estimate,p90Minutes:2},{...estimate,sourceClass:'STATIC_DEFAULT'}]){const r=await render(<LayoverTimingEvidenceCard estimates={estimates(invalid)} nowMs={now}/>);await fireEvent.press(r.getByLabelText('Timing evidence by journey stage'));expect(r.queryByText(/Observed p50/)).toBeNull();await cleanup();}
});
test('missing/partial stage contract stays absent; it cannot manufacture a complete ladder',async()=>{
 expect((await render(<LayoverTimingEvidenceCard estimates={{}} nowMs={now}/>)).queryByTestId('layover-timing-evidence')).toBeNull();
});
test('actual commitment and exit delay are visible, while expired or absent source terms stay unknown',async()=>{
 const commitment={interruptibility:'committed',minimumCommitmentMinutes:60,exitDelayMinutes:12,expiresAt:'2030-06-14T10:00:00Z'};
 const r=await render(<LayoverActivityTimingNote routing={{activityCommitment:commitment}} nowMs={now}/>);expect(r.getByText(/Cannot leave early: 60 min minimum commitment/)).toBeTruthy();expect(r.getByText(/Allow 12 min to leave/)).toBeTruthy();
 await r.rerender(<LayoverActivityTimingNote routing={{activityCommitment:{...commitment,expiresAt:'2030-06-14T08:59:59Z'}}} nowMs={now}/>);expect(r.getByText(/could not be confirmed/)).toBeTruthy();expect(r.queryByText(/Cannot leave early/)).toBeNull();
});
