import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    type FaviconSettings,
    generateFaviconFiles,
    generateFaviconHtml,
    IconTransformationType,
    type MasterIcon
} from '@realfavicongenerator/generate-favicon';
import { getNodeImageAdapter, loadAndConvertToSvg } from '@realfavicongenerator/image-adapter-node';
import { create } from 'xmlbuilder2';

// const {} = genFav;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parentDir = path.resolve(__dirname, '..');
const imageAdapter = await getNodeImageAdapter();

// This is the icon that will be transformed into the various favicon files
const masterIcon: MasterIcon = {
    icon: await loadAndConvertToSvg(`${parentDir}/src/assets/logo.svg`)
};

type DeepPartial<T> = T extends object
    ? {
          [P in keyof T]?: DeepPartial<T[P]>;
      }
    : T;

const faviconSettings: DeepPartial<FaviconSettings> = {
    icon: {
        desktop: {
            regularIconTransformation: {
                type: IconTransformationType.None
            },
            darkIconType: 'regular',
            darkIconTransformation: {
                type: IconTransformationType.Brightness,
                brightness: 1.3
            }
        },
        touch: {
            transformation: {
                type: IconTransformationType.Background,
                backgroundColor: '#ffffff',
                backgroundRadius: 0,
                imageScale: 0.6
            },
            appTitle: 'Vizzy Studio'
        },
        webAppManifest: {
            transformation: {
                type: IconTransformationType.Background,
                backgroundColor: '#ffffff',
                backgroundRadius: 0,
                imageScale: 0.7
            },
            backgroundColor: '#ffffff',
            themeColor: '#ffffff',
            name: 'Vizzy Studio Blackboard',
            shortName: 'Vizzy Studio'
        }
    },
    path: '/'
};

const files = Object.entries(
    await generateFaviconFiles(
        masterIcon,
        faviconSettings as unknown as FaviconSettings,
        imageAdapter
    )
);
for (const [name, content] of files) {
    if (typeof content === 'string')
        fs.writeFileSync(`${parentDir}/public/${name}`, content, { flag: 'w' });
    else if (content instanceof Uint8Array)
        fs.writeFileSync(`${parentDir}/public/${name}`, content, { flag: 'w' });
    else if (content instanceof ArrayBuffer)
        fs.writeFileSync(`${parentDir}/public/${name}`, Buffer.from(content), { flag: 'w' });
    else if (content instanceof Blob)
        fs.writeFileSync(`${parentDir}/public/${name}`, Buffer.from(await content.arrayBuffer()), {
            flag: 'w'
        });
    else throw new Error('Unknown content type');
}

const html = generateFaviconHtml(faviconSettings as unknown as FaviconSettings);
const extraHead: { links: Record<string, string>[]; meta: Record<string, string>[] } = {
    links: [],
    meta: []
};
const markups = html.markups.map((m) => create(m).end({ format: 'object' }) as unknown);
for (const _markup of markups) {
    if (typeof _markup !== 'object' || _markup === null) continue;
    const markup = _markup as { [key: string]: Record<string, string> };
    if (markup.link) {
        extraHead.links.push(
            Object.fromEntries(Object.entries(markup.link).map(([k, v]) => [k.replace('@', ''), v]))
        );
    }
    if (Object.hasOwn(markup, 'meta')) {
        extraHead.meta.push(
            Object.fromEntries(Object.entries(markup.meta).map(([k, v]) => [k.replace('@', ''), v]))
        );
    }
}
fs.writeFileSync(`${parentDir}/src/assets/extraHead.json`, JSON.stringify(extraHead, null, 4), {
    flag: 'w'
});
