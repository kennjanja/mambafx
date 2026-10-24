export function createReversalDetector(){
  let lastPrice = null;
  let runDirection = 0;
  let runLength = 0;
  let fired = false;

  return {
    observe(price){
      const value = Number(price);
      if (!Number.isFinite(value)) return null;
      if (lastPrice === null){
        lastPrice = value;
        return null;
      }
      const direction = value > lastPrice ? 1 : value < lastPrice ? -1 : 0;
      lastPrice = value;
      if (direction === 0) return null;
      if (direction === runDirection) runLength++;
      else {
        runDirection = direction;
        runLength = 1;
        fired = false;
      }
      if (runLength < 5 || fired) return null;
      fired = true;
      return { pattern: direction > 0 ? "5R" : "5F", direction: direction > 0 ? "FALL" : "RISE" };
    },
    resetRun(){
      runDirection = 0;
      runLength = 0;
      fired = false;
    },
    reset(){
      lastPrice = null;
      runDirection = 0;
      runLength = 0;
      fired = false;
    },
  };
}

export function applyReversalSettlement(state, won){
  if (won){
    state.consecutiveLosses = 0;
    state.cycleStatus = "Won";
    state.awaitingNextCycle = true;
    return;
  }
  state.consecutiveLosses++;
  state.cycleStatus = "Active";
}

if (typeof window !== "undefined") window.MFXReversalAutoState = { createReversalDetector, applyReversalSettlement };
