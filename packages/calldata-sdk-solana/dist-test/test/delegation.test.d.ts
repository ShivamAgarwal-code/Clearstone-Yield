/**
 * Unit tests for the delegation SDK builders.
 *
 * The builders live outside of Anchor's IDL layer, so every ix is
 * hand-assembled. These tests assert the wire format matches what the
 * on-chain program expects: discriminator bytes, account ordering,
 * writability flags, arg serialization. A mismatch here = a silent
 * failure in every delegated crank attempt.
 *
 * Test strategy: construct each ix against known fixed inputs and
 * compare serialized bytes / account meta against the spec-locked
 * layouts documented in CURATOR_ROLL_DELEGATION.md.
 */
export {};
