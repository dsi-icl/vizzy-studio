import type { ControllerEngine } from '~/lib/controllerEngine';
import type { ControllerStateCreator } from '~/lib/controllerStore';
import type { EditorEngine } from '~/lib/editorEngine';
import type { EditorStateCreator } from '~/lib/editorStore';
import type { GalleryEngine } from '~/lib/galleryEngine';
import type { GalleryStateCreator } from '~/lib/galleryStore';
import type { GSMessage, Layer, ScopeKey, ScopeState } from '~/lib/types';
import type { WallEngine } from '~/lib/wallEngine';
import type { YCrossws } from '~/server/yjs/yjs.session';

export {};

declare global {
    const __APP_COMMIT_SHA__: string;
    const __APP_BUILD_TIMESTAMP__: string;

    interface Window {
        __CONTROLLER_ENGINE__?: ControllerEngine;
        __EDITOR_ENGINE__?: EditorEngine;
        __WALL_ENGINE__?: WallEngine;
        __GALLERY_ENGINE__?: GalleryEngine;
        __CONTROLLER_RELOADING__?: boolean;
        __EDITOR_RELOADING__?: boolean;
        __WALL_RELOADING__?: boolean;
        __EDITOR_STORE__?: EditorStateCreator;
        __CONTROLLER_STORE__?: ControllerStateCreator;
        __GALLERY_STORE__?: GalleryStateCreator;
    }

    namespace NodeJS {
        interface Process {
            __SCOPED_STAGE_STATE__?: Map<ScopeKey, ScopeState>;
            __BROADCAST_EDITORS__?: (data: GSMessage) => void;
            __BROADCAST_ASSET_ADDED__?: (projectId: string, asset: Record<string, unknown>) => void;
            __BROADCAST_WALL_BINDING_CHANGED__?: (wallId: string) => void;
            __BROADCAST_PROJECTS_CHANGED__?: (projectId?: string) => void;
            __SIGNAGE_CONFIG_CHANGED__?: (slideshowId?: string) => void;
            __SIGNAGE_IS_TARGET_WALL__?: (wallId: string) => boolean;
            __SIGNAGE_IS_WALL_SUPPRESSED__?: (wallId: string) => boolean;
            __SIGNAGE_SUPPRESS_WALL__?: (wallId: string) => void;
            __SIGNAGE_RESUME_WALL__?: (wallId: string) => void;
            __BUS_RECOMPUTE_AUTH_CONTEXT__?: (payload: { email?: string }) => Promise<unknown>;
            __YJS_RECOMPUTE_AUTH_CONTEXT__?: (payload: { email?: string }) => Promise<unknown>;
            __DISCONNECT_DEVICE__?: (deviceId: string) => number;
            __REBOOT_WALL__?: (wallId: string, node?: { c: number; r: number }) => number;
            __REBOOT_DEVICE__?: (deviceId: string, publicKey?: string) => number;
            __YJS_UPSERT_LAYER__?: (payload: {
                projectId: string;
                commitId: string;
                slideId: string;
                layerId: number;
                textHtml: string;
                textRevision: number;
                textStateHash: string;
                textBindingVersion: string;
                fallbackLayer?: Extract<Layer, { type: 'text' }>;
            }) => boolean | Promise<boolean>;
            __YJS_SERVER__?: YCrossws;
            __VSYNC_INTERVAL__?: ReturnType<typeof setInterval>;
            __AUTO_SAVE_INTERVAL__?: ReturnType<typeof setInterval>;
            __REAPER_INTERVAL__?: ReturnType<typeof setInterval>;
            __MEDIA_WORKER_STARTED__?: boolean;
        }
    }
}
