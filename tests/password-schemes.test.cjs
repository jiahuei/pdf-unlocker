"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { derivePassword } = require("../src/password-schemes.js");

/** Ensures manual passwords remain verbatim and blank/whitespace input keeps the existing default. */
test("manual passwords and default", () => {
  for (const password of ["", " \t "])
    assert.equal(derivePassword("manual", { password }), "password");
  for (const password of ["  secret  ", "01Jan1980", "Case+Sensitive!", "秘密"])
    assert.equal(derivePassword("manual", { password }), password);
});

/** Ensures RHB joins the exact four-character suffix with a timezone-independent YYMMDD date. */
test("RHB suffix and date", () => {
  assert.equal(
    derivePassword("rhb", { rhbSuffix: "789A", rhbDate: "1981-07-29" }),
    "789A810729",
  );
  assert.equal(
    derivePassword("rhb", { rhbSuffix: " ab9Z ", rhbDate: "2000-02-29" }),
    "ab9Z000229",
  );
  assert.equal(
    derivePassword("rhb", { rhbSuffix: "A-12", rhbDate: "1999-12-31" }),
    "A-12991231",
  );
  for (const rhbSuffix of ["", "789", "123456789A", "7 9A"])
    assert.throws(
      () => derivePassword("rhb", { rhbSuffix, rhbDate: "1981-07-29" }),
      (error) => error.field === "rhbSuffix",
    );
});

/** Ensures invalid calendar dates, leap-century rules and incomplete dates fail on the relevant field. */
test("calendar date validation", () => {
  for (const date of [
    "",
    "1980-1-01",
    "0000-01-01",
    "1900-02-29",
    "2023-02-29",
    "2024-04-31",
    "2024-00-01",
    "2024-13-01",
    "2024-01-00",
    "2024-01-32",
    "2024-02-30",
  ]) {
    assert.throws(
      () => derivePassword("rhb", { rhbSuffix: "789A", rhbDate: date }),
      (error) => error.field === "rhbDate",
    );
    assert.throws(
      () => derivePassword("maybank", { maybankDate: date }),
      (error) => error.field === "maybankDate",
    );
  }
  assert.equal(
    derivePassword("maybank", { maybankDate: "2000-02-29" }),
    "29Feb2000",
  );
  assert.equal(
    derivePassword("maybank", { maybankDate: "2024-02-29" }),
    "29Feb2024",
  );
});

/** Ensures Maybank uses fixed English month abbreviations with zero-padded day and four-digit year. */
test("Maybank English date format", () => {
  for (const [index, month] of [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].entries())
    assert.equal(
      derivePassword("maybank", {
        maybankDate: `1980-${String(index + 1).padStart(2, "0")}-01`,
      }),
      `01${month}1980`,
    );
});

/** Ensures common Malaysian local/international phone formats derive the supplied TNG password. */
test("TNG mobile normalization", () => {
  for (const tngMobile of [
    "1123456789",
    "01123456789",
    "011-23456789",
    "+6011-23456789",
    "00601123456789",
    "601123456789",
    " +60 (0)11 2345 6789 ",
    "(011) 2345.6789",
  ])
    assert.equal(derivePassword("tng", { tngMobile }), "1123456789");
  assert.equal(
    derivePassword("tng", { tngMobile: "012-3456789" }),
    "123456789",
  );
  assert.equal(
    derivePassword("tng", { tngMobile: "019-34567890" }),
    "1934567890",
  );
});

/** Ensures phone parsing rejects letters, foreign prefixes, duplicated symbols and wrong lengths. */
test("TNG mobile validation", () => {
  for (const tngMobile of [
    "",
    " ",
    "+6011-23456789abc",
    "011e23456789",
    "+651123456789",
    "00651123456789",
    "60+1123456789",
    "+60+1123456789",
    "001123456789",
    "011234",
    "0112345678901",
    "0312345678",
    "1234567890 ext 1",
    "011/23456789",
  ])
    assert.throws(
      () => derivePassword("tng", { tngMobile }),
      (error) => error.field === "tngMobile",
    );
});

/** Ensures an unknown method cannot silently fall back to a guessed password. */
test("unknown method", () => {
  assert.throws(
    () => derivePassword("unknown", {}),
    (error) => error.field === "passwordScheme",
  );
});
