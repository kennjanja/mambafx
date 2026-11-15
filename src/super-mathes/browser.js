import { createLiveResearch } from "./live.js";
import { attachDashboard } from "./dashboard.js";

window.SuperMathes = createLiveResearch();
attachDashboard(window.SuperMathes);
