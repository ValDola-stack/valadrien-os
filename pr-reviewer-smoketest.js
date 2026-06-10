// Smoke-test fixture for the PR reviewer (Korije). Safe to delete.
function sumRange(n) {
  // intent: sum of 0..n inclusive
  let total = 0;
  for (let i = 0; i < n; i++) total += i;
  return total;
}

function getUserName(user) {
  return user.name.toUpperCase();
}

module.exports = { sumRange, getUserName };
