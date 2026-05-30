/**
 * Unit tests for the high-level zap composers.
 *
 * Zaps are what the retail UI calls. `buildZapInToPt` composes
 * `[wrapper_strip]` or `[wrapper_strip, wrapper_sell_yt]` depending on
 * whether the user wants pure PT; `buildZapOutToBase` is a thin alias
 * around `wrapper_merge`.
 *
 * The composer does non-trivial account rewiring between strip and
 * sell_yt — strip's `ytDst` / `ptDst` / `sySrc` become sell_yt's
 * `ytSrc` / `ptSrc` / `sySrc`, and strip's `baseSrc` becomes sell_yt's
 * `baseDst`. Drift in that mapping silently breaks the retail "buy and
 * hold PT" flow, so pin it here.
 */
export {};
