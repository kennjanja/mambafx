import { readAccountBalance } from "./derivRequest.js?v=1";

function precisionValue(precision) {
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) throw new Error("Invalid accounting scale");
  return precision;
}

export function toMinor(value, precision) {
  precisionValue(precision);
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid monetary amount");
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) throw new Error("Invalid monetary amount");
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) throw new Error("Invalid monetary amount");
  const digits = match[2] + (match[3] || "");
  const shift = precision + exponent - (match[3] || "").length;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  const raw = BigInt(digits);
  if (raw % divisor !== 0n) throw new Error("Amount exceeds accounting scale");
  const units = shift >= 0 ? raw * 10n ** BigInt(shift) : raw / divisor;
  const signed = match[1] ? -units : units;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) throw new Error("Amount exceeds safe monetary range");
  return result;
}

export function toMajor(value, precision) {
  precisionValue(precision);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid minor-unit amount");
  const sign = value < 0 ? "-" : "", digits = String(Math.abs(value)).padStart(precision + 1, "0");
  const amount = Number(sign + (precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits));
  if (!Number.isFinite(amount) || toMinor(amount, precision) !== value) throw new Error("Amount cannot be represented safely");
  return amount;
}

function sourceSymbol(source) {
  let parts;
  try { parts = JSON.parse(source); } catch { throw new Error("Invalid live source"); }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== "deriv-public" ||
      typeof parts[1] !== "string" || !parts[1] || typeof parts[2] !== "string" || !/^\w{2,30}$/.test(parts[2]) ||
      !Number.isInteger(parts[3]) || parts[3] < 0 || parts[3] > 20) throw new Error("Invalid live source");
  return parts[2];
}

