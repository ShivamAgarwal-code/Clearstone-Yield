/**
 * Tests for `loadConfig` — env-var parsing for the keeper.
 *
 * Fail-fast on missing required vars; defaults applied to optional
 * knobs; boolean flags gated on "1". A regression here is how operators
 * get surprised by the keeper silently picking the wrong slippage or
 * running in dry-run when they expected production.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";

/** Build a valid array-format keypair file and return its path. */
function writeKeypairFixture(dir: string): { path: string; kp: Keypair } {
  const kp = Keypair.generate();
  const path = join(dir, "keypair.json");
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return { path, kp };
}

function withEnv<T>(overrides: Record<string, string | undefined>, block: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    original[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return block();
  } finally {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("loadConfig: throws when EDGE_URL is missing", () => {
  withEnv(
    {
      EDGE_URL: undefined,
      CURATOR_KEYPAIR: undefined,
    },
    () => {
      assert.throws(() => loadConfig(), /EDGE_URL/);
    }
  );
});

test("loadConfig: throws when CURATOR_KEYPAIR is missing", () => {
  withEnv(
    { EDGE_URL: "http://edge", CURATOR_KEYPAIR: undefined },
    () => {
      assert.throws(() => loadConfig(), /CURATOR_KEYPAIR/);
    }
  );
});

test("loadConfig: throws when CURATOR_KEYPAIR points at a non-array file", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
  try {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ not: "array" }));
    withEnv({ EDGE_URL: "http://edge", CURATOR_KEYPAIR: path }, () => {
      assert.throws(() => loadConfig(), /array keypair format/);
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig: defaults applied for optional vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
  try {
    const { path, kp } = writeKeypairFixture(dir);
    const cfg = withEnv(
      {
        EDGE_URL: "http://edge",
        CURATOR_KEYPAIR: path,
        SOLANA_RPC_URL: undefined,
        POLL_INTERVAL_SEC: undefined,
        MATURITY_GRACE_SEC: undefined,
        SLIPPAGE_BPS: undefined,
        ONE_SHOT: undefined,
        DRY_RUN: undefined,
      },
      loadConfig
    );
    assert.equal(cfg.edgeUrl, "http://edge");
    assert.equal(cfg.rpcUrl, "https://api.devnet.solana.com");
    assert.equal(cfg.pollIntervalSec, 60);
    assert.equal(cfg.maturityGraceSec, 30);
    assert.equal(cfg.slippageBps, 50);
    assert.equal(cfg.oneShot, false);
    assert.equal(cfg.dryRun, false);
    assert.equal(
      cfg.curatorKeypair.publicKey.toBase58(),
      kp.publicKey.toBase58()
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig: explicit env values override defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
  try {
    const { path } = writeKeypairFixture(dir);
    const cfg = withEnv(
      {
        EDGE_URL: "http://edge",
        CURATOR_KEYPAIR: path,
        SOLANA_RPC_URL: "https://mainnet.example",
        POLL_INTERVAL_SEC: "15",
        MATURITY_GRACE_SEC: "120",
        SLIPPAGE_BPS: "200",
        ONE_SHOT: "1",
        DRY_RUN: "1",
      },
      loadConfig
    );
    assert.equal(cfg.rpcUrl, "https://mainnet.example");
    assert.equal(cfg.pollIntervalSec, 15);
    assert.equal(cfg.maturityGraceSec, 120);
    assert.equal(cfg.slippageBps, 200);
    assert.equal(cfg.oneShot, true);
    assert.equal(cfg.dryRun, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loadConfig: ONE_SHOT / DRY_RUN only trip on '1', not 'true'/'yes'/'TRUE'", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-cfg-"));
  try {
    const { path } = writeKeypairFixture(dir);
    for (const val of ["true", "yes", "TRUE", "0", "", "on"]) {
      const cfg = withEnv(
        {
          EDGE_URL: "http://edge",
          CURATOR_KEYPAIR: path,
          ONE_SHOT: val,
          DRY_RUN: val,
        },
        loadConfig
      );
      assert.equal(
        cfg.oneShot,
        false,
        `ONE_SHOT="${val}" must not be truthy`
      );
      assert.equal(
        cfg.dryRun,
        false,
        `DRY_RUN="${val}" must not be truthy`
      );
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
