import {
    BugBeetleIcon,
    EyeIcon,
    EyeSlashIcon,
    FilmSlateIcon,
    ImageIcon,
    MapTrifoldIcon,
    TextTIcon,
    GraphIcon,
    ScribbleIcon,
    TrashIcon,
    RectangleIcon,
    ShapesIcon,
    CircleIcon,
    GlobeIcon,
    WaveSineIcon
} from '@phosphor-icons/react';
import { TipButton } from '@repo/ui/components/tip-button';
import React from 'react';

import { useEditorStore } from '~/lib/editorStore';
import { LayerWithEditorState } from '~/lib/types';

interface LayerItemProps {
    layer: LayerWithEditorState;
    isSelected: boolean;
}

export function LayerItem({ layer, isSelected }: LayerItemProps) {
    const removeLayer = useEditorStore((s) => s.removeLayer);
    const toggleLayerVisibility = useEditorStore((s) => s.toggleLayerVisibility);
    const isHidden = !layer.config.visible;

    const getLayerIcon = (type: LayerWithEditorState['type']): React.ReactNode => {
        switch (type) {
            case 'text':
                return <TextTIcon size={16} weight="bold" />;
            case 'image':
                return <ImageIcon size={16} weight="bold" />;
            case 'video':
                return <FilmSlateIcon size={16} weight="bold" />;
            case 'graph':
                return <GraphIcon size={16} weight="bold" />;
            case 'map':
                return <MapTrifoldIcon size={16} weight="bold" />;
            case 'web':
                return <GlobeIcon size={16} weight="bold" />;
            case 'shape': {
                switch ((layer as Extract<LayerWithEditorState, { type: 'shape' }>).shape) {
                    case 'circle':
                        return <CircleIcon size={16} weight="bold" />;
                    case 'rectangle':
                        return <RectangleIcon size={16} weight="bold" />;
                    default:
                        return <ShapesIcon size={16} weight="bold" />;
                }
            }
            case 'line':
                return <ScribbleIcon size={16} weight="bold" />;
            case 'background':
                return <WaveSineIcon size={16} weight="bold" />;
            default:
                return <BugBeetleIcon size={16} weight="bold" />;
        }
    };

    const getLayerName = (layer: LayerWithEditorState): string => {
        switch (layer.type) {
            case 'text':
                return layer.textHtml.replace(/<[^>]*>/g, '').slice(0, 40) || 'Text';
            case 'image':
                return layer.name || 'Image';
            case 'video':
                return layer.name || 'Video';
            case 'graph':
                return 'Graph';
            case 'map':
                return 'Map';
            case 'web':
                return (layer as Extract<LayerWithEditorState, { type: 'web' }>).url;
            case 'shape': {
                switch ((layer as Extract<LayerWithEditorState, { type: 'shape' }>).shape) {
                    case 'circle':
                        return 'Circle';
                    case 'rectangle':
                        return 'Rectangle';
                    default:
                        return 'Shape';
                }
            }
            case 'line':
                return 'Line';
            case 'background':
                return 'Background';
            default:
                return 'Unknown Layer';
        }
    };

    return (
        <div
            className={`group flex items-center rounded-md border px-2 py-1 transition-colors ${
                isSelected
                    ? 'border-ring bg-accent text-accent-foreground'
                    : 'border-transparent bg-card hover:border-border hover:bg-muted'
            } ${isHidden ? 'opacity-50' : ''}`}
        >
            <div className="mr-1.5 text-muted-foreground">{getLayerIcon(layer.type)}</div>
            <div className="flex-1 truncate text-sm font-medium">
                <span>{getLayerName(layer)}</span>
            </div>
            <div className="flex items-center gap-1">
                <TipButton
                    tip={isHidden ? 'Show layer' : 'Hide layer'}
                    variant="ghost"
                    onClick={() => toggleLayerVisibility(layer.numericId)}
                    className="opacity-0 group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100"
                >
                    {isHidden ? <EyeSlashIcon /> : <EyeIcon />}
                </TipButton>
                <TipButton
                    tip="Delete layer"
                    variant="destructive"
                    onClick={() => removeLayer(layer.numericId)}
                    className="opacity-0 group-hover:opacity-100 touch-only:opacity-100 last-touch:opacity-100"
                >
                    <TrashIcon />
                </TipButton>
            </div>
        </div>
    );
}