// The scale is for exact ledger arithmetic, not a claim about currency precision.
export function createDerivExecution({ request, account, precision, now = Date.now }) {
  if (typeof request !== "function" || typeof account !== "function") throw new Error("Deriv transport is required");
  precisionValue(precision);
  const proposals = new Map();
  function identity() {
    const current = account();
    if (!current?.connected || typeof current.accountId !== "string" || !current.accountId ||
        typeof current.isVirtual !== "boolean" || !Number.isSafeInteger(current.connectionGeneration)) {
      throw new Error("Authenticated account is unavailable");
    }
    return { accountId: current.accountId, isVirtual: current.isVirtual, generation: current.connectionGeneration };
  }
  function sameAccount(expected, currency) {
    const current = account();
    return current?.connected === true && current.accountId === expected.accountId &&
      current.isVirtual === expected.isVirtual && current.connectionGeneration === expected.generation &&
      current.currency === currency;
  }
  async function contract(contractId, order) {
    if (!/^[1-9]\d*$/.test(contractId) || !Number.isSafeInteger(Number(contractId)) || !order) throw new Error("Invalid contract identity");
    const result = await request({ proposal_open_contract: 1, contract_id: Number(contractId) }, "proposal_open_contract");
    if (String(result.contract_id) !== contractId || result.contract_type !== "DIGITMATCH" ||
        result.currency !== order.currency || result.underlying_symbol !== sourceSymbol(order.source) ||
        String(result.barrier) !== String(order.digit) || toMinor(result.buy_price, precision) !== order.stake ||
        (order.transactionId !== undefined && String(result.transaction_ids?.buy) !== order.transactionId)) {
      throw new Error("Contract details do not match the recorded purchase");
    }
    const rawTransactionId = result.transaction_ids?.buy;
    const transactionId = rawTransactionId == null ? undefined : String(rawTransactionId);
    if (transactionId !== undefined && (!/^[1-9]\d*$/.test(transactionId) || !Number.isSafeInteger(Number(transactionId)))) {
      throw new Error("Contract transaction identity is invalid");
    }
    if (result.is_sold === 0 && result.status === "open") {
      return { contractId, status: "open", ...(transactionId === undefined ? {} : { transactionId }) };
    }
    if (result.is_sold !== 1 || !["won", "lost"].includes(result.status)) {
      throw new Error("Contract status is incomplete or requires manual reconciliation");
    }
    const epoch = result.date_settlement ?? result.sell_time;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(epoch * 1000)) throw new Error("Contract settlement time is unavailable");
    return { contractId, status: result.status, profit: toMinor(result.profit, precision),
      payout: toMinor(result.sell_price, precision), settledAt: epoch * 1000,
      ...(transactionId === undefined ? {} : { transactionId }) };
  }
  async function recover(order, knownContractIds = []) {
    const original = identity(), current = account();
    if (current.tradeAuthorized !== true || order?.accountId !== original.accountId ||
        order.currency !== current.currency || !Number.isSafeInteger(order.purchaseStartedAt) ||
        order.purchaseStartedAt < 0 || !Number.isSafeInteger(now()) || now() < order.purchaseStartedAt) {
      throw new Error("Purchase recovery requires the original authorized account and timestamp");
    }
    const symbol = sourceSymbol(order.source);
    const started = Math.floor(order.purchaseStartedAt / 1000);
    const currentTime = Math.floor(now() / 1000);
    const dateFrom = Math.max(0, started - 3), dateTo = currentTime + 3;
    const [portfolio, statement] = await Promise.all([
      request({ portfolio: 1 }, "portfolio"),
      request({ statement: 1, action_type: "buy", date_from: dateFrom, date_to: dateTo, description: 1, limit: 999 }, "statement"),
    ]);
    if (!sameAccount(original, order.currency) || !Array.isArray(portfolio.contracts) ||
        !Array.isArray(statement.transactions)) throw new Error("Deriv purchase recovery response is incomplete");
    const excluded = new Set(knownContractIds.map(String));
    const candidates = new Map();
    function addCandidate(id, transactionId) {
      const contractId = String(id);
      if (!/^[1-9]\d*$/.test(contractId) || !Number.isSafeInteger(Number(contractId)) || excluded.has(contractId)) return;
      const previous = candidates.get(contractId);
      if (previous?.transactionId && transactionId && previous.transactionId !== String(transactionId)) {
        throw new Error("Deriv recovery returned conflicting transaction identities");
      }
      candidates.set(contractId, { contractId, transactionId: transactionId ? String(transactionId) : previous?.transactionId });
    }
    for (const item of portfolio.contracts) {
      const purchaseTime = Number(item.purchase_time ?? item.date_start);
      if (item.contract_type === "DIGITMATCH" && item.currency === order.currency &&
          item.underlying_symbol === symbol && toMinor(item.buy_price, precision) === order.stake &&
          Number.isSafeInteger(purchaseTime) && purchaseTime >= dateFrom && purchaseTime <= dateTo) {
        addCandidate(item.contract_id, item.transaction_id);
      }
    }
    for (const item of statement.transactions) {
      const contractId = Number(item.contract_id), transactionId = Number(item.transaction_id);
      const transactionTime = Number(item.transaction_time);
      if (item.action_type !== "buy" || item.contract_id == null ||
          !Number.isSafeInteger(contractId) || contractId <= 0 || !Number.isSafeInteger(transactionId) || transactionId <= 0 ||
          !Number.isSafeInteger(transactionTime) || transactionTime < dateFrom || transactionTime > dateTo ||
          Math.abs(toMinor(item.amount, precision)) !== order.stake) continue;
      addCandidate(contractId, transactionId);
    }
    const matches = [];
    for (const candidate of candidates.values()) {
      let verified;
      try {
        verified = await contract(candidate.contractId, { ...order, transactionId: candidate.transactionId });
      } catch (error) {
        if (error.message === "Contract details do not match the recorded purchase") continue;
        throw error;
      }
      matches.push({ contract: verified, transactionId: verified.transactionId || candidate.transactionId });
    }
    if (!sameAccount(original, order.currency)) throw new Error("Account changed during purchase recovery");
    if (!matches.length) return { status: "not_found" };
    if (matches.length !== 1) return { status: "ambiguous" };
    return { status: "found", ...matches[0] };
  }
  return {
    async proposal({ source, digit, stake, durationTicks }) {
      if (!Number.isInteger(digit) || digit < 0 || digit > 9 || !Number.isInteger(durationTicks) ||
          durationTicks < 1 || durationTicks > 10 || !Number.isSafeInteger(stake) || stake <= 0 ||
          stake % (10 ** Math.max(precision - 2, 0)) !== 0) throw new Error("Invalid contract parameters");
      const original = identity(), symbol = sourceSymbol(source);
      const balance = await readAccountBalance(request, account);
      if (!sameAccount(original, balance.currency)) throw new Error("Account changed while preparing proposal");
      const symbols = await request({ active_symbols: "brief", contract_type: ["DIGITMATCH"] }, "active_symbols");
      if (!Array.isArray(symbols) || !symbols.some(row => row.underlying_symbol === symbol &&
          row.exchange_is_open === 1 && row.is_trading_suspended === 0)) throw new Error("Live source is not an available trading symbol");
      if (!sameAccount(original, balance.currency)) throw new Error("Account changed while preparing proposal");
      const result = await request({ proposal: 1, amount: toMajor(stake, precision), basis: "stake",
        contract_type: "DIGITMATCH", currency: balance.currency, duration: durationTicks,
        duration_unit: "t", underlying_symbol: symbol, barrier: String(digit) }, "proposal");
      if (!sameAccount(original, balance.currency)) throw new Error("Account changed during proposal");
      const askPrice = toMinor(result.ask_price, precision);
      if (typeof result.id !== "string" || !result.id || askPrice <= 0) throw new Error("Invalid contract proposal");
      proposals.clear();
      proposals.set(result.id, { ...original, currency: balance.currency, askPrice });
      return { id: result.id, askPrice };
    },
    async buy(proposalId, stake) {
      if (typeof proposalId !== "string" || !proposalId || !Number.isSafeInteger(stake) || stake <= 0) throw new Error("Invalid purchase");
      const proposal = proposals.get(proposalId), current = account();
      if (!proposal || proposal.askPrice !== stake || !sameAccount(proposal, proposal.currency) ||
          current.tradeAuthorized !== true) throw new Error("Trade authorization or original proposal is unavailable");
      proposals.delete(proposalId);
      const result = await request({ buy: proposalId, price: toMajor(stake, precision) }, "buy");
      if (!Number.isSafeInteger(result.contract_id) || result.contract_id <= 0 ||
          !Number.isSafeInteger(result.transaction_id) || result.transaction_id <= 0) throw new Error("Incomplete purchase receipt");
      return { contractId: String(result.contract_id), transactionId: String(result.transaction_id),
        buyPrice: toMinor(result.buy_price, precision) };
    },
    async serverTime() {
      const epoch = await request({ time: 1 }, "time");
      if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(epoch * 1000)) throw new Error("Invalid server time");
      return epoch * 1000;
    },
    contract,
    recover,
  };
}
