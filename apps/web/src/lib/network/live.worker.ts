import { NetworkSchema } from './schema';
import { createNetworkSimulation } from './simulation';

let simulation: ReturnType<typeof createNetworkSimulation> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
self.onmessage = (event: MessageEvent<unknown>) => {
    try {
        const network = NetworkSchema.parse(event.data);
        if (simulation) simulation.configure(network);
        else simulation = createNetworkSimulation(network);
        // Acknowledge even a paused/cooled graph or a name-only change.
        self.postMessage({ view: simulation.view, documentKey: simulation.documentKey });
        if (!timer)
            timer = setInterval(() => {
                if (simulation?.advance(Date.now()))
                    self.postMessage({
                        view: simulation.view,
                        documentKey: simulation.documentKey
                    });
            }, 50);
    } catch {
        self.postMessage({ error: 'Could not run this network. Check the data and try again.' });
    }
};
