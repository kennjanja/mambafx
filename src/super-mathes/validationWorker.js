import { independentValidation } from "./independentValidation.js?v=3";

self.onmessage = event => {
  try { self.postMessage({ result: independentValidation(event.data.observations, event.data.options) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
