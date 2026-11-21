import { compilePerformance, describePerformance } from '../desktop/performance-config.js';
import { request } from './control.js';

export async function listActions(reload = false, includeConfigPath = false) {
  try {
    return await request({ type: 'actions', reload, includeConfigPath });
  } catch (error) {
    if (reload || includeConfigPath || error.code !== 'NOT_RUNNING') throw error;
    const defaults = describePerformance(compilePerformance({}));
    for (const action of Object.values(defaults.actions)) delete action.supported;
    return { actions: defaults.actions, expressions: defaults.expressions };
  }
}
