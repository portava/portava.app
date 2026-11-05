import { accountAppealContact } from '../accountAppealContact.ts';

it('admits an HTTPS owner-configured helpdesk without adding account information', () => {
  expect(accountAppealContact('https://support.example.com/account-review')).toBe('https://support.example.com/account-review');
});
it.each(['', 'javascript:alert(1)', 'http://support.example.com', 'https://user:secret@support.example.com', 'https://localhost', 'https://support.example.com/#token'])('rejects unsafe contact %s', raw => {
  expect(accountAppealContact(raw)).toBeNull();
});
