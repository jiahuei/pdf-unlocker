"use strict";

const StatementPasswords = (() => {
  const months = [
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
  ];

  function invalid(field, message) {
    const error = new Error(message);
    error.field = field;
    throw error;
  }

  function dateParts(value, field) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) invalid(field, "Enter a valid date.");
    const [, year, month, day] = match;
    const leap =
      Number(year) % 4 === 0 &&
      (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      !Number(year) ||
      Number(month) < 1 ||
      Number(month) > 12 ||
      Number(day) < 1 ||
      Number(day) > days[Number(month) - 1]
    )
      invalid(field, "Enter a valid calendar date.");
    return { year, month, day };
  }

  function mobilePassword(value) {
    const entered = value.trim();
    if (!/^[+\d\s().-]+$/.test(entered))
      invalid(
        "tngMobile",
        "Enter your registered Malaysian mobile number using digits and phone separators.",
      );
    let digits = entered.replace(/[\s().-]/g, "");
    if (digits.startsWith("+60")) digits = digits.slice(3);
    else if (digits.startsWith("0060")) digits = digits.slice(4);
    else if (digits.startsWith("60")) digits = digits.slice(2);
    else if (digits.startsWith("+") || digits.startsWith("00"))
      invalid(
        "tngMobile",
        "Use a Malaysian mobile number with country code +60 or a local number.",
      );
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (!/^1\d{8,9}$/.test(digits))
      invalid(
        "tngMobile",
        "Enter a Malaysian mobile number, such as 011-23456789 or +6011-23456789.",
      );
    return digits;
  }

  function derivePassword(scheme, values) {
    if (scheme === "manual")
      return values.password.trim() ? values.password : "password";
    if (scheme === "rhb") {
      const suffix = values.rhbSuffix.trim();
      if (Array.from(suffix).length !== 4 || /\s/.test(suffix))
        invalid(
          "rhbSuffix",
          "Enter exactly the last four characters of your ID or business registration number.",
        );
      const date = dateParts(values.rhbDate, "rhbDate");
      return `${suffix}${date.year.slice(-2)}${date.month}${date.day}`;
    }
    if (scheme === "tng") return mobilePassword(values.tngMobile);
    if (scheme === "maybank") {
      const date = dateParts(values.maybankDate, "maybankDate");
      return `${date.day}${months[Number(date.month) - 1]}${date.year}`;
    }
    invalid("passwordScheme", "Choose a password method.");
  }

  return { derivePassword };
})();

if (typeof module !== "undefined" && module.exports)
  module.exports = StatementPasswords;
