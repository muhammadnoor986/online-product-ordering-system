// Every waiting budget in the E2E code goes through scaled(). On a normal machine the numbers are used as written.
// On a slow or busy machine (a shared CI server, a laptop doing a big build) set E2E_TIMEOUT_SCALE=3 (or more)
// and all of them grow together. Waits end as soon as their event happens, so a bigger budget costs nothing when the
// machine is fast. (It never changes WHAT is waited for.)
const SCALE = Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1);

const scaled = (milliseconds) => Math.round(milliseconds * SCALE);

module.exports = { scaled, SCALE };
