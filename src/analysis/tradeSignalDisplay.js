// Presentation only: consume the engine's reported gates and diagnostic progress.
import { MODEL_REGISTRY } from './tradeSignalArchitecture.js?v=fvg2';

const TERMINAL = {
  'Invalidated Before Entry': ['INVALIDATED BEFORE ENTRY', 'bad'],
  'Expired Without Entry': ['EXPIRED WITHOUT ENTRY', 'bad'],
  Opposed: ['OPPOSED', 'bad'],
  'Insufficient Data': ['INSUFFICIENT DATA', 'neutral'],
  Closed: ['CLOSED', 'neutral'],
};

const stepLabel = (step) => step.replace(/-/g, ' ');

export function tradeSignalDisplay(sig) {
  const lifecycle = sig.lifecycleState;
  const terminal = TERMINAL[lifecycle];
  const biasVerdict = sig.bias?.verdict;
  const biasText = biasVerdict === 'bullish-lean' ? 'Bullish' : biasVerdict === 'bearish-lean' ? 'Bearish'
    : biasVerdict === 'insufficient-data' ? 'Insufficient data' : biasVerdict === 'inconclusive' ? 'Neutral' : 'Unavailable';
  const biasStatus = ['Bullish', 'Bearish'].includes(biasText) ? 'PASSED'
    : biasText === 'Neutral' ? 'NOT MET' : 'NOT AVAILABLE';
  const location = sig.layers?.location;
  const locationPassed = location?.status === 'Approaching Location';
  const locationStatus = locationPassed ? 'PASSED' : location?.status === 'Watching' ? 'PENDING' : 'NOT AVAILABLE';
  const item = sig.primaryModel?.location || location?.evidence?.[0];
  const locationText = item?.label || (Number.isFinite(sig.nearestLevel) ? `Nearest level ${sig.nearestLevel}` : 'No location details reported');
  const entry = sig.layers?.entry;
  const entryPassed = entry?.status === 'Trigger Detected';
  const entryStatus = entryPassed ? 'PASSED' : entry?.status === 'Watching' ? 'PENDING' : 'NOT AVAILABLE';
  const qualified = !terminal && sig.status === 'signal' && sig.layers?.signal === true;
  const progress = sig.modelProgress?.best;
  const model = sig.primaryModel || progress;
  const modelId = model?.model_id || model?.id;
  const definition = MODEL_REGISTRY.find((m) => m.model_id === modelId);
  const count = progress && progress.id === modelId ? progress.matched : null;
  const sequence = definition?.sequence;
  const reportedEvents = sig.primaryModel?.confirmingEvents?.map((e) => e.label || stepLabel(e.type)) || [];
  const complete = sig.primaryModel ? true : Number.isInteger(count) && count === sequence?.length;
  const sequenceStatus = sig.primaryModel ? 'Confirmed by model'
    : !sequence || !Number.isInteger(count) ? 'Not available'
      : complete ? 'Sequence complete; model qualification not confirmed' : `In progress (${count}/${sequence.length})`;
  // Progress is a diagnostic ordered prefix, not a model qualification result.
  const confirmed = reportedEvents.length ? reportedEvents
    : sequence && Number.isInteger(count) ? sequence.slice(0, count).map(stepLabel) : [];
  const remaining = !sig.primaryModel && sequence && Number.isInteger(count) ? sequence.slice(count).map(stepLabel) : [];
  let overall, tone;
  if (terminal) [overall, tone] = terminal;
  else if (sig.status === 'insufficient') [overall, tone] = ['INSUFFICIENT DATA', 'neutral'];
  else if (qualified) [overall, tone] = ['QUALIFIED - ENTRY CONFIRMED', 'good'];
  else if (sig.status === 'signal') [overall, tone] = ['SIGNAL ACTIVE - DETAILS UNAVAILABLE', 'neutral'];
  else if (sig.layers?.missingLayer === 'Location Gate') [overall, tone] = ['WAITING FOR LOCATION', 'pending'];
  else if (sig.layers?.missingLayer === 'Entry Confirmation') [overall, tone] = ['WAITING FOR ENTRY CONFIRMATION', 'pending'];
  else if (lifecycle === 'Approaching Location') [overall, tone] = ['APPROACHING LOCATION', 'pending'];
  else if (lifecycle === 'Bias Identified') [overall, tone] = ['BIAS IDENTIFIED', 'pending'];
  else if (lifecycle === 'Watching') [overall, tone] = ['WATCHING', 'pending'];
  else if (sig.status === 'wait') [overall, tone] = ['OPPOSED', 'bad'];
  else [overall, tone] = ['NO SETUP', 'neutral'];
  const terminalReason = terminal && sig.lifecycleHistory?.at(-1)?.reason;
  let reason = terminalReason || sig.reason || sig.waitingCondition || location?.reason || 'No further detail reported.';
  if (!terminal && sig.layers?.missingLayer === 'Entry Confirmation' && complete && !sig.primaryModel)
    reason = 'The diagnostic sequence is complete, but the model is not qualified. The engine does not report the specific unmet requirement.';
  return {
    overall, tone, lifecycle: lifecycle || 'Not reported', biasText, biasStatus,
    balance: Number.isFinite(sig.overallBalance) ? sig.overallBalance : Number.isFinite(sig.bias?.balance) ? sig.bias.balance : null,
    locationStatus, locationText,
    locationDetail: locationPassed ? (location.reason || 'Context-aligned location reported') : (location?.reason || 'Location gate not evaluated'),
    entryStatus, modelName: modelId ? `Model ${modelId}: ${model.name || definition?.name || 'name unavailable'}` : 'Model not evaluated',
    sequenceStatus, confirmed, remaining, reason,
    authorization: qualified ? 'Signal eligible; account and order checks not evaluated here' : terminal ? 'Not available for this terminal setup'
      : sig.status === 'signal' ? 'Not available until qualification details are refreshed' : 'No qualified signal',
  };
}
