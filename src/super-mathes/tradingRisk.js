// Monetary inputs are integer minor units in the connected account's currency.
function money(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive && value <= 0)) throw new Error(`Invalid ${label}`);
  return value;
}

export function accountDay(timestamp, timeZone) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || typeof timeZone !== "string" || !timeZone) {
    throw new Error("Account time zone and timestamp are required");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = name => parts.find(item => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function assessTradeRisk({ config, account, session, cycle, feed }) {
  if (!config || !account || !session || !cycle || !feed) throw new Error("Missing trading risk inputs");
  const base = money(config.baseStake, "base stake", { positive: true });
  const maximumStake = money(config.maximumStake, "maximum stake", { positive: true });
  const maximumExposure = money(config.maximumExposure, "cycle exposure", { positive: true });
  const cycleLoss = money(config.cycleLoss, "cycle stop loss", { positive: true });
  const sessionLoss = money(config.sessionLoss, "session stop loss", { positive: true });
  const cycleTarget = money(config.cycleTarget, "cycle target", { positive: true });
  const sessionTarget = money(config.sessionTarget, "session target", { positive: true });
  const dailyTarget = money(config.dailyTarget, "daily target", { positive: true });
  const pnl = money(session.pnl, "session profit and loss");
  const uncertainExposure = money(session.uncertainExposure ?? 0, "unconfirmed purchase exposure");
  const dailyPnl = money(session.dailyPnl, "daily profit and loss");
  const cyclePnl = money(cycle.pnl, "cycle profit and loss");
  const staked = money(cycle.staked, "cycle amount staked");
  const balance = money(account.balance, "account balance");
  if (staked < 0 || balance < 0 || uncertainExposure < 0 || !Number.isSafeInteger(pnl - uncertainExposure) ||
      !Number.isSafeInteger(cycle.losses) || cycle.losses < 0 || cycle.losses > 1000 ||
      !Number.isSafeInteger(cycle.attempts) || cycle.attempts < 0 ||
      cycle.losses > cycle.attempts ||
      !Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 0 ||
      !Number.isSafeInteger(config.multiplierNumerator) || !Number.isSafeInteger(config.multiplierDenominator) ||
      config.multiplierDenominator <= 0 || config.multiplierNumerator < config.multiplierDenominator ||
      config.multiplierNumerator > 10 * config.multiplierDenominator || typeof config.martingale !== "boolean") {
    throw new Error("Invalid cycle or staking configuration");
  }
  const refuse = reason => ({ allowed: false, reason });
  if (account.connected !== true || account.authorized !== true || typeof account.id !== "string" || !account.id ||
      typeof account.currency !== "string" || !account.currency ||
      typeof account.isVirtual !== "boolean" || account.id !== session.accountId ||
      account.isVirtual !== session.isVirtual || account.currency !== session.currency) return refuse("Account unavailable or changed");
  if (feed.continuous !== true || typeof cycle.source !== "string" || !cycle.source || feed.source !== cycle.source) return refuse("Feed continuity unavailable");
  if (cycle.unresolved !== false) return refuse("A purchase or contract is unresolved");
  if (pnl - uncertainExposure <= -sessionLoss || cyclePnl <= -cycleLoss) return refuse("Stop loss reached");
  if (pnl >= sessionTarget || cyclePnl >= cycleTarget || dailyPnl >= dailyTarget) return refuse("Profit target reached");
  if (config.maxAttempts && cycle.attempts >= config.maxAttempts) return refuse("Maximum attempts reached");

  let stake = BigInt(base);
  if (config.martingale) {
    const numerator = BigInt(config.multiplierNumerator), denominator = BigInt(config.multiplierDenominator);
    for (let n = 0; n < cycle.losses; n++) {
      stake = (stake * numerator + denominator - 1n) / denominator;
      if (stake > BigInt(maximumStake)) return refuse("Maximum stake exceeded");
    }
  }
  if (stake > BigInt(maximumStake)) return refuse("Maximum stake exceeded");
  if (stake + BigInt(staked) > BigInt(maximumExposure)) return refuse("Maximum cycle exposure exceeded");
  if (stake > BigInt(balance)) return refuse("Insufficient balance");
  if (BigInt(pnl) - BigInt(uncertainExposure) - stake < -BigInt(sessionLoss)) return refuse("Stake could exceed session stop loss");
  if (BigInt(cyclePnl) - stake < -BigInt(cycleLoss)) return refuse("Stake could exceed cycle stop loss");
  return { allowed: true, stake: Number(stake) };
}
