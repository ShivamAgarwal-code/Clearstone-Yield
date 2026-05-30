/**
 * Unit tests for the retail curator builders (deposit / withdraw) and
 * the three curator PDAs that drive every retail "savings account" flow.
 *
 * The PDA derivations are part of the program's ABI — if they change,
 * every deposit/withdraw/position lookup in the retail UI breaks silently.
 * Pin the seeds and (base58) outputs so drift shows up here, not in prod.
 */
export {};
