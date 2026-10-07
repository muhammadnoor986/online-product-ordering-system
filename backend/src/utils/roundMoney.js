// Rounds money to 2 decimals so sums like 0.1 + 0.2 become exactly 0.3.
// Every price, line total and order total goes through this one function.
const roundMoney = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;

module.exports = roundMoney;
