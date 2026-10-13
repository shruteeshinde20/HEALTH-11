// Password rules of the API (backend/app/auth.py check_password_strength),
// checked in the browser too so people see the problem before sending.

export const PASSWORD_HINT =
  "12 to 72 characters, with a lowercase letter, an uppercase letter, a digit and a special character.";

/** The first rule a password breaks, or null when it is acceptable. */
export function passwordProblem(value: string): string | null {
  if (value.length < 12) return "Use at least 12 characters.";
  if (new TextEncoder().encode(value).length > 72) return "Use at most 72 characters (fewer with accented letters).";
  if (!/\p{Ll}/u.test(value)) return "Add a lowercase letter.";
  if (!/\p{Lu}/u.test(value)) return "Add an uppercase letter.";
  if (!/\p{Nd}/u.test(value)) return "Add a digit.";
  if (!/[^\p{L}\p{N}]/u.test(value)) return "Add a special character, such as ! or #.";
  return null;
}
