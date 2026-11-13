import { coalesceInFlight } from '~/lib/coalesceInFlight';

import { getProject } from './projects';

/** Share only concurrent reads; later requests still see project edits immediately. */
export const getServeProject = coalesceInFlight(getProject);
