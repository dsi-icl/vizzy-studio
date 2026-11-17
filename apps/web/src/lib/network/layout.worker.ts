import { layoutNetwork } from './layout';
import {
    NetworkDataSchema,
    NetworkSettingsSchema,
    type NetworkData,
    type NetworkSettings
} from './schema';

self.onmessage = (event: MessageEvent<{ data: NetworkData; settings: NetworkSettings }>) => {
    try {
        const data = NetworkDataSchema.parse(event.data.data);
        const settings = NetworkSettingsSchema.parse(event.data.settings);
        self.postMessage({ positions: layoutNetwork(data, settings) });
    } catch {
        self.postMessage({
            error: 'Could not calculate this layout. Check the data and try again.'
        });
    }
};
