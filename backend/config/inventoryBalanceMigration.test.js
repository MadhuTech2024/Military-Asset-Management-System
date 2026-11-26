import test from "node:test";
import assert from "node:assert/strict";
import { PreventNegativeInventoryBalance1795551900000 } from "./migrations/1795551900000-PreventNegativeInventoryBalance.js";
import { AlignInventoryBalanceTimeSemantics1795601814000 } from "./migrations/1795601814000-AlignInventoryBalanceTimeSemantics.js";

test("inventory balance migration serializes movement writes and rejects negative stock", async () => {
  const statements = [];
  const migration = new PreventNegativeInventoryBalance1795551900000();

  await migration.up({
    async query(sql) {
      statements.push(sql);
    },
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0], /SECURITY INVOKER/u);
  assert.match(statements[0], /SET search_path = pg_catalog, public, pg_temp/u);
  assert.match(statements[0], /FROM public\.asset asset[\s\S]*FOR UPDATE/u);
  assert.match(statements[0], /FROM public\.inventory_movement movement/u);
  assert.match(statements[0], /WHEN 'IN' THEN movement\.quantity::numeric/u);
  assert.match(statements[0], /v_projected_balance < 0/u);
  assert.match(
    statements[0],
    /BEFORE INSERT ON public\.inventory_movement/u,
  );
});

test("inventory balance migration rollback removes only its trigger and function", async () => {
  const statements = [];
  const migration = new PreventNegativeInventoryBalance1795551900000();

  await migration.down({
    async query(sql) {
      statements.push(sql);
    },
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0], /DROP TRIGGER IF EXISTS trg_validate_inventory_balance/u);
  assert.match(
    statements[0],
    /DROP FUNCTION IF EXISTS public\.validate_inventory_balance\(\)/u,
  );
});

test("current inventory migration validates movements at their event timestamp", async () => {
  const statements = [];
  const migration = new AlignInventoryBalanceTimeSemantics1795601814000();

  await migration.up({
    async query(sql) {
      statements.push(sql);
    },
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0], /NEW\.occurred_at > pg_catalog\.clock_timestamp\(\)/u);
  assert.match(statements[0], /asset\.opening_at <= NEW\.occurred_at/u);
  assert.match(
    statements[0],
    /movement\.occurred_at <= NEW\.occurred_at/u,
  );
  assert.doesNotMatch(statements[0], /GREATEST\([\s\S]*NEW\.occurred_at/u);
  assert.match(statements[0], /Inventory movement cannot be future-dated/u);
  assert.match(statements[0], /SECURITY INVOKER/u);
  assert.match(
    statements[0],
    /SET search_path = pg_catalog, public, pg_temp/u,
  );
  assert.doesNotMatch(statements[0], /CREATE TRIGGER/u);
});

test("current inventory migration rollback restores the previous balance guard", async () => {
  const statements = [];
  const migration = new AlignInventoryBalanceTimeSemantics1795601814000();

  await migration.down({
    async query(sql) {
      statements.push(sql);
    },
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0], /CREATE OR REPLACE FUNCTION public\.validate_inventory_balance/u);
  assert.doesNotMatch(statements[0], /opening_at|occurred_at/u);
  assert.match(statements[0], /FOR UPDATE/u);
});
