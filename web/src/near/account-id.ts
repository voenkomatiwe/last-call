// NEAR account IDs: 2 to 64 characters, lowercase alphanumeric parts joined by single `-`, `_`, or `.`.
const ACCOUNT_ID_PATTERN = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(accountId: string): boolean {
  return accountId.length >= 2 && accountId.length <= 64 && ACCOUNT_ID_PATTERN.test(accountId);
}
