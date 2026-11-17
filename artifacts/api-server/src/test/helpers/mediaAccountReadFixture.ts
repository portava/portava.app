/** Explicit active viewer premise for media-focused query fakes. Account
 * transition and malformed-receipt cases use real SQL or their own RPC reply. */
export function activeMediaAccountRead(name: string, args: {p_user?: unknown} = {}) {
  return name === 'account_recovery_status'
    ? {data: {userId: args.p_user, accountStatus: 'active', mediaAccessAllowed: true}, error: null}
    : {data: null, error: {message: `RPC not modelled: ${name}`}};
}
